---
date: 2025-09-01
category: llm
title: SDPA → MHA → GQA
---

# SDPA → MHA → GQA 的演化路径

缩放点积注意力（Scaled Dot-Product Attention, SDPA）是 Transformer 的核心组件。其公式如下：
$$
Attention(Q,K,V)=softmax\left(\frac{QK^T}{\sqrt{d_k}} + M_{\text{add}}\right)V
$$
其中输入 Query、Key、Value 的维度为（此时我们脱离多头注意力（MHA）的上下文，只看一个最纯粹的注意力算子）：

- Query：[B, L_q, d]
- Key：[B, L_k, d]
- Value：[B, L_k, d_v]（Key 与 Value 必须有相同的序列长度）
- Mask：可广播到 `[B, L_q, L_k]`；带多头维时常写成 `[B, 1, L_q, L_k]`

## 标准 SDPA 与因果掩码

标准的基于 Pytorch 的 SDPA 代码实现如下：

```python
class ScaledDotProductAttention(nn.Module):
    def __init__(self, dropout: float = 0.1):
        super().__init__()
        self.dropout = nn.Dropout(dropout)

    def forward(self, query: Tensor, key: Tensor, value: Tensor, mask: Tensor = None):
        d_k = query.size(-1)
        scores = torch.matmul(query, key.transpose(-2, -1)) / math.sqrt(d_k)

        if mask is not None:
            scores = scores.masked_fill(mask == 0, float('-inf'))

        attn_weights = F.softmax(scores, dim=-1)
        attn_weights = self.dropout(attn_weights)

        output = torch.matmul(attn_weights, value)
        return output, attn_weights
```

注意：在上述代码里，`scores = torch.matmul(q, k.T)` 计算的是序列中**两两之间**的所有相关性。如果没有 Mask，模型在处理第 1 个词时，就能看到第 100 个词的信息。

所以在现在的自回归生成模型中，我们通常会使用一个下三角掩码，让 t 时刻只能看到 ≤t 的词，防止模型看到未来的信息。生成的注意力权重的矩阵维度为 L_q * L_k，所以我们要对应生成一个维度一样的下三角掩码矩阵。

掩码的逻辑用到了Softmax 的数学特性：假设 `scores` 中某个位置的值是 `10.5`。如果 `mask == 0`（不可见），我们将该位置替换为 **−∞** (`-inf`)。**Softmax**：e−∞ 无限趋近于 **0**。经过 Softmax 后，被遮盖位置的权重变成了 **0**。在后续与 `Value` 矩阵相乘时，这些位置的信息贡献就彻底消失了。我们可以使用一个示例：

