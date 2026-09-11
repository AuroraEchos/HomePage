---
date: 2025-09-15
category: llm
---

# RMSNorm

RMSNorm（Root Mean Square Layer Normalization，均方根层归一化）是一种比 LayerNorm 更简洁的归一化方法，后来被许多 Transformer 大模型采用。它移除了均值中心化，仅按均方根缩放；原论文在多类任务上观察到与 LayerNorm 相当的效果和一定的计算效率收益，但这不是对所有模型与任务的无条件保证。

## 定义与公式

设输入向量 $x \in \mathbb{R}^d$，$\epsilon$ 为防止除零的小常数，$\gamma$ 为可学习缩放参数：

均方根（RMS）定义：
$$
\text{RMS}_\epsilon(x) = \sqrt{\frac{1}{d}\sum_{i=1}^d x_i^2 + \epsilon}
$$
RMSNorm 前向传播公式：
$$
\text{RMSNorm}(x) = \frac{x}{\text{RMS}_\epsilon(x)} \odot \gamma
= \frac{x}{\sqrt{\mathbb{E}[x^2]+\epsilon}} \odot \gamma
$$

## 与 LayerNorm 的区别

LayerNorm 公式：
$$
\text{LayerNorm}(x) = \frac{x-\mathbb{E}[x]}{\sqrt{\text{Var}(x)+\epsilon}} \cdot \gamma + \beta
$$
从上述两个公式可以直观的看出差异：

- RMSNorm：无均值减法；常见实现只有可学习缩放 $\gamma$，不使用 $\beta$
- LayerNorm：中心化 + 标准化 + 偏置

忽略 $\gamma$ 时，RMS 缩放只是给整个向量乘一个标量，不改变方向；实际层中的逐维 $\gamma$ 仍可能改变方向。RMSNorm 的直接优势是少计算一次均值与中心化，而它是否比 LayerNorm 更稳定或更快，需要结合模型结构和具体实现评估。

RMSNorm 已被 LLaMA 等许多现代大模型采用，但 LayerNorm 仍然广泛存在。

## PyTorch 实现

RMSNorm 的标准 Pytorch 实现如下：

```python
import torch
import torch.nn as nn

class RMSNorm(nn.Module):
    def __init__(self, hidden_size: int, eps: float = 1e-6):
        super().__init__()
        self.eps = eps
        # 仅使用可学习缩放参数 gamma，无 beta
        self.weight = nn.Parameter(torch.ones(hidden_size))

    def _norm(self, x):
        # 计算均方根：1 / sqrt(E[x²] + eps)
        return x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + self.eps)

    def forward(self, x):
        # 先做归一化，再乘以可学习权重
        output = self._norm(x.float()).type_as(x)
        return output * self.weight
```
