---
date: 2026-09-11
category: agent
title: 一种面向 Agent 的可分支 Session 设计
---


# 一种面向 Agent 的可分支 Session 设计

> **核心观点：**  
> 对具备工具调用、长期运行与上下文压缩能力的 Agent 来说，Session 不应该只是一条线性的聊天记录。  
> 更合理的模型，是一棵可持久化、可分支、可恢复的历史树。

---

## 1. 为什么线性聊天记录不够了

传统对话系统通常把历史表示为：

```text
User
  ↓
Assistant
  ↓
User
  ↓
Assistant
```

也就是一个不断向后追加的 `messages[]`。

这种设计对普通聊天足够，但一旦 Agent 开始：调用工具；修改文件；执行 Shell；访问外部系统；中途取消；压缩上下文；从历史节点重新探索另一种方案等，线性历史就会暴露出一个根本问题：

> **一次过去，可能对应多个未来。**

假设某个 Agent 已经经历：

```text
A → B → C → D
```

用户发现 `C → D` 这条路线并不好，希望回到 `B`，尝试另一种思路。在线性模型里，通常只有两种选择：

```text
删除 C、D
```

或者：

```text
复制整个会话，创建一个新的 Session
```

前者丢失历史，后者制造重复。

更自然的模型其实是：

```text
        C → D
       /
A → B
       \
        E → F
```

过去仍然存在，只是从同一个历史节点长出了不同的未来。

这就是 **可分支 Session** 的基本思想。

---

# 2. Session 应该是一棵历史树

可以把一次 Agent 会话建模为一棵树。

每个节点只需要三个核心信息：

```text
id
parent
payload
```

其中：

- `id`：当前节点唯一标识；
- `parent`：前一个历史节点；
- `payload`：本节点代表的消息、状态或 checkpoint。

例如：

```text
                   root
                    │
                    ▼
                    A
                    │
                    ▼
                    B
                   / \
                  /   \
                 ▼     ▼
                 C     D
                 │
                 ▼
                 E
```

只要每个节点知道自己的 `parent`，就可以从任意叶节点一路向上回溯：

```text
leaf → parent → parent → ... → root
```

然后反转，就得到当前分支完整历史。

因此，Session 不再是：

```text
一个 messages 数组
```

而是：

```text
一棵完整历史树
+
一个指向当前节点的 cursor
```

---

# 3. 当前上下文由 Leaf 决定

一棵 Session Tree 中可以同时存在很多分支，但 Agent 每一时刻只需要看到其中一条路径。

因此可以维护一个：

```text
leaf
```

表示当前活动节点。

如果：

```text
leaf = E
```

那么当前分支是：

```text
A → B → C → E
```

如果用户切换到 `D`：

```text
leaf = D
```

当前分支就变成：

```text
A → B → D
```

这意味着：

> **切换分支，本质上只是移动 cursor，而不是修改历史。**

这个思想非常接近版本控制系统中的 `HEAD`。

历史结构保持不变，改变的只是：

```text
“从哪一个节点继续向前”
```

---

# 4. Branch 不是 Rollback

这是整个设计中最重要的边界之一。

如果 Agent 曾经执行：

```bash
echo hello > result.txt
```

然后用户回到之前的某个 Session 节点。

此时可以回退的是：

```text
Conversation State
```

但磁盘上的：

```text
result.txt
```

依然存在。

因此必须明确：

```text
Conversation State ≠ World State
```

Session 分支改变的是：

```text
Agent 接下来看到什么
```

而不是：

```text
真实世界恢复到了过去
```

如果一个 Agent 已经：

- 写入文件；
- 执行命令；
- 发出网络请求；
- 修改数据库；
- 创建 Git commit；

这些副作用不会因为切换 Session 分支自动消失。

如果确实需要外部状态回滚，应由独立机制完成，例如：

```text
Git
filesystem snapshot
container
transaction
sandbox
VM
```

而不是让会话系统假装拥有这种能力。

---

# 5. 历史应该 Append-only

如果已经发生过的历史可以被原地修改，那么 Session 很快会变得难以解释：

- 一个节点曾经是什么？
- 某次工具调用是否真的执行过？
- 一个分支是从哪里产生的？
- 为什么恢复出来的上下文与之前不同？

