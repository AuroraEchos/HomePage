---
date: 2026-07-10
category: llm
title: LLM 基础知识
---

# LLM 基础知识

### Q：请描述 Transformer 的整体架构？

原始 *Attention Is All You Need* 中的 Transformer 是 Encoder–Decoder 架构，两部分都由 $N$ 个结构相同但参数不共享的层堆叠而成。后来的 BERT 只保留 Encoder，GPT、LLaMA、Qwen 等生成模型通常只使用带因果掩码的 Decoder 风格堆叠。

Encoder 层首先输入是一个完整的序列，然后进行通过 Embedding 层进行特征向量化，输出为稠密的低维度的连续向量，接着进行位置编码去注入时序信息，因为 Transformer 内部的注意力机制在计算的时候是并行的，天然丢失了位置信息，比如对模型来说，“我爱深度学习”和“深度学习爱我”在没有位置信息时是一样的，所以我们需要让模型知道序列中 Token 的先后顺序，也就是在我们拿到的向量上加上位置编码，接下来就是由 N 个相同的层堆叠，以 Encoder 中一个为例子，首先经过多头注意力，然后是残差连接与层归一化，接着是前馈神经网络，然后再经过一个残差连接与归一化，接着就是堆叠，残差连接就是把这一层的输入直接加到输出上，防止深层网络梯度消失。

Decoder 与 Encoder 类似，也是 $N$ 层堆叠。训练时使用右移后的目标序列作为输入：位置 $t$ 的表示可以看到当前位置及更早的输入 token，并用于预测下一个 token；因果掩码阻止它读取未来位置。原始 Encoder–Decoder Transformer 的每个 Decoder 层依次包含掩码自注意力、读取 Encoder 输出的交叉注意力以及前馈网络，并配有残差连接和归一化。Decoder-only LLM 则没有 Encoder 和交叉注意力。

经过 Decoder 堆叠后，隐藏状态通过语言模型输出投影得到 logits；Softmax 将 logits 转为词表上的概率分布。训练通常直接把 logits 交给交叉熵损失，推理时再按需要做 Softmax、采样或取最大值。

------

### Q：为什么 Transformer 比 RNN 要好？

第一点：RNN 沿序列维存在递归依赖，训练时难以把所有时间步完全并行化；Transformer 在整段训练时可以并行处理 token，更适合 GPU/TPU。不过自回归生成仍然具有逐 token 的串行依赖。

第二点：长距离信息依赖，RNN 会发生梯度消失或者信息遗忘，但是 Transformer 计算时，序列中的任意两个 Token 都可以通过注意力矩阵直接计算。

第三点：在一层全局自注意力中，任意两个未被 mask 隔开的 token 之间路径长度是 $O(1)$；RNN 则需要沿时间步传播。若使用局部/稀疏注意力，或者讨论跨多层信息处理，这个结论需要相应调整。

------

### Q：详细推导 Self-Attention 的计算过程

计算公式：
$$
Attention(Q, K, V) = softmax(\frac{QK^T}{\sqrt{d_k}})V
$$
假设有一个输入序列，长度为 N，词向量维度为 $d_{model}$ ，经过词向量嵌入后，得到一个输入矩阵  $X \in \mathbb{R}^{N \times d_{model}}$ 。

自注意力机制引入了三个可学习的权重矩阵 $W_Q \in \mathbb{R}^{d_{model} \times d_k}$ ，$W_K \in \mathbb{R}^{d_{model} \times d_k}$ ，$W_V \in \mathbb{R}^{d_{model} \times d_v}$ ，分别与 X 相乘，得到三个全新的矩阵：Query（查询矩阵）、Key（键矩阵）和 Value（值矩阵）。

- $$Q = X \cdot W_Q \quad (Q \in \mathbb{R}^{N \times d_k})$$

- $$K = X \cdot W_K \quad (K \in \mathbb{R}^{N \times d_k})$$

- $$V = X \cdot W_V \quad (V \in \mathbb{R}^{N \times d_v})$$

