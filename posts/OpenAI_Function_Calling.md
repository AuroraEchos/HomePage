---
date: 2026-06-01
category: agent
title: OpenAI Function Calling：协议与执行循环
---

# OpenAI Function Calling：协议与执行循环

Function calling（也称 tool calling）让模型向应用请求外部能力。对于自定义 function tool，模型返回工具名和参数；真正的函数执行、权限判断和副作用控制仍由应用负责。工具执行结果随后交回模型，模型可以生成最终回答或继续请求工具。

这里要区分两类工具：

- **自定义 function tool**：由应用声明 JSON Schema，并在自己的代码或基础设施中执行。
- **平台托管工具**：例如部分模型在 Responses API 中可用的 web search、file search 等，由 OpenAI 平台按对应协议执行。

本文重点讨论第一类。

## Responses API 与 Chat Completions

两套 API 都支持 function calling，但协议形态不同：

| 环节 | Responses API | Chat Completions |
|---|---|---|
| 请求主体 | `input` 与 output items | `messages` |
| 工具定义 | `{type, name, parameters, strict}` | `{type, function: {name, parameters, strict}}` |
| 模型调用 | `output` 中的 `function_call` item | assistant message 中的 `tool_calls` |
| 调用关联 | `call_id` | `tool_calls[].id` / `tool_call_id` |
| 工具结果 | `function_call_output` item | `role: "tool"` message |

OpenAI 当前建议在推理、工具调用和多轮工作流中优先使用 Responses API；已有 Chat Completions 集成仍可以继续使用。

## 完整执行循环

无论使用哪套 API，核心流程都相同：

1. 应用向模型提供输入与可用工具。
2. 模型返回零个、一个或多个 function call。
3. 应用验证工具名、参数、权限和业务约束。
4. 应用执行工具，把每个结果与对应 call ID 一起回传。
5. 模型生成最终回答，或者继续请求工具。

模型可能在一轮中并行请求多个函数，因此实现时不要只处理数组中的第一个调用。

## Responses API 示例

Responses API 的 function tool 定义是扁平结构：

```python
import json
from openai import OpenAI

client = OpenAI()
MODEL_ID = "gpt-5.6-terra"

tools = [
    {
        "type": "function",
        "name": "get_weather",
        "description": "Get current weather for a city.",
        "parameters": {
            "type": "object",
            "properties": {
                "location": {
                    "type": "string",
                    "description": "City and country, for example Paris, France",
                },
                "unit": {
                    "type": "string",
                    "enum": ["celsius", "fahrenheit"],
                },
            },
            "required": ["location", "unit"],
            "additionalProperties": False,
        },
        "strict": True,
    }
]
```

发送第一轮请求：

```python
input_items = [
    {"role": "user", "content": "What's the weather in Paris?"}
]

response = client.responses.create(
    model=MODEL_ID,
    input=input_items,
    tools=tools,
)
```

模型请求函数时，`response.output` 中会出现类似 item：

```json
{
  "type": "function_call",
  "call_id": "call_abc123",
  "name": "get_weather",
  "arguments": "{\"location\":\"Paris, France\",\"unit\":\"celsius\"}"
}
```

`arguments` 是 JSON 编码的字符串，需要解析。把模型的 output items 与工具结果一起放回下一轮输入：

```python
def get_weather(location: str, unit: str) -> dict:
    return {"location": location, "temperature": 25, "unit": unit}


input_items.extend(response.output)

for item in response.output:
    if item.type != "function_call":
        continue

    if item.name != "get_weather":
        raise ValueError(f"Unknown tool: {item.name}")

    arguments = json.loads(item.arguments)
    result = get_weather(**arguments)
    input_items.append(
        {
            "type": "function_call_output",
            "call_id": item.call_id,
            "output": json.dumps(result, ensure_ascii=False),
        }
    )

response = client.responses.create(
    model=MODEL_ID,
    input=input_items,
    tools=tools,
)

print(response.output_text)
```

`call_id` 必须原样对应；它让模型知道某个结果属于哪个 function call。

## Chat Completions 对照

Chat Completions 的工具定义包在 `function` 字段中：

```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "Get current weather for a city.",
    "parameters": {
      "type": "object",
      "properties": {
        "location": {"type": "string"},
        "unit": {
          "type": "string",
          "enum": ["celsius", "fahrenheit"]
        }
      },
      "required": ["location", "unit"],
      "additionalProperties": false
    },
    "strict": true
  }
}
```

模型可能返回：