因此更稳妥的策略是：

> **历史只追加，不修改。**

也就是 append-only。

例如：

```text
A
B
C
```

用户回到 `B` 时，不删除 `C`，而是追加一条“cursor 切换”记录：

```text
A
B
C
cursor(B)
```

然后继续产生：

```text
D(parent=B)
```

最终逻辑结构：

```text
        C
       /
A → B
       \
        D
```

这种方式带来几个直接好处：

### 可解释

每个历史状态都可以追溯。

### 可恢复

内存状态可以通过 replay 重建。

### 可调试

Session 文件本身就是执行轨迹。

### 可审计

过去不会在用户不知情的情况下被静默改写。

---

# 6. History 不等于 Context

另一个容易混淆的概念是：

```text
Session History
```

和：

```text
Model Context
```

它们不是同一个东西。

Session History 关心：

> **发生过什么。**

Model Context 关心：

> **下一次模型调用应该看到什么。**

完整历史中可能包含：

- 内部 note；
- 调试信息；
- 中断的 assistant 输出；
- 不完整 tool batch；
- 很久以前已经总结过的消息；
- 只用于审计、不适合再次送给模型的数据。

因此更合理的流程是：

```text
Persistent History
       │
       ▼
Active Branch
       │
       ▼
Context Projection
       │
       ▼
Model Context
```

也就是说：

> **History 是事实层，Context 是视图层。**

这和数据库中的“原始数据”与“查询视图”很相似。

---

# 7. Projection 应该是显式步骤

不要让“哪些消息送给模型”隐藏在 Session 存储逻辑里。

可以单独定义一层：

```text
project(history) → context
```

它负责：

- 丢弃内部 note；
- 保证 tool call / tool result 配对；
- 过滤无效消息；
- 将内部 summary 转换为模型可理解的上下文；
- 处理模型协议差异。

这样做的好处是：

Session Store 保持纯粹：

```text
保存历史
```

Context Layer 保持纯粹：

```text
决定模型看到什么
```

两者可以独立演进。

---

# 8. Compaction 不应该删除历史

长期运行的 Agent 最终一定会遇到上下文窗口限制。

一种粗暴方案是：

```text
删除旧消息
```

但这样会失去可恢复性。

更好的方式是：

```text
summary + checkpoint
```

例如原始历史：

```text
A → B → C → D → E
```

压缩后新增：

```text
A → B → C → D → E → K
```

其中 `K` 是一个 checkpoint：

```text
K = Summary(A-D) + E
```

以后从 `K` 继续：

```text
K → F → G
```

模型需要恢复上下文时，可以直接使用：

```text
Summary(A-D)
E
F
G
```

而原始：

```text
A B C D
```

仍然保留在完整历史中。

因此：

> **Compaction 改变的是历史的表示方式，而不是历史本身。**

这使两个看似冲突的目标可以同时成立：

```text
完整历史保留
+
模型上下文保持有限
```

---

# 9. Tool Call 必须被视为有副作用的事件

对于普通聊天系统来说，中断通常只是：

```text
少了一段回复
```

但对于 Agent 来说，中断可能发生在：

```text
assistant
  ↓
tool_call
  ↓
真实工具执行
```

例如：

```bash
git commit
curl ...
rm ...
python train.py
```

如果 Session 恢复时发现：

```text
有 tool_call
没有 tool_result
```

一个危险的做法是：

```text
自动重新执行工具
```

因为这个工具可能已经执行过，只是结果没有成功写入历史。

因此更安全的原则是：

> **中断的工具调用只能被标记为 interrupted，不能自动 replay。**

例如补一个逻辑结果：

```text
Interrupted.
Side effects may have occurred.
Inspect current state before retrying.
```

这样既可以修复消息协议：

```text
tool_call → tool_result
```

又不会制造重复副作用。

---

# 10. Session 的本质更接近 Event Log

这种设计可以理解为一种轻量级 Event Sourcing：

```text
file / database
      │
      │ replay
      ▼
in-memory session state
```

持久化层记录：

```text
发生了哪些事件
```

内存状态则通过 replay 得到：