接着计算相似度分数，我们要知道序列中第 i 个词和第 j 个词之间的相关性，使用向量的点积，也就是：
$$
S = Q K^T \quad (S \in \mathbb{R}^{N \times N})
$$
随着维度 $d_k$ 的增大，点积的结果往往会变得很大。这会导致下一步计算 Softmax 时，梯度极其微弱（进入饱和区）。为了避免这个问题，我们需要将分数除以 $\sqrt{d_k}$ 进行缩放：
$$
S_{\text{scaled}} = \frac{Q K^T}{\sqrt{d_k}}
$$
为了将这些分数转化为概率分布（即权重，相加为 1），我们在**行**的方向上应用 Softmax 函数：
$$
A = \text{softmax}\left(\frac{Q K^T}{\sqrt{d_k}}\right) \quad (A \in \mathbb{R}^{N \times N})
$$
此时，矩阵 $A$ 就是 Attention Map（注意力权重矩阵）。其中的第 $i$ 行代表第 $i$ 个词对序列中所有词的注意力权重分配。

最后 step，我们用计算出的权重矩阵 $A$，对包含实际信息的 Value 矩阵 $V$ 进行加权求和：
$$
O = A \cdot V \quad (O \in \mathbb{R}^{N \times d_v})
$$
输出矩阵 $O$ 的每一行，就是融合了上下文信息后，该 Token 的全新向量表示。

理论上 $d_v$ 可以独立于 $d_k$。在多头注意力中，各头输出先拼接，再经过 $W_O$ 投影回 $d_{model}$ 后才与残差分支相加，因此残差连接要求的是最终输出维度为 $d_{model}$，并不直接要求单头的 $d_v=d_k$。标准实现常令二者相等以简化设计。

------

### Q：为什么要除以 $\sqrt{d_k}$ ？

设 q,k 各维度服从标准正态分布 N(0,1)，$$\mathbb{E}[q_i] = \mathbb{E}[k_i] = 0$$ ，$$\text{Var}(q_i) = \text{Var}(k_i) = 1$$ ，点积运算 $q \cdot k^T$，它实际上是 $d_k$ 个乘积项的和，由于这 $d_k$ 个乘积项之间是相互独立的，根据**方差的可加性**（独立随机变量相加，方差直接相加）：
$$
\text{Var}\left( \sum_{i=1}^{d_k} q_i k_i \right) = \sum_{i=1}^{d_k} \text{Var}(q_i k_i) = \underbrace{1 + 1 + \dots + 1}_{d_k \text{个}} = d_k
$$
点积结果的总均值为 0，但总方差变成了 $d_k$。方差代表数据的离散程度或波动范围。根据统计学常识，标准差（Standard Deviation）是方差的算术平方根：
$$
\sigma = \sqrt{\text{Var}(q \cdot k^T)} = \sqrt{d_k}
$$
这意味着，随着维度 $d_k$ 的增大，点积结果的波动范围（标准差）会以 $\sqrt{d_k}$ 的速度随之扩大。

Softmax 的公式为 $f(x_i) = \frac{e^{x_i}}{\sum_j e^{x_j}}$。如果不缩放，较大的 $d_k$ 会让 logits 的典型尺度增大，使 Softmax 更容易进入梯度很小的饱和区域。除以 $\sqrt{d_k}$ 在上述独立、单位方差假设下把点积方差归一到 1，从而降低饱和风险；真实网络并不严格满足这些分布假设，因此这是一种有效的尺度控制，而不是“完美阻止”饱和。

------

### Q： Self-Attention 的计算复杂度为多少？

对于两个矩阵相乘，$(A \times B) \cdot (B \times C)$ 的基础时间复杂度为 $\mathcal{O}(A \cdot B \cdot C)$。

生成 Q, K, V 矩阵：$3 \cdot \mathcal{O}(N \cdot d^2) \rightarrow \mathcal{O}(N \cdot d^2)$ 。

计算注意力分数：$\mathcal{O}(N \cdot d \cdot N) = \mathcal{O}(N^2 \cdot d)$ 。

Softmax 归一化：每一行有 $N$ 个元素，做一次 Softmax 是 $\mathcal{O}(N)$；一共 $N$ 行，总复杂度为 $\mathcal{O}(N^2)$。

