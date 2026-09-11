---
date: 2025-07-10
category: llm
title: SwiGLU：门控前馈网络
---

# SwiGLU：门控前馈网络

SwiGLU 是 Gated Linear Unit（GLU，门控线性单元）家族中的重要变体，由 Noam Shazeer 在 2020 年的 *GLU Variants Improve Transformer* 中系统提出并验证，后来被 PaLM、LLaMA 等模型采用。GPT-3 使用的则是 GELU，而不是 SwiGLU。

在神经网络前向传播过程中，激活函数的核心作用是为网络引入**非线性特性**——若没有激活函数，无论网络有多少层，最终都等价于单一线性变换，无法拟合复杂的非线性数据分布。

## 从传统激活函数到 GLU

传统激活函数的应用形式（通用线性-激活-线性结构）可表示为：

$$
y = \mathrm{Activation}(xW_1 + b_1)W_2 + b_2
$$

其中，$W_1, W_2$ 为可学习权重矩阵，$b_1, b_2$ 为可学习偏置项；$\mathrm{Activation}$ 为激活函数，常见的有 ReLU、GELU、Sigmoid 等。这种结构的局限性在于，激活函数对输入的“筛选作用”相对单一，无法灵活控制特征的传递强度。

GLU 家族通过一个分支调制另一个分支，引入逐元素的乘法交互。它为模型提供了比单路激活更灵活的表示方式，但并不保证一定丢弃冗余信息或提高所有任务的效率。标准 GLU 可写为：

$$
\mathrm{GLU}(X) = (xW_1 + b_1) \odot \sigma(xW_2 + b_2)
$$

公式说明：

- $x$：输入向量（或矩阵，对应批量输入）；
- $W_1, W_2$：两路独立的可学习权重矩阵，$b_1, b_2$：对应两路的可学习偏置；
- $\odot$：Hadamard 积（逐元素相乘），即两个同维度向量/矩阵，对应位置元素相乘；
- $\sigma$：门控激活函数，标准 GLU 中使用 Sigmoid 函数，这是门控机制的核心。

Sigmoid 是一种经典的 S 型激活函数，核心作用是将输入值映射到 $[0,1]$ 区间，输出值可理解为“门控的开启程度”——输出越接近 1，对应特征分支的信息保留越多；越接近 0，信息保留越少。Sigmoid 函数公式：

$$
S(x) = \frac{1}{1 + e^{-x}}
$$

函数特性：光滑、严格单调、饱和（输入趋于 $+\infty$ 时输出趋近于 1，输入趋于 $-\infty$ 时输出趋近于 0），但存在梯度消失问题（输入绝对值过大时，导数趋近于 0）。

## SwiGLU 的核心改进

常见 GLU 变体主要区别在其中一路所用的激活函数，例如 ReGLU、GEGLU 与 SwiGLU；具体论文和代码在两路命名、偏置与缩放上可能采用不同约定。

SwiGLU 用 **Swish 函数**替代标准 GLU 中的 Sigmoid 门。Swish 的正半轴不饱和，能缓解 Sigmoid 在饱和区梯度很小的问题，但不能笼统地说它“解决了梯度消失”。

$$
\mathrm{SwiGLU}(X) = (xW_1 + b_1) \odot \mathrm{Swish}(xW_2 + b_2)
$$

Swish 函数是由 Google 提出的一种自适应激活函数，兼具 ReLU 的非饱和特性和 Sigmoid 的光滑特性，其公式为：

$$
\mathrm{Swish}(x) = x \cdot \sigma(x) = \frac{x}{1 + e^{-x}}
$$

函数特性：

- 非饱和性：当 $x > 0$ 时，函数值随 $x$ 增大而单调递增，无上限，可缓解梯度消失；
- 光滑性：整体曲线连续可导，优于 ReLU 的分段不可导（$x=0$ 处）；
- 自适应性：输出值与输入 $x$ 相关，不同输入对应不同的“激活强度”，更贴合特征的动态变化。

工程实现常把两路线性投影拼成一次较宽的矩阵乘法，再沿通道维切成两路。这是融合计算，不是取消两组独立参数：拼接矩阵仍等价于 $W_1$ 与 $W_2$。

$$
\mathrm{SwiGLU}(x) = a \odot \mathrm{Swish}(b)
$$

其中，$xW + b = \mathrm{Concat}(a, b)$，$W$ 为单一权重矩阵，$a$ 为特征分支，$b$ 为门控分支（经过 Swish 激活）。

## 工程特点与应用

SwiGLU 主要用于 Transformer 的 Feed-Forward Network（FFN）层。与参数量匹配的普通 FFN、ReGLU 或 GEGLU 相比，质量和速度取决于隐藏维度、硬件与 kernel，不能仅由激活函数断言谁一定更快。PaLM 和 LLaMA 使用 SwiGLU；GPT-3 使用 GELU。

## PyTorch 实现

SwiGLU 的 PyTorch 实现如下：

```python
import torch
import torch.nn as nn

class SwiGLU(nn.Module):
    def __init__(self, input_dim, output_dim):
        super().__init__()
        self.linear1 = nn.Linear(input_dim, output_dim)
        self.linear2 = nn.Linear(input_dim, output_dim)
        self.output = nn.Linear(output_dim, input_dim)
        self.swish = lambda x: x * torch.sigmoid(x)

    def forward(self, x):
        feature_branch = self.linear1(x)
        gate_branch = self.swish(self.linear2(x))
        return self.output(feature_branch * gate_branch)
```

这个示例展示的是完整 FFN 的“门控投影 → 输出投影”结构。实际大模型通常还会调整中间维度并省略 bias，以控制参数量。

参考：[GLU Variants Improve Transformer](https://arxiv.org/abs/2002.05202)。
