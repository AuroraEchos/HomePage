---
date: 2025-08-05
category: llm
title: Scaled Dot-Product Attention：缩放点积注意力
---

# Scaled Dot-Product Attention：缩放点积注意力

缩放点积注意力（SDPA）是 Transformer 的核心组件。它通过将 Query 与 Key 进行匹配，计算注意力权重，并对 Value 进行加权求和，从而实现信息的高效聚合。

## 公式与符号约定

SDPA 的公式如下：
$$
\operatorname{Attention}(Q, K, V) = \operatorname{softmax}\left(\frac{QK^T}{\sqrt{d_k}} + M\right)V
$$
下面进行该公式的推导，在此之前，我们需要先进行符号约定：

- Query：$Q \in \mathbb{R}^{n \times d_k}$
- Key：$K \in \mathbb{R}^{m \times d_k}$
- Value：$V \in \mathbb{R}^{m \times d_v}$
- Mask：$M$ 是可选的注意力掩码；被屏蔽位置通常加 $-\infty$，有效位置加 0

其中：

- n：查询序列长度
- m：键/值序列长度
- d_k：Query 和 Key 的维度
- d_v：Value 的维度

在进行下面的推导前，我们要先对 Query、Key 和 Value 的来源做一个说明。假设输入序列为：
$$
X \in \mathbb{R}^{n \times d_{model}}
$$
Transformer 并不会直接用 X 做 attention，而是对它做三次**不同的线性投影**：
$$
Q = XW_Q, K = XW_K, V = XW_V
$$
其中：

- $W_Q \in \mathbb{R}^{d_{model} \times d_k}$
- $W_K \in \mathbb{R}^{d_{model} \times d_k}$
- $W_V \in \mathbb{R}^{d_{model} \times d_v}$

这三个矩阵是完全独立学习的参数。也就是：

- Q：被投影到“查询子空间”
- K：被投影到“匹配子空间”
- V：被投影到“内容子空间”

这本质上是在做一件事：

> 把同一个 token 表示，拆成三种不同用途的表征

注意，在绝大多数 Transformer 实现中，通常有 $d_v = d_k$（单头时常等于 $d_{model}/h$ ），但理论上二者可以不同，这也是公式里把 $d_v$ 单独列出的原因。

## 相似度与缩放因子

我们希望用两个序列的内积来衡量 Query 与 Key 的相似度，这是很直观的假设：

- 在向量范数相近时，内积越大通常表示方向越一致；但内积也受向量模长影响，因此不能直接等同于余弦相似度

因此，我们可以计算所有 Query 与 Key 的两两相似度，得到一个相似度矩阵：
$$
S = QK^T \in \mathbb{R}^{n \times m}
$$
其中第 $i, j$ 个元素表示第 $i$ 个 Query 与第 $j$ 个 Key 的相似度：
$$
S_{ij} = q_i \cdot k_j
$$
但是现在存在一个很大的问题，直接使用 $QK^T$ 会带来一个问题：数值不稳定。

假设 $q_i$ 与 $k_j$ 的各个维度是独立同分布，均值为 0,方差为 1,则它们的内积：
$$
q_i \cdot k_j = \sum_{l=1}^{d_k}q_{il}k_{jl}
$$
其方差为：
$$
Var(q_i \cdot k_j) = d_k
$$
也就是说，随着维度 $d_k$ 增大，内积的数值会变的越来越大，从而导致：

- softmax 输入值过大
- 梯度进入饱和区（接近 one-hot）
- 训练不稳定，甚至梯度消失

为了解决这个问题，引入缩放因子：
$$
\frac{QK^T}{\sqrt{d_k}}
$$
这样可以将方差归一化到常数级别，从而稳定训练。

## Softmax 与 Value 聚合

接下来，我们需要将相似度转换为“权重分布”，因此对每一行进行 softmax：
$$
A = softmax(\frac{QK^T}{\sqrt{d_{k}}})
$$
其中：

- $A \in \mathbb{R}^{n \times m}$

- 每一行表示一个 Query 对所有 Key 的注意力分布

- 满足：
  $$
  \sum_{j=1}^m A_{ij} = 1
  $$

有了注意力权重后，就可以对 Value 做加权求和：
$$
Output = AV \in \mathbb{R}^{n \times d_v}
$$
展开来看：
$$
output_i = \sum_{j=1}^m A_{ij} v_j
$$
也就是说：每一个 Query 输出，是所有 Value 的加权组合，权重由 Query 与 Key 的相似度决定。

因此，Scaled Dot-Product Attention 的完整形式为：
$$
\operatorname{Attention}(Q, K, V) = \operatorname{softmax}\left(\frac{QK^T}{\sqrt{d_k}} + M\right)V
$$
可以从表示学习角度理解：

- Q：当前“要找什么信息”的表示（query intent）
- K：所有“可被检索的信息索引”（key index）
- V：真正承载信息的内容（value content）

注意力机制本质上是在做一件事：

> 用 Query 在 Key 空间中做一次软检索，再从 Value 中读出信息

## Self-Attention、Cross-Attention 与因果掩码

这里需要说明一件事情：虽然我们说 V 承载“内容”，但 Q / K / V 本质上都是 learned feature transformation，没有绝对语义分工，也就是说 “V 是内容”是结构决定的（被加权），但具体“什么信息放进 V”是模型自己学的。

以上就是关于 SDPA 的一些说明。

当 Q，K，V 均来自同一个 X 时，它就是我们现在经常提到的自注意力（Self-Attention）；在 Encoder-Decoder 结构中，如果 Q 来自 Decoder，而 K，V 来自 Encoder，则称为交叉注意力（Cross-Attention）。

在 Decoder-only 架构中，为了防止当前位置看到未来 token，会在 Softmax 前加入加性因果掩码 $M$：允许位置为 0，禁止位置为 $-\infty$（实际实现也可能使用足够小的有限值或布尔掩码）。这样被遮挡位置的 Softmax 权重为 0。