Value 加权聚合成输出：$\mathcal{O}(N \cdot N \cdot d) = \mathcal{O}(N^2 \cdot d)$ 。

最终线性投影：$\mathcal{O}(N \cdot d \cdot d) = \mathcal{O}(N \cdot d^2)$ 。

忽略低阶项和常数项，最终的时间复杂度为：$$\mathcal{O}(N \cdot d^2 + N^2 \cdot d)$$ 。

完整 Attention 模块的主要项是 $\mathcal{O}(Nd^2 + N^2d)$。当 $N\gg d$ 时二次注意力项占主导；当序列较短而隐藏维度很大时，QKV/输出投影甚至 FFN 可能占更多计算。通常说 Self-Attention 对序列长度是二次复杂度，指的是 $N^2d$ 这一项。

------

### Q：Multi-Attention 的原理和作用

多头注意力把 Query、Key、Value 投影到多个子空间，并行执行多组注意力计算，最后拼接融合。单头也可能混合多种关系，但多头为不同匹配模式提供了更直接的独立表示通道。

假设输入的向量维度为 $d_{model}$ ，头数为 h，每个头的维度 $d_k = d_v = d_{model}/h$ 。

首先进行分头，将 Q，K，V 分别映射到 h 个子空间，得到 h 组 ($Q_i, K_i, V_i$) 。

接着对每一组执行缩放点积注意力：
$$
Attention(Q_i, K_i, V_i) = softmax(\frac{Q_iK_i^T}{\sqrt{d_k}})V_i
$$
然后直接拼接所有头的输出：
$$
Concat = [head_1; head_2;...;head_h]
$$
最后进行线性变换融合：
$$
MultiHead(Q, K, V) = Concat \cdot W_O
$$
其中 $W_O$ 是多头拼接之后的输出投影矩阵，唯一任务是把多个头拼接在一起的向量，重新映射回模型原始维度 $d_{model}$，同时学习融合多头信息。

通常来说 $d_{model}$ 能被头数 h 整除，保证均分维度。

举个 NLP 例子：

    Head1：关注语法主谓关系
    Head2：关注长距离指代
    Head3：关注局部相邻词语义
    Head4：关注同义词语匹配

单个注意力头很难同时学好全部；多头相当于同时启用多组不同关注点。

代码示例如下：