假设序列长度为 $L = 4$，则注意力分数矩阵为：
$$
S = QK^T =
\begin{bmatrix}
s_{11} & s_{12} & s_{13} & s_{14} \\
s_{21} & s_{22} & s_{23} & s_{24} \\
s_{31} & s_{32} & s_{33} & s_{34} \\
s_{41} & s_{42} & s_{43} & s_{44}
\end{bmatrix}
$$
其中：
$$
s_{ij} = q_i \cdot k_j
$$
在自回归任务中，我们使用下三角 Mask：
$$
M =
\begin{bmatrix}
1 & 0 & 0 & 0 \\
1 & 1 & 0 & 0 \\
1 & 1 & 1 & 0 \\
1 & 1 & 1 & 1
\end{bmatrix}
$$
应用 Mask 后的分数矩阵为：
$$
S' =
\begin{bmatrix}
s_{11} & -\infty & -\infty & -\infty \\
s_{21} & s_{22} & -\infty & -\infty \\
s_{31} & s_{32} & s_{33} & -\infty \\
s_{41} & s_{42} & s_{43} & s_{44}
\end{bmatrix}
$$
对每一行进行 Softmax：
$$
A = \text{softmax}(S')
$$
例如第一行：
$$
(1, 0, 0, 0)
$$
第二行：
$$
(\alpha, \beta, 0, 0), \quad \alpha + \beta = 1
$$
最终得到注意力权重矩阵：
$$
A =
\begin{bmatrix}
1 & 0 & 0 & 0 \\
\alpha & \beta & 0 & 0 \\
\gamma & \delta & \epsilon & 0 \\
\eta & \theta & \kappa & \lambda
\end{bmatrix}
$$
第 i 行表示第 i 个 token 只能关注前 i 个 token，从而保证生成过程的因果性。

Dropout 在训练时随机置零部分注意力权重并按 dropout 规则缩放保留项，用于正则化。它通常加在 softmax 之后、乘 Value 之前，但不保证注意力分布一定更均匀；推理时应关闭。

以上就是关于标准 SDPA 的相关内容说明。

朴素 SDPA 会显式物化 $L_q\times L_k$ 的分数和注意力矩阵，计算复杂度为 $O(L_qL_kd)$，额外内存复杂度为 $O(L_qL_k)$。长序列下它会成为重要瓶颈。FlashAttention 保留精确注意力语义并优化 IO 与中间存储；Linear Attention 则改变计算形式，两者不是同一种优化路线。

下面我们来介绍 FlashAttention-2。

## FlashAttention-2 与 PyTorch SDPA

一句话总结 FlashAttention-2 的目标就是：不存 $QK^T$、不存 softmax 权重，用分块 + 在线 softmax 把显存降到 O (N)，同时把并行拉满。具体的底层原理在这里就不进行阐述，我们直接看如何使用。

PyTorch 提供 `torch.nn.functional.scaled_dot_product_attention`（SDPA）统一接口，并根据设备、数据类型、形状和掩码等条件，在可用的 fused kernel 与数学实现之间选择后端。调用这个接口不等于保证使用 FlashAttention-2。

代码使用如下：

```python
import torch
import torch.nn.functional as F

# 原来的注意力计算，直接替换成这一句：
attn_output = F.scaled_dot_product_attention(
    q, k, v,
    attn_mask=mask,
    dropout_p=0.1,
    is_causal=True
)
```

下面我们重点看一下 API F.scaled_dot_product_attention 的要求输入。

```python
def scaled_dot_product_attention(
    query: Tensor,          # Q
    key: Tensor,            # K
    value: Tensor,          # V
    attn_mask: Tensor | None = None,  # 掩码
    dropout_p: float = 0,   # 随机失活
    is_causal: bool = False,# 因果掩码
    scale: float | None = None, # 缩放因子：默认就是 1/sqrt(d_k)
    enable_gqa: bool = False# 开启GQA：LLM推理加速用
) -> Tensor:
```

这里需要有一些内容进行说明：

1. attn_mask: Tensor | None = None：这个通常有两种作用，一个是padding mask：遮住填充的 `<pad>`，另外一个是encoder-decoder mask：遮住无效位置。
2. `is_causal=True` 用于因果注意力。是否可以同时传 `attn_mask`、两者如何组合以及具体后端限制，会随 PyTorch 版本变化；可移植代码应按当前版本文档和测试结果处理。
3. 这个 API 只返回输出，不返回权重（为了快 + 省显存）。
4. PyTorch 会尝试选择可用的高效后端，也可能因为硬件、dtype、head dimension、mask、dropout 或构建选项等条件回退。需要确认后端时，可使用 PyTorch 提供的 SDPA backend 控制与日志能力，而不要只根据 GPU 世代猜测。

如确实需要上游 `flash-attn` 库提供的变长序列等接口，可以单独安装，但应先核对 CUDA、PyTorch、编译器和 GPU 的兼容矩阵：

`pip install flash-attn --no-build-isolation`

生产环境应固定版本并做正确性与性能基准，不要假设第三方库在所有输入上都比 PyTorch SDPA 更快。

F.scaled_dot_product_attention 中的最后一个关键参数是 enable_gqa: bool = False 。在介绍这个之前，我们需要先介绍一下多头注意力（Multi-Head Attention, MHA）。

## 多头注意力（MHA）

多头注意力让模型在多个独立投影子空间中并行计算注意力，增加了同一层可表示的匹配模式。不同头有时会呈现句法、指代或局部模式，但这些解释不是预先指定的，也不保证每个头只负责一种语义。

单头并非绝对无法混合多种关系，但它只产生一张注意力图；多头结构为多个投影和注意力图提供了更直接的并行表示能力。

多头注意力做的事情非常简单：把特征空间切成多个子空间，每个头学一种 “关注方式”。例如 8 个头，模型就可以同时学会 8 种不同的注意力：

- 头 1：关注**语法结构**（主语→动词）
- 头 2：关注**指代关系**（it → cat）
- 头 3：关注**局部上下文**（相邻词）
- 头 4：关注**长距离语义**（遥远但相关的词）
- 头 5：关注**逻辑关系**（because → 原因）
- 头 6：关注**搭配习惯**（good at）
- ……

直观上可以把多头理解为多个可学习的表示子空间，但头数增加并不保证质量单调提升。

论文中的原话是：

> Multi-head attention allows the model to jointly attend to information from **different representation subspaces** at different positions.

没有多头，模型只能挤在**一个大空间**里，所有信息混在一起，学不细。

那么可能有人要问：我把单头维度弄大一点不行吗？

不行，原因很简单：大维度单头依然只有一个视角且训练更不稳定。

下面给出标准的多头注意力的 Pytorch 实现代码：

```python
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch import Tensor

class MultiHeadAttention(nn.Module):
    def __init__(self, d_model: int, n_heads: int, dropout: float=0.1):
        super().__init__()
        assert d_model % n_heads == 0, "d_model 必须能被 n_heads 整除"

        self.d_model = d_model
        self.n_heads = n_heads
        self.d_k = d_model // n_heads

        # QKV 投影
        self.w_q = nn.Linear(d_model, d_model)
        self.w_k = nn.Linear(d_model, d_model)
        self.w_v = nn.Linear(d_model, d_model)

        # 输出投影
        self.w_o = nn.Linear(d_model, d_model)
        self.dropout = nn.Dropout(dropout)

    def forward(
        self, 
        query: Tensor, 
        key: Tensor, 
        value: Tensor, 
        mask: Tensor = None, 
        is_causal: bool = False):
        B, L_q, _ = query.size()
        L_k = key.size(1)
        if value.size(1) != L_k:
            raise ValueError("key 和 value 的序列长度必须一致")

        # 拆多头
        q = self.w_q(query).view(B, L_q, self.n_heads, self.d_k).transpose(1, 2)
        k = self.w_k(key).view(B, L_k, self.n_heads, self.d_k).transpose(1, 2)
        v = self.w_v(value).view(B, L_k, self.n_heads, self.d_k).transpose(1, 2)

        # 核心：FlashAttention-2 内核
        attn_output = F.scaled_dot_product_attention(
            q, k, v, 
            attn_mask=mask,
            dropout_p=self.dropout.p if self.training else 0.0,
            is_causal=is_causal
        )

        # 拼接
        attn_output = attn_output.transpose(1, 2).contiguous().view(B, L_q, self.d_model)
        return self.dropout(self.w_o(attn_output))
```

多头注意力的输入：query、key、value 的输入形状都是 [B, L, d_model]。

第一步先进行投影映射，把输入变为 Q，K，V，让模型学会把原始特征，映射成适合 “查询、匹配、提取信息” 的三种向量。

第二步拆分多头，[B, L, d_model] → [B, L, H, d_k]，把 d_model 切成 H 个小通道，每个头独立学习一种注意力模式。

第三步调整维度顺序，[B, L, H, d_k] → [B, H, L, d_k]，把头放到前面，方便批量做矩阵乘法。现在现在 Q/K/V 都是：[B, H, L, d_k]

第四步进入 scaled_dot_product_attention，得到输出 [B, H, L, d_k]。

第五步把多头拼回去，[B, H, L, d_k] → [B, L, H, d_k]，然后 .contiguous().view(B, L, d_model)，[B, L, H×d_k] → [B, L, d_model]，把多个头学到的信息重新合并成一个完整特征。

第六步融合所有头的信息，输出最终的注意力结果。

以上就是关于多头注意力的相关内容，下面我们来介绍 GQA。

## 分组查询注意力（GQA）

在处理大语言模型（LLM）时，随着序列长度的增加，**KV Cache（键值缓存）** 往往会成为推理速度和显存占用的最大瓶颈。

那么什么是 KV Cache？推理生成时（比如一句字一个字蹦出来）：每生成一个新 token，都要和之前所有 token做注意力，之前的 K、V 每次都重复计算，非常浪费，所以 LLM 会把每一层的 K、V 全部缓存下来，下次直接用，这就是 KV Cache。

现在一共有三种方案：

1. **MHA（原版）**

   - Q 多头

   - K 多头

   - V 多头

     → KV Cache 巨大，推理慢

2. **MQA（Multi-Query Attention）**

   - Q 多头

   - 所有 Q 头共享 1 个 K 头和 1 个 V 头

     → KV Cache 最小，通常有利于 decode；质量变化取决于模型与训练方式

3. **GQA（Grouped-Query Attention）**

   - Q 多头

   - K、V 分成几组，组内共享

     → 原始 GQA 论文的实验中达到接近 MQA 的速度与接近 MHA 的质量，但不是所有部署的固定结论

例如，MHA 使用 32 个 Q 头和 32 个 KV 头；若 GQA 使用 32 个 Q 头、8 个 KV 头，则每 4 个 Q 头共享一个 KV 头，K/V 缓存的头维部分缩小到 MHA 的 1/4。实际端到端加速还取决于 batch、上下文长度、kernel 和其他模型计算。

下面给出完整的 GQA 的 Pytorch 标准实现版本：

```python
import torch
import torch.nn as nn
import torch.nn.functional as F
from torch import Tensor

class GQA(nn.Module):
    def __init__(self, d_model: int, n_heads: int, n_kv_heads: int, dropout: float=0.1):
        super().__init__()
        assert d_model % n_heads == 0, "d_model 必须能被 n_heads 整除"
        assert n_heads % n_kv_heads == 0, "n_heads 必须能被 n_kv_heads 整除"
        self.d_model = d_model
        self.n_heads = n_heads
        self.n_kv_heads = n_kv_heads
        self.head_dim = d_model // n_heads

        self.w_q = nn.Linear(d_model, n_heads * self.head_dim)
        self.w_k = nn.Linear(d_model, n_kv_heads * self.head_dim)  # KV 更少
        self.w_v = nn.Linear(d_model, n_kv_heads * self.head_dim)

        self.w_o = nn.Linear(d_model, d_model)
        self.dropout = nn.Dropout(dropout)

    def forward(self, query, key, value, mask=None, is_causal=False):
        B, L_q, _ = query.shape
        B, L_kv, _ = key.shape

        # Q 是多头
        q = self.w_q(query).view(B, L_q, self.n_heads, self.head_dim).transpose(1,2)
        
        # KV 是少头
        k = self.w_k(key).view(B, L_kv, self.n_kv_heads, self.head_dim).transpose(1,2)
        v = self.w_v(value).view(B, L_kv, self.n_kv_heads, self.head_dim).transpose(1,2)

        attn_output = F.scaled_dot_product_attention(
            q, k, v,
            attn_mask=mask,
            is_causal=is_causal,
            dropout_p=self.dropout.p if self.training else 0.0,
            enable_gqa=True
        )
        # ==========================================================

        attn_output = attn_output.transpose(1,2).contiguous().view(B, L_q, self.d_model)
        return self.dropout(self.w_o(attn_output))
```

注意，在使用上述代码时，Q 的头数必须能够被 KV 的头数整除；具体的硬件、数据类型和后端支持范围应以当前 PyTorch 文档为准。

### 工程化实现

一个更加工程化的版本如下：

```python
class GroupedQueryAttention(nn.Module):
    def __init__(self, d_model: int, n_heads: int, n_kv_heads: int, dropout: float = 0.0):
        super().__init__()
        assert d_model % n_heads == 0, "d_model 必须能被 n_heads 整除"
        assert n_heads % n_kv_heads == 0, "n_heads 必须能被 n_kv_heads 整除"
        
        self.d_model = d_model
        self.n_heads = n_heads
        self.n_kv_heads = n_kv_heads
        self.head_dim = d_model // n_heads
        self.kv_group_num = n_heads // n_kv_heads
        
        self.q_dim = n_heads * self.head_dim
        self.kv_dim = n_kv_heads * self.head_dim
        
        self.qkv_proj = nn.Linear(d_model, self.q_dim + 2 * self.kv_dim, bias=False)
        self.w_o = nn.Linear(d_model, d_model, bias=False)
        
        self.dropout_p = dropout

    def forward(self, x: Tensor, mask: Tensor = None, is_causal: bool = True):
        """
        Args:
            x: 输入张量 [Batch, SeqLen, ModelDim]
            mask: 注意力掩码 [Batch, 1, L_q, L_kv]
            is_causal: 是否使用因果掩码 (自回归生成必备)
        """
        B, L, _ = x.shape

        # 1. 一次性投影并切分 Q, K, V
        qkv = self.qkv_proj(x) # [B, L, q_dim + 2*kv_dim]
        q, k, v = torch.split(qkv, [self.q_dim, self.kv_dim, self.kv_dim], dim=-1)

        # 2. 调整形状以适配 SDPA (B, H, L, D)
        q = q.view(B, L, self.n_heads, self.head_dim).transpose(1, 2)
        k = k.view(B, L, self.n_kv_heads, self.head_dim).transpose(1, 2)
        v = v.view(B, L, self.n_kv_heads, self.head_dim).transpose(1, 2)

        # 3. 注意力计算
        attn_output = F.scaled_dot_product_attention(
            q, k, v,
            attn_mask=mask,
            dropout_p=self.dropout_p if self.training else 0.0,
            is_causal=is_causal,
            enable_gqa=True  
        )

        # 4. 合并多头并输出投影
        # [B, H, L, D] -> [B, L, H, D] -> [B, L, ModelDim]
        attn_output = attn_output.transpose(1, 2).contiguous().view(B, L, self.d_model)
        
        return self.w_o(attn_output)
```

其实当前主流大语言模型的注意力机制通常采用 GQA 结构，并结合 RoPE 进行位置编码，同时在推理阶段引入 KV Cache 以降低复杂度，底层通过 FlashAttention 等高效 kernel 实现加速。

后续将会详细介绍位置编码相关内容！