```text
entries
current leaf
active branch
```

因此：

> **持久化记录是 source of truth，内存只是它的一个投影。**

这也是 append-only 设计的另一个价值。

---

# 11. 为什么树结构特别适合 Agent

Agent 天然具有探索性质。

它经常面对：

```text
方案 A
方案 B
方案 C
```

甚至模型本身就在不断做：

```text
observe
reason
act
observe
reason
act
```

如果 Session 永远是一条线，会默认一种错误假设：

> 历史只有唯一的未来。

而真正的 Agent 工作流更接近：

```text
                         ┌─ Approach A
                         │
Goal → Investigation ────┼─ Approach B
                         │
                         └─ Approach C
```

所以树结构不是为了炫技，而是在数据结构层面承认：

> **Agent 的执行过程本身就是可探索、可岔开的。**

---

# 12. 一个合理的职责边界

如果把整个 Agent Runtime 分层，可以得到：

```text
┌─────────────────────────────┐
│        Interface / UI       │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│       Application Layer     │
│   session / runtime wiring  │
└──────────────┬──────────────┘
               │
        ┌──────┴──────┐
        ▼             ▼
┌────────────┐   ┌──────────────┐
│ Agent Core │   │ Session Store│
└─────┬──────┘   └──────────────┘
      │
      ▼
┌──────────────┐
│ Context Layer│
└─────┬────────┘
      │
      ▼
┌──────────────┐
│ Provider/LLM │
└──────────────┘
```

其中：

### Agent Core

负责：

```text
模型 / 工具循环
消息状态
任务执行
```

### Session Store

负责：

```text
历史树
持久化
branch
checkpoint
```

### Context Layer

负责：

```text
history → model context
```

### Application Layer

负责：

```text
同步 Agent 内存状态与 Session
```

这种分层最大的价值是：

> **核心 Agent 不需要知道历史到底存成 JSONL、SQLite 还是远程数据库。**

同样：

> **Session Store 也不需要知道模型是 OpenAI、Anthropic 还是本地模型。**

---

# 13. 设计原则

可以把这种 Session 设计浓缩为八条原则。

## 1. History is persistent

已经发生的历史默认保留。

## 2. History is a tree

一次过去可以产生多个未来。

## 3. The active context is a path

模型每次只需要当前 leaf 对应的一条分支。

## 4. Branching is not rollback

切换对话分支不意味着真实世界回滚。

## 5. History is not context

完整历史和模型输入是两个不同层次。

## 6. Compaction is not deletion

上下文压缩应该产生新的表示，而不是销毁旧历史。

## 7. Tool side effects must never be replayed implicitly

工具副作用必须保守处理。

## 8. Persistence should remain boring

会话存储应该尽量简单、透明、可恢复，而不是变成另一个复杂框架。

---

# 14. 一种更抽象的理解

最终，这套设计真正解决的不是“如何保存聊天记录”。

它解决的是：

> **如何保存一个 Agent 曾经探索过的全部执行轨迹，同时允许它从过去的任意状态继续产生新的未来。**

所以更准确地说，它保存的是：

```text
Agent Trajectory History
```

而不是：

```text
Chat History
```

可以把完整模型写成：

```text
                     Persistent History
                            │
                            ▼
                       Session Tree
                            │
                       current leaf
                            │
                            ▼
                       Active Path
                            │
                     context projection
                            │
                            ▼
                       Model Context
                            │
                            ▼
                         Agent
                            │
                            ▼
                       Tool / World
```

其中最关键的一条边界始终是：

```text
Conversation State ≠ World State
```

---

# 15. 结语

当 Agent 只会聊天时，线性 history 足够。

当 Agent 开始：

- 操作真实环境；
- 长期运行；
- 调用工具；
- 压缩上下文；
- 回到历史节点重新探索；

Session 就不再只是一个消息列表。

它开始承担一种更接近“版本历史”的职责。

因此，一个值得长期演进的 Agent Session 可以采用这样一种模型：

> **历史保持完整，上下文按需投影；过去可以产生多个未来，而真实世界的副作用永远独立于对话分支。**

这可能比“如何保存 messages”更接近 Agent Session 真正应该解决的问题。