```json
{
  "role": "assistant",
  "tool_calls": [
    {
      "id": "call_abc123",
      "type": "function",
      "function": {
        "name": "get_weather",
        "arguments": "{\"location\":\"Paris, France\",\"unit\":\"celsius\"}"
      }
    }
  ]
}
```

应用需要先把完整的 assistant message 追加到 `messages`，再为每个调用追加一条工具消息：

```json
{
  "role": "tool",
  "tool_call_id": "call_abc123",
  "content": "{\"location\":\"Paris, France\",\"temperature\":25,\"unit\":\"celsius\"}"
}
```

`function.arguments` 同样是 JSON 字符串。工具调用时 `finish_reason` 通常为 `tool_calls`，但循环实现应直接检查 `message.tool_calls`，不要只依赖停止原因或假设 `content` 一定是 `null`。

## Strict mode

OpenAI 官方建议启用 `strict: true`。严格模式要求：

1. 每个 object schema 都设置 `additionalProperties: false`；
2. `properties` 中的字段全部列入 `required`；
3. 逻辑上的可选字段用包含 `null` 的类型表示，例如 `"type": ["string", "null"]`。

当前默认行为也有区别：

- Chat Completions 未显式启用时仍是 non-strict、best-effort。
- Responses API 会在可能时尝试把 schema 规范化为 strict；若无法兼容会回退，并在返回的工具定义状态中体现 `strict: false`。需要确定行为时仍应显式写 `strict: true`。

Strict mode 约束的是输出结构，不负责业务语义和授权。例如合法 schema 仍可能包含不存在的城市、越权账号或危险路径，所以执行前仍需验证：

- 工具名是否在 allowlist；
- 参数是否满足业务规则；
- 当前用户是否有权限；
- 操作是否需要确认、幂等键或审计；
- URL、文件路径、SQL 和 shell 输入是否受到安全限制。

## Tool choice 与并行调用

`tool_choice` 可以控制模型是否使用工具：

- `auto`：零个、一个或多个；
- `required`：至少调用一个；
- `none`：不调用；
- 指定 function：强制调用某个工具；
- allowed tools：把本轮可调用范围限制在工具子集。

支持的模型可以在一轮中返回多个 function call。`parallel_tool_calls: false` 可把一轮限制为零个或一个调用。即便允许并行，应用也必须考虑依赖关系：两个只读查询可以并发，涉及余额、库存或文件写入的调用未必可以。

## 一个更稳健的循环

```python
MAX_TOOL_ROUNDS = 5

for _ in range(MAX_TOOL_ROUNDS):
    response = client.responses.create(
        model=MODEL_ID,
        input=input_items,
        tools=tools,
    )
    input_items.extend(response.output)

    calls = [item for item in response.output if item.type == "function_call"]
    if not calls:
        print(response.output_text)
        break

    for call in calls:
        try:
            arguments = json.loads(call.arguments)
            result = dispatch_allowed_tool(call.name, arguments)
            output = {"ok": True, "result": result}
        except Exception:
            # 完整异常只写服务端日志；返回给模型的是稳定、已清洗的错误。
            output = {"ok": False, "error": "tool_execution_failed"}

        input_items.append(
            {
                "type": "function_call_output",
                "call_id": call.call_id,
                "output": json.dumps(output, ensure_ascii=False),
            }
        )
else:
    raise RuntimeError("Tool calling exceeded max rounds")
```

真实系统还应加入总超时、重试预算、取消、工具级超时、速率限制、可观测性和人工确认。不能把“模型停止调用工具”直接等同于“业务任务已经正确完成”；高风险任务需要外部验证。

## 模型实际看到什么

开发者能观察到三层中的两层：

1. 应用发送的 API JSON；
2. OpenAI 服务端使用的内部序列化形式；
3. API 返回的 JSON / SDK 对象。

第 2 层不是公开协议，不应根据猜测编写解析逻辑。官方文档说明，function definitions 会以模型训练过的语法注入上下文，因此会占用上下文窗口并按输入 token 计费。工具很多或 schema 很大时，应缩短描述、按需加载工具，或在受支持模型上使用 tool search。

## 核心结论

- 模型提出 function call；应用决定是否以及如何执行。
- Responses 使用 `function_call` / `function_call_output` items；Chat Completions 使用 `tool_calls` / `role: tool` messages。
- 参数是 JSON 字符串，需要解析；strict mode 不能代替业务验证和权限检查。
- 一轮可能有多个调用，结果必须逐一通过 call ID 对应。
- 循环必须有最大轮数、超时、错误处理与外部成功判定。

参考：OpenAI 官方文档 [Function calling](https://developers.openai.com/api/docs/guides/function-calling)。