```python
import math
import torch
import torch.nn as nn
import torch.nn.functional as F


def scaled_dot_product_attention(Q, K, V, mask=None):
    """
    Q,K,V: [batch, heads, seq_len, d_k]
    mask: [batch, 1, seq_len, seq_len] 或者 [1,1,seq_len,seq_len]
    """
    d_k = Q.size(-1)

    attn_score = torch.matmul(Q, K.transpose(-2, -1)) / math.sqrt(d_k)

    if mask is not None:
        attn_score = attn_score.masked_fill(mask == 0, -1e9)

    attn_weight = F.softmax(attn_score, dim=-1)
    output = torch.matmul(attn_weight, V)
    return output, attn_weight


class MultiHeadAttention(nn.Module):
    def __init__(self, d_model, n_heads):
        super().__init__()
        assert d_model % n_heads == 0, "d_model 必须能被头数整除"

        self.d_model = d_model
        self.n_heads = n_heads
        self.d_k = d_model // n_heads

        # Q, K, V 投影矩阵 W_Q, W_K, W_V
        self.w_q = nn.Linear(d_model, d_model)
        self.w_k = nn.Linear(d_model, d_model)
        self.w_v = nn.Linear(d_model, d_model)

        # 输出融合矩阵 W_O
        self.w_o = nn.Linear(d_model, d_model)

    def forward(self, q, k, v, mask=None):
        # q: [B, Lq, d_model]
        # k: [B, Lk, d_model]
        # v: [B, Lv, d_model]

        batch_size = q.shape[0]

        # 线形投影
        Q = self.w_q(q)   # [B, Lq, d_model]
        K = self.w_k(k)   # [B, Lk, d_model]
        V = self.w_v(v)   # [B, Lv, d_model]
        
        # 分头
        # [B, seq_len, n_heads, d_k] -> [B, n_heads, seq_len, d_k]
        Q = Q.view(batch_size, -1, self.n_heads, self.d_k).transpose(1, 2)
        K = K.view(batch_size, -1, self.n_heads, self.d_k).transpose(1, 2)
        V = V.view(batch_size, -1, self.n_heads, self.d_k).transpose(1, 2)

        # 缩放点积注意力
        attn_out, attn_weights = scaled_dot_product_attention(Q, K, V, mask)
        
        # 拼接多头
        # [B, n_heads, seq_len, d_k] -> [B, seq_len, n_heads, d_k]
        attn_out = attn_out.transpose(1, 2).contiguous()
        # concat：把所有头拼回 d_model
        attn_out = attn_out.view(batch_size, -1, self.d_model)

        # W_O 融合所有头信息
        output = self.w_o(attn_out)

        return output, attn_weights

if __name__ == "__main__":
    d_model = 512
    n_heads = 8
    mha = MultiHeadAttention(d_model, n_heads)
    batch = 2
    src_len = 12   # encoder序列长度
    tgt_len = 10    # decoder序列长度

    # 1. Encoder输入特征
    x = torch.randn(batch, src_len, d_model)

    print("===== 1. Encoder 自注意力 Q=K=V =====")
    out1, attn1 = mha(x, x, x)
    print("out shape:", out1.shape)      # [2, 12, 512]
    print("attn weight shape:", attn1.shape, "\n") # [2,8,12,12]

    # 构造Decoder因果掩码（下三角mask）
    def get_causal_mask(seq_len):
        mask = torch.tril(torch.ones(seq_len, seq_len))
        return mask.unsqueeze(0).unsqueeze(0) # [1,1,L,L]
    tgt_mask = get_causal_mask(tgt_len)

    # 2. Decoder 掩码自注意力
    tgt_x = torch.randn(batch, tgt_len, d_model)
    print("===== 2. Decoder 掩码自注意力（带因果mask） =====")
    out2, attn2 = mha(tgt_x, tgt_x, tgt_x, mask=tgt_mask)
    print("out shape:", out2.shape)      # [2, 10, 512]
    print("attn weight shape:", attn2.shape, "\n") # [2,8,10,10]

    # 3. Decoder 交叉注意力
    memory = x   # encoder最终输出作为K,V
    print("===== 3. Decoder 交叉注意力 Cross-Attention =====")
    out3, attn3 = mha(q=tgt_x, k=memory, v=memory)
    print("out shape:", out3.shape)      # [2, 10, 512]
    print("attn weight shape:", attn3.shape) # [2,8,10,12]
```

Encoder 自注意力 / Decoder 掩码自注意力场景，传入 MHA 的原始 q、k、v 初始均为同一特征向量x；经过内部各自独立的线性投影后，得到不同的 Q，K，V；Decoder 交叉注意力场景，q 来自解码器，k/v 来自编码器，三者初始输入不是同一个特征。

只有 Decoder 的掩码自注意力使用下三角形式的因果掩码；Encoder 自注意力、交叉注意力使用 padding mask，和下三角无关。

------

### Q：RoPE 的原理

在 Transformer 架构中，Self-Attention 机制本身是排列不变的，不关注 token 的顺序，因此必须要注入位置信息。

常见位置编码可以粗略分为绝对位置表示和直接建模相对位移的方案，但具体实现不只下面两种：

- 绝对位置编码：直接加在词向量上，告诉模型这是第几个词，这种编码方式无法直接体现两个词之间的相对距离。
- 相对位置编码：可以在 Attention score 上加入相对位置偏置，也可以修改 Q/K 表示；不同方案的计算与显存开销不同。

RoPE 的编码思想是在形式上是对词向量进行绝对位置编码，但是在计算 Attention 的内积的时候，只依赖相对位置，通过向量旋转来实现。

将词向量的每两个维度看作是一个二维平面，根据 token 的绝对位置，在这个平面上旋转一个特定的角度。

