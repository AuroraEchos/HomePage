---
id: kv-cache
date: 2026-05-20
category: llm
title: KV Cache：原理与推理加速
---

# KV Cache：原理与推理加速

## 什么是 KV Cache

KV Cache（Key-Value Cache）是大语言模型（LLM）推理阶段的一种核心加速技术。

它的作用是：

> 避免模型在生成文本时，重复计算历史 token 的 Attention Key 和 Value。

KV Cache 主要服务于自回归推理。标准的整段并行训练通常不会使用这种逐 token 缓存；某些分块训练、流式模型或前缀复用方案是例外。

---

## Transformer 自回归生成的问题

现代大语言模型（如 GPT、LLaMA、Qwen）通常采用 Decoder-Only Transformer 架构，并使用自回归（Autoregressive）方式逐 token 生成文本。

生成过程如下：

```text
给定历史 token
→ 预测下一个 token
→ 将新 token 拼接回输入
→ 继续生成
```

标准贪心、采样和 beam search 解码通常每个序列每步生成一个新 token；推测解码等方法可以在一次验证中接受多个 token。

---

## 没有 KV Cache 时的问题

假设用户输入长度为 1024 个 token。

---

### 第 1 步生成

输入：

```text
[x1, x2, ..., x1024]
```

模型经过完整 Transformer 前向计算后：

```text
预测：
x1025
```

例如：

```text
x1025 = “因”
```

---

### 第 2 步生成

现在模型输入变为：

```text
[x1, x2, ..., x1024, x1025]
```

模型需要再次执行完整前向传播：

- Embedding
- Q/K/V Projection
- Attention
- MLP
- LayerNorm

并重新计算：

```text
x1 ~ x1025
所有 token
```

最终得到：

```text
x1026 = “为”
```

---

### 第 3 步生成

输入继续增长：

```text
[x1, x2, ..., x1026]
```

模型又会重新计算：

```text
x1 ~ x1026
所有 token
```

然后生成：

```text
x1027 = “它”
```

---

### 核心问题：重复计算

请注意：

在第 2 步中：

```text
x1 ~ x1024
和第 1 步完全相同
```

但模型仍然会：

- 重新计算所有层
- 重新计算所有 Attention
- 重新计算所有 K/V

在推理模式下，只要历史 token、位置编码和注意力可见范围不变，这些历史 K/V 与上一轮一致，因而可以复用。

---

### 为什么这是灾难性的

如果模型连续生成：

```text
500 个 token
```

那么：

前面的历史 token 会被反复重新计算数百次。

仅看每轮重复处理的 token 数，会呈等差数列增长：

```text
1024
1025
1026
...
1524
```

更精确地说，无缓存时每一步都对长度为 $t$ 的序列做完整前向，投影和 MLP 被重复计算，朴素注意力还会重复构造 $t\times t$ 分数矩阵；使用缓存后，每层只为新 token 计算 Q/K/V，但当前 Q 仍需读取并关注长度为 $t$ 的历史 K/V。

这会导致：

- 推理速度极慢
- GPU 计算资源大量浪费
- 长文本生成性能急剧下降

---

## Attention 中的 K 和 V

Transformer Attention 公式：

$$
\text{Attention}(Q,K,V)
=
\text{softmax}
\left(
\frac{QK^T}{\sqrt{d}}
\right)V
$$

其中：

- Q（Query）：当前 token 的查询向量
- K（Key）：历史 token 的索引向量
- V（Value）：历史 token 的内容向量

在自回归生成过程中：

```text
在标准因果 Transformer 的推理模式下，历史 token 的 K/V 一旦计算完成，
后续解码可以直接复用。
```

因此：

```text
没有必要重复计算历史 token 的 K/V。
```

---

## KV Cache 的核心思想

KV Cache 的核心思想非常简单：

> 历史 token 的 K 和 V 只计算一次，
> 后续生成时直接复用。

---

## 使用 KV Cache 后

Prefill 时：

```text
输入：
[x1, ..., x1024]
```

模型计算：

```text
K1 ~ K1024
V1 ~ V1024
```

然后将其缓存：

```text
KV Cache
```

---

### 下一步生成

已经从 prefill 的最后一个位置采样出新 token：

```text
x1025
```

时：

模型不再重新计算：

