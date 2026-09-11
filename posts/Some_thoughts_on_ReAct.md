---
date: 2026-05-21
category: agent
title: ReAct：推理—行动循环与错误恢复
---

# ReAct：推理—行动循环与错误恢复

在谈论 ReAct 之前，我们需要先对 Agent 这一概念进行一个叙述。毫无疑问，Agent 是大模型落地的主线之一，可以按照下面四个阶段来理解。

1. Chatbot 阶段

   早期的 LLM 落地主要是：用户提出问题，然后模型回答。它的价值在知识问答、写作、总结和翻译，但单次模型调用本身不会自动操作业务系统。

2. Copilot 阶段

   然后进入 Copilot，这个阶段的任务是：人负责目标和判断，模型负责生成、补全和建议。比如一些代码助手、文档助手、客服助手等，这个阶段已经很实用，但本质还是“辅助生成”。

3. Agent 阶段

   Agent 的核心变化是：LLM + 工具调用 + 状态管理 + 多步执行。例如，用户要求分析数据库里上个月的销售异常，Agent 可以在权限允许的范围内检索 schema、生成并执行只读 SQL、处理错误、分析结果并生成报告。OpenAI 的 [Responses API](https://developers.openai.com/api/docs/guides/function-calling) 支持函数工具及多轮工具调用；MCP 则为模型应用连接外部工具和数据提供开放协议。

4. Workflow Agent 阶段

   真正有商业价值的 Agent，不是什么都能做的通用 Agent，而是：

   > 垂直场景 + 受控工具 + 明确权限 + 可观测执行

   企业现在的问题不是“有没有 Agent 概念”，而是从 pilot 走向 scale 很难。agentic AI 正在扩散，但多数组织仍卡在规模化落地阶段。

我认为未来的形态是这样的：
```
大模型本身
↓
工具调用能力
↓
Agent Runtime
↓
MCP / API / 数据库 / 浏览器 / 文件系统
↓
业务工作流
↓
权限、审计、评估、监控
```

也就是说，模型能力之外，系统能否安全、稳定、可控地进入真实业务同样会成为关键竞争点。

以上是我对 Agent 的一些思考，我认为理解了上述的一些内容能够有助于理解下面我们要讨论的 ReAct。

在 Agent 领域里，ReAct 是一个非常核心，也非常现代化的思想。该思想最早来自于 ICLR 2023 的一篇论文，全名为 “ReAct: Synergizing Reasoning and Acting in Language Models”，由  Shunyu Yao  等人提出。它展示了一种将推理（Reasoning）与行动（Acting）交织在一起的通用提示范式，被广泛视为后续各类 LLM  智能体（agents）方法的重要基础之一。

ReAct 的名字正是来自于：Reasoning 与 Acting。也就是：

- 模型不仅能够思考
- 还能够行动
- 并且：
  - 根据行动结果继续思考
  - 再继续行动
  - 最终完成任务

这是一种：“LLM + Tool + Iterative Reasoning” 的范式。

这种“推理—行动—观察”循环与许多后续 Agent 系统有相似结构，例如：

- LangChain Agent
- OpenAI function calling agent
- AutoGPT
- BabyAGI
- Devin 类系统
- Cursor / Windsurf 类 coding agent
- 大部分 MCP Agent
- 多数现代 Tool Agent

不过，不能据此断言这些系统都直接继承自 ReAct；许多系统也来自规划、控制、软件工作流和强化学习等路线。

## 一、为什么会出现 ReAct？

先理解普通 LLM 的问题，传统的 ChatGPT 式模型都是用户输入问题，然后模型一次性生成答案，接着结束。

单次、无工具的基础模型调用没有外部持久状态，也不能自行执行环境动作。工具调用、验证、重试和规划来自模型能力与应用运行时的共同设计。ReAct 提供了一种把推理与环境反馈交错起来的提示和交互范式。

## 二、经典的 ReAct 流程

ReAct 认为：

> 模型应该像人一样：
>
> 一边思考，
>  一边行动，
>  再根据环境反馈继续思考。

经典 ReAct 论文常用类似下面的显式轨迹：

```
Question:
用户问题

Thought:
我应该先做什么？

Action:
调用哪个工具？

Observation:
工具返回什么？

Thought:
下一步怎么办？

Action:
继续调用工具

Observation:
新的结果

Thought:
我已经得到答案

Final Answer:
最终输出
```

我们可以举出一个简单却真实的例子，比如：用户询问今天上海的天气怎么样？适合跑步吗？

1. 第一步是 Reason 过程，模型判断需要查询上海的天气。

2. 第二步是 Act ，模型发现我可以使用一些定义好的工具函数：weather_api("shanghai")。

3. 第三步是 Observation，模型这时候会得到 API 的返回结果，例如：

   ```
   {
     "temp": 18,
     "humidity": 35,
     "air_quality": "good"
   }
   ```

4. 第四步仍然是 Reason 过程，模型此时会根据 API 的返回结果思考：天气凉爽，空气质量不错，适合跑步。

5. 第五步是 Final Answer：上海今天 18℃，空气质量良好；是否适合跑步还应结合降水、风力、体感温度和个人健康情况。

生产系统不必、也不应默认把模型的私有 Chain-of-Thought 原样展示或保存。可以使用结构化 tool call、简短理由、状态字段和可审计的工具结果实现同样的控制循环。

## 三、ReAct 和 Chain-of-Thought 的区别

CoT 关注生成中间推理步骤；ReAct 在此基础上把环境动作与观察交错进轨迹。二者不是互斥的系统类型：实际 Agent 可以使用隐藏推理、简短计划或完全结构化的控制策略。

## 四、ReAct 的关键难点

1. Tool Calling

   如何去定义工具、参数结构化、执行、返回。

2. Context 管理

   多轮 Action/Observation 会持续消耗上下文，但这只是 Agent 的重要问题之一。系统可使用摘要、检索记忆、结构化状态、轨迹裁剪与服务端会话状态控制长度。

3. 错误修复

   比如：API失败、tool timeout、hallucination，这些都是需要解决的。

## 五、现代 Agent 基本结构

现在主流 Agent 大致都是：

```
User Input
    ↓
Planner / Reasoner
    ↓
Tool Selection
    ↓
Tool Execution
    ↓
Observation
    ↓
Memory Update
    ↓
Next Step Reasoning
```

ReAct 是它们的思想起点。

## 六、总结

大语言模型（LLMs）是一项伟大且强大的新技术。当 LLM 与外部数据源结合时，会变得更强大。LLM 将重塑未来应用程序的形态。具体而言，未来的应用将越来越呈现 Agent 化。我们仍处于这一变革的早期阶段。虽然构建这类 Agent 化应用的原型很容易，但要构建**足够可靠、可用于生产环境的 Agent**仍然非常困难。

ReAct 于 2022 年发布预印本，后发表于 ICLR 2023。它是理解工具型 Agent 循环的重要起点，但生产系统还必须补上权限、安全边界、幂等性、超时、恢复、可观测性和评估。

参考：[ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629)。

我们将在接下来的笔记中详细介绍 LangChain。