假设我们有一个 2 维的词向量 \[ q = \begin{pmatrix} q_0 \\ q_1 \end{pmatrix}, \] 它所在的位置是 $m$。 我们设定一个基础旋转角度 $\theta$。位置 $m$ 对应的总旋转角度就是 $m\theta$。 将向量 $q$ 旋转 $m\theta$ 角度，得到带有位置信息的向量 $q_m$：
$$
 q_m = R_m q = \begin{pmatrix} \cos m\theta & -\sin m\theta \\ \sin m\theta & \cos m\theta \end{pmatrix} \begin{pmatrix} q_0 \\ q_1 \end{pmatrix} 
$$
同理，对于另一个位置 $n$ 的向量 $k$，旋转后得到 $k_n = R_n k$。 

现在，我们计算 Attention 中核心的内积（点乘）：
$$
\begin{aligned} \langle q_m, k_n \rangle &= q_m^T k_n \\ &= (R_m q)^T (R_n k) \\ &= q^T R_m^T R_n k \end{aligned}
$$
根据旋转矩阵的性质，$R_m^T R_n = R_{n-m}$（即反向旋转 $m$ 再正向旋转 $n$，等价于直接旋转 $n-m$）。 因此： \[ \langle q_m, k_n \rangle = q^T R_{n-m} k = \langle q, k_{n-m} \rangle \]

也就是两个带有绝对位置信息的向量做内积，其结果只与它们的相对位置有关，与绝对位置无关。

实际模型中，词向量的维度 $d$ 通常是几百到几千（如 4096）。RoPE 的做法是：

- 将 $d$ 维向量两两分组，分成 $d/2$ 个二维子空间。
- 为每个子空间分配一个不同的旋转频率 $\theta_i$。
- 频率的设定借鉴了原始的 Sinusoidal 编码：$\theta_i = 10000^{-2i/d},\quad \text{其中 } i \in \{0,1,\dots,d/2-1\}$
- 对每个二维子空间分别进行旋转。

高频部分（$i$ 较小，$\theta_i$ 较大）：旋转角度变化快，用于捕捉短距离的局部位置关系。低频部分（$i$ 较大，$\theta_i$ 较小）：旋转角度变化慢，用于捕捉长距离的全局位置关系。

RoPE 不需要可学习的位置 Embedding 表。cos/sin 可以预计算或缓存，再对每层 Q/K 做逐元素旋转；由于旋转依赖 token 位置，不能一般性地合并进一组固定的 QKV 投影权重。

RoPE 公式可以计算训练长度以外的位置，但“可计算”不等于模型能够可靠外推；实际长上下文模型常使用位置插值、频率缩放和继续训练。

------

### Q：从原始句子到位置编码前，数据维度的变化？

| 阶段             | 数据形态   | 张量形状 (Shape)      | 数据类型 | 包含的信息                                |
| ---------------- | ---------- | --------------------- | -------- | ----------------------------------------- |
| **原始句子**     | 字符串     | 无                    | String   | 人类可读的文本                            |
| **分词后**       | ID 列表    | `[L]`                 | Int      | 离散的符号索引                            |
| **批处理后**     | ID 矩阵    | **`[B, L]`**          | Int      | 包含 Batch 和 Sequence 维度的纯索引       |
| **Embedding 后** | 向量张量   | **`[B, L, d_model]`** | Float    | **纯语义信息（位置编码前的最终状态）**    |
| **Q/K 投影并分头后** | Q/K 张量 | **`[B, H, L, d_head]`** | Float | 每个注意力头的查询/键表示 |
| **RoPE 后**      | 旋转后的 Q/K | **`[B, H, L, d_head]`** | Float | 注入位置相位，随后计算 Attention |

------

### Q：LayerNorm 与 BatchNorm 的区别？

两个最主要的区别是：

- BN 沿着 batch 维度进行归一化，计算均值和方差，也就是会跨样本计算，Batch Size 太小时均值/方差估计不稳定，效果急剧下降。主要应用场景是计算机视觉那边。
- LN 是沿着特征通道维度进行归一化，计算均值和方差，是在单个样本内进行计算，Batch Size 可以为 1。主要应用场景是 NLP 。

为什么传统 CNN 常用 BN，而 Transformer 更常用 LN/RMSNorm？