```text
K1 ~ K1024
V1 ~ V1024
```

而是：

```text
直接读取缓存
```

接下来把 `x1025` 作为本轮输入，只新增计算：

```text
Q1025
K1025
V1025
```

其中 K/V 追加到每一层的缓存中；Q 只用于本轮预测 `x1026`，无需保存。

---

## KV Cache 的效果

使用 KV Cache 后：

模型每次生成新 token 时：

- 不再重新计算历史 token
- 只计算当前 token
- Attention 直接读取历史缓存

从而大幅降低推理计算量。

---

## 为什么叫 KV Cache，而不是 Q Cache

因为：

```text
历史 Q 不会被后续 token 的注意力计算复用。
```

而：

```text
K/V 会被未来所有 token 使用。
```

因此：

```text
标准增量解码只需要缓存 K/V，
不需要缓存 Q。
```

---

## KV Cache 的本质

KV Cache 本质上是：

> Transformer 在自回归推理中的“历史状态缓存”。

它让大语言模型能够高效地进行长文本生成。

如果没有 KV Cache：

> 现代 LLM 的推理速度将难以满足实际应用需求。

---

## 无 KV Cache 与 KV Cache 的直观对比

### 方案一：无 KV Cache

```text
Step1:
输入:
[请,介,绍,一,下,Transformer]

模型:
计算 6 个 token 的全部 hidden states

输出:
只取最后一个位置的 logits → 采样得到 [是]


Step2:
输入:
[请,介,绍,一,下,Transformer,是]

模型:
重新计算 7 个 token 的全部 hidden states

输出:
只取最后一个位置的 logits → 采样得到 [一]


Step3:
输入:
[请,介,绍,一,下,Transformer,是,一]

模型:
重新计算 8 个 token 的全部 hidden states

输出:
只取最后一个位置的 logits → 采样得到 [种]

...

不断取最后一个位置作为 next token：

Transformer 是一个大语言模型框架 ... [EOS]

遇到结束符停止生成。
```

---

### 方案二：KV Cache

```text
Prefill:
输入:
[请,介,绍,一,下,Transformer]

模型:
一次性计算全部 hidden states

缓存:
K/V Cache(6 tokens)

输出:
最后一个位置的 logits → 采样得到 [是]


Decode Step2:
输入:
[是]

模型:
只计算当前 token 的 Q/K/V

Attention:
Q_是 attend 已缓存的 6 个 prompt token，并把 K_是/V_是 追加到缓存

输出:
[一]

Cache 更新:
7 tokens


Decode Step3:
输入:
[一]

模型:
只计算当前 token 的 Q/K/V

Attention:
Q_一 attend 已缓存的 7 个 token，并追加 K_一/V_一

输出:
[种]

...

遇到结束符停止生成。
```

---

## Prefill 与 Decode

在现代大语言模型（LLM）推理系统中，整个生成过程通常会被拆分为两个阶段：

1. Prefill 阶段
2. Decode 阶段

---

### Prefill

Prefill：

> 将用户输入的 Prompt 一次性送入模型，
> 完整计算整个上下文，
> 并建立 KV Cache。

其特点：

- 全量并行计算
- GPU 利用率高
- GPU 很擅长这种大规模矩阵计算

---

### Decode

Decode：

> 在已有 KV Cache 的基础上，
> 逐 token 自回归生成。

其特点：

- 单 token 增量计算
- GPU 利用率较低
- 每次只生成一个 token

---

### 为什么 Decode 更难优化

虽然：

```text
Decode 每次只输入一个 token
```

但是：

Attention 仍然需要：

```text
读取全部历史 KV Cache
```

因此：

```text
上下文越长，
Decode 越慢。
```

因为：

KV Cache 虽然：

```text
避免了重复计算
```

但：

```text
没有避免历史 KV 的读取。
```

因此：

许多大模型的批量较小的 decode 阶段常常受限于：

```text
HBM Memory Bandwidth
```

而不是：

```text
FLOPS
```

相关优化关注的并不完全是同一问题：

- GQA/MQA 减少需要读取和保存的 KV 头数；
- FlashDecoding 等 kernel 优化长上下文 decode 的并行与访存；
- PagedAttention/vLLM 重点改善 KV Cache 的内存管理、复用与服务吞吐。

等技术存在的原因。