BN 通常按通道使用 batch（以及卷积中的空间位置）统计量，训练行为依赖 batch 组成，并需要维护运行均值/方差；小 batch、变长序列与分布变化会让它更难使用。LN/RMSNorm 对每个 token 的特征维独立归一化，不依赖其他样本，更契合 Transformer。它们是主流选择，但并非理论上“必须”。

------

### Q：介绍 Pre-Norm 和 Post-Norm？

Pre-Norm 与 Post-Norm 是 Transformer 架构中 Layer Normalization 放置位置的两种不同策略。

它们的核心区别在于：LN 是放在残差连接的“主干分支上”还是“合并后的主路径上”。

原始的 Trnsformer 论文中给出的是放在合并后的主路径上，也就是后归一化，输入 x，先进行子层的计算，然后和原始的 x 想加，想加得到的输出再进行归一化：
$$
x_{out} = LN(x + F(x))
$$
但是现在的大模型结构上一般是采用前归一化，就是输入 x ，先进行归一化，然后经过子层，再和原始 x 想加：
$$
x_{out} = x + F(LN(X))
$$
核心差异在梯度传播和表示尺度。Post-Norm 的深层网络通常更难直接优化，往往需要更谨慎的初始化、学习率或其他稳定化方法；不能用固定的“超过 30 层就梯度趋近 0”作为普遍边界。

Pre-Norm 保留了一条跨层的恒等残差路径。其总导数不是简单等于 1，而是包含恒等项与子层导数；这条直接路径通常让深层训练更稳定，但也有深度利用不足等讨论。

------

### Q：RMSNorm 是什么？

RMSNorm 是 LayerNorm 的简化变体，移除了均值中心化步骤与可学习偏置 β，只使用均方根做尺度归一；计算更快、参数更少，效果与 LN 接近。

既然去掉均值中心化，为什么还能稳定训练？

RMSNorm 原论文的结论是：LayerNorm 的重中心化性质在所测任务中并非必需，而重缩放性质是主要贡献。许多现代 Transformer 的线性层甚至不使用 bias，因此不能把效果简单归因于“线性层补偿均值”。

------

### Q：介绍一下标准的前馈层 FFN 和 SwiGLU

原始论文中的结构是：
$$
FFN(x) = W_2 \cdot \sigma(W_1x)
$$
原始的激活函数基本上使用的是 ReLU。先通过一个线性层升高维度，然后经过激活函数激活，最后再经过一个线性层降低维度。参数量：
$$
Param = Param(W_1) + Param(W_2) = (d * 4d + 4d) + (4d * d + d) = 8d^2 + 5d
$$

```python
import torch
import torch.nn as nn

class FFN(nn.Module):
    def __init__(self, d_model: int):
        super().__init__()
        self.w1 = nn.Linear(d_model, 4*d_model)
        self.w2 = nn.Linear(4*d_model, d_model)
        self.act = nn.GELU()
    def forward(self, x):
        return self.w2(self.act(self.w1(x)))
```

SwiGLU 的公式为：
$$
\operatorname{SwiGLU}(x) = W_2(\operatorname{Swish}(W_Vx) \odot (W_Ux))
$$
W_u 与 W_v 的输出维度各为 $\boldsymbol{\tfrac{8}{3}d}$  ，总参数量和原始 FFN 参数量几乎持平。

```python
class SwiGLU(nn.Module):
    def __init__(self, d_model: int):
        super().__init__()
        hidden = int(8 * d_model / 3)
        self.wu = nn.Linear(d_model, hidden)
        self.wv = nn.Linear(d_model, hidden)
        self.w2 = nn.Linear(hidden, d_model)
        self.swish = lambda z: z * torch.sigmoid(z)
    def forward(self, x):
        u = self.wu(x)
        v = self.wv(x)
        h = u * self.swish(v)
        return self.w2(h)
```

- 标准 FFN：单路映射 → 激活；信息流只有一条分支
- SwiGLU：两路独立线性投影，一路经过 swish 激活，两路相乘融合；门控结构（Gated Linear Unit）

GLU 引入乘法交互，能够建模更复杂非线性。

------

### Q：Encoder-Only/Decoder-Only/Encoder-Decoder 的区别？

需要明确一些基础的组件：

- Encoder Self-Attention：双向注意力，token 能看见上下文左右全部 token。
- Decoder Self-Attention（Masked Self-Attention / 因果注意力 Causal Attention）：单向注意力，只能看到当前位置及左侧历史 token，看不到未来 token。
- Cross-Attention（交叉注意力）：Decoder 查询 Query，从 Encoder 输出 Key/Value 提取信息。

Encoder-Only 也就是仅编码器，代表模型有 BERT、RoBERT、ViT 等，结构上就是堆叠多层 Encoder Block，每个 Encoder Blok 包含一个双向自注意力和前馈层。它的特点就是利用完整的上下文信息，没有因果 mask，不能做自回归生成，在推理上就是输入一个完整句子，然后一次性全局建模。适合的任务有文本分析，情感分类，语义相似度等。

Decoder-Only 是现在自回归大语言模型常用的架构，代表模型有 GPT 系列、LLaMA、Qwen、Mistral 等。它堆叠因果自注意力和 FFN，通常没有 Encoder–Decoder Cross-Attention。词嵌入与输出头可以权重共享，也可以不共享，取决于具体模型。

Encoder-Decoder 代表模型：原始 Transformer、T5、BART、mBART。

- Encoder：双向 Self-Attention，编码源序列。
- Decoder：Masked Self-Attention + Cross-Attention，读取 Encoder 编码，生成目标序列。

适合的任务有机器翻译、文本摘要等。

三者预训练目标：

- Encoder-Only：MLM 掩码语言建模（BERT）
- Decoder-Only：LM 自回归语言建模，预测下一个 token（GPT）
- Encoder-Decoder：Span/Seq2Seq 掩码，目标序列重建（T5）

------

### Q：因果掩码是什么？

在自回归语言模型中，模型的训练和生成方式是从左到右逐个预测下一个 Token，为了确保模型在生成序列中第 t 个词时，只能看到第 t 个词以及之前的内容，看不到 t+1 以及之后的词，需要一个掩码矩阵。

在 Transformer 的自注意力机制中，模型会计算一个注意力分数矩阵，表示序列中每个词对其他词的关注度。假设序列长度为 N，这个矩阵的大小是 N×N，因果掩码在代码中通常表现为一个下三角矩阵，这个掩码矩阵会加到注意力矩阵上，然后经过 Softmax 函数后，上三角位置的注意力权重会变成 0,这样就可以屏蔽未来的词。

这个矩阵上三角部分的值为负无穷，或 False ，表示禁止关注。下三角部分的值为 0 或者 True。表示允许关注。

------

### Q: BPE 分词算法的原理

1. 初始化词表为所有字符
2. 统计所有相邻字符对的频率
3. 合并频率最高的相邻符号对，并把新符号加入词表
4. 重新统计并继续合并，直到达到目标词表大小或合并次数

实际 tokenizer 还涉及预分词、特殊 token、Unicode/字节处理；byte-level BPE 的初始符号是字节映射，不是简单的“所有字符”。

------

#### Q：LLM 预训练使用什么损失函数？

自回归大模型通常使用 next-token cross-entropy，即最小化真实下一个 token 的负对数似然。Padding 常通过 loss mask 或 `ignore_index` 排除。SFT 也常用交叉熵，但是否 mask prompt 取决于数据与训练目标；偏好优化/RL 阶段可能再引入奖励、KL 或成对偏好等目标。

------

### Q: Adam vs AdamW 的区别？

Adam 和 AdamW 的核心区别在于：如何实现权重衰减（weight decay）。

- 在常见的“Adam + L2 正则”写法中，$\lambda\theta$ 被加入梯度，再一起经过 Adam 的一阶/二阶矩自适应缩放；因此它不等价于经典的直接权重衰减。
- AdamW 把衰减与梯度更新解耦，单独执行类似 $\theta \leftarrow (1-\eta\lambda)\theta$ 的更新，使衰减项不经过 Adam 的自适应预条件。

对普通 SGD，适当换算后 L2 正则与 weight decay 等价；对 Adam 这类自适应优化器通常不等价。这也是现代 Transformer 训练普遍使用 AdamW 的主要原因之一。

参考：[Decoupled Weight Decay Regularization](https://arxiv.org/abs/1711.05101)。
