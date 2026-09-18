---
id: pytorch-ops
date: 2026-04-30
category: other
title: PyTorch 高频核心算子
---

# PyTorch 高频核心算子

这份笔记记录 PyTorch 中常见的张量操作。下面用三类操作建立基础地图：

```
形状操作（view/permute）
+
线性代数（matmul）
+
mask + softmax（attention）
```

## 1. 张量形状操作（view、reshape、flatten）

   理解 Tensor 视图时，最重要的是 storage（底层存储）、shape（逻辑形状）、stride（步长）和 storage offset。`view` 只改变张量的解释方式；`reshape` 和 `flatten` 会尽量返回视图，无法满足时可能复制数据。

   view 是纯视图变换，定义如下：

   ```python
   x = x.view(new_shape)
   ```

   `view` 不拷贝内存，但要求新形状与原张量的 size/stride 兼容。连续张量通常满足这一条件；部分非连续张量也可能支持某些 `view`，因此“必须连续”是便于记忆但不完全精确的说法。例如：

   ```python
   x = torch.arange(6)
   print(x)
   x = x.view(2, 3)
   print(x)
   
   # 输出如下：
   tensor([0, 1, 2, 3, 4, 5])
   tensor([[0, 1, 2],
           [3, 4, 5]])
   ```

   `permute`、`transpose` 之后的张量通常不连续，很多目标形状不能直接 `view`。连续性更准确地说，是张量的 stride 符合所选 memory format 的连续布局。例如一个张量：

   ```python
   tensor([[0, 1, 2],
           [3, 4, 5]])
   ```

   底层内存是连续的一排：[0,1,2,3,4,5]，逻辑上 0 旁边是 1，内存里 0 旁边也是 1，所以是连续的。如果我们做了 transpose（转置），转置后的逻辑形状变为：

   ```python
   tensor([[0, 3],
           [1, 4],
           [2, 5]])
   ```

   底层 storage 没变，仍是 `[0,1,2,3,4,5]`，但转置后的 stride 发生了变化。对无 size-1 维的标准 contiguous format，可以用下面的递推关系理解连续布局；实际还要考虑 size 为 1 的维度、offset 和 channels-last 等其他 memory format：
   $$
   \text{stride}[i] = \text{stride}[i+1] \times \text{size}[i+1]
   $$
   reshape 可以看作是一个安全版的 view，定义如下：

   ```python
   x = x.reshape(new_shape)
   ```

   `reshape` 会在可能时返回视图，否则复制出兼容布局；调用方不应依赖它一定共享 storage。它仍可能因为元素数量不匹配等原因报错。需要明确强制连续副本时使用 `x.contiguous()`，需要确认是否共享存储时应直接检查，而不要根据 API 名称猜测。例如：

   ```python
   x = torch.arange(6)
   print(x)
   
   x = x.view(2, 3)
   print(x)
   
   x = x.transpose(0, 1)   # 内存不连续
   print(x)
   
   y = x.contiguous()      # 内存连续
   print(y)
   
   z = y.view(3, 2)        # 内存连续才能改变形状
   print(z)
   
   # 输出：
   tensor([0, 1, 2, 3, 4, 5])
   tensor([[0, 1, 2],
           [3, 4, 5]])
   tensor([[0, 3],
           [1, 4],
           [2, 5]])
   tensor([[0, 3],
           [1, 4],
           [2, 5]])
   tensor([[0, 3],
           [1, 4],
           [2, 5]])
   ```

   工程上通常优先用表达意图最清楚的 API：能保证布局兼容且必须零拷贝时使用 `view`；允许实现自行选择视图或副本时使用 `reshape`；只有下游算子确实要求连续布局时才调用 `contiguous()`。`contiguous().view(...)` 会在必要时产生复制，并不天然比 `reshape` 更快。

   `flatten` 用于把指定范围的维度合并。根据布局，它可能返回原对象、视图或副本，不能一概认为只修改 stride。最简单用法：

   ```python
   x = torch.randn(2, 3, 4)    # shape: [2, 3, 4]
   y = x.flatten()            	# shape: [24]
   ```

   等价于：

   ```python
   y = x.reshape(-1)			# shape: [24]
   ```

   在神经网络中，最常用、最重要的用法：

   ```python
   x.flatten(start_dim=1)
   ```

   意思是从第 1 维开始向后合并，第 0 维保持不动。在常见神经网络输入中第 0 维是 batch，因此通常保留；是否能压扁取决于具体任务，而不是 API 限制。

   ```python
   x = torch.randn(32, 128, 7, 7)  # [batch, channel, H, W]
   x = x.flatten(start_dim=1)      # [32, 128*7*7] = [32, 6272]
   ```

   这就是CNN 全连接层前的标准操作。

## 2. 张量操作（unsqueeze / squeeze）

   这两个算子专门用来增加 / 删除 “长度 = 1” 的维度，是维度对齐、广播、拼接的必备工具。

   - unsqueeze = 加一维（size=1）
   - squeeze   = 删一维（size=1）

   例如：

   ```python
   import torch
   
   x = torch.randn(3)      # shape: [3]
   y = x.unsqueeze(0)      # 在第0维加一维
   z = x.unsqueeze(1)      # 在第1维加一维
   
   print(y.shape)  # [1, 3]
   print(z.shape)  # [3, 1]
   
   x = torch.randn(1, 3, 1)   	# shape: [1, 3, 1]
   y = x.squeeze()             # 删掉所有 size=1 的维度
   
   print(y.shape)  # [3]
   
   x = torch.randn(1, 3, 1)
   y = x.squeeze(0)   # 只删第0维
   print(y.shape)     # [3, 1]
   ```

## 3. 张量操作（permute / transpose）

   `transpose` 交换两个维度，`permute` 重排所有维度。二者返回共享底层存储的视图，通常只改变 stride；结果常常不连续，但交换 size-1 维或做恒等排列等情况可能仍然连续。

   ```python
   import torch
   # transpose
   x = torch.randn(2, 3, 4)  # shape [2,3,4]
   y = x.transpose(1, 2)     # 交换 1、2 维
   print(y.shape)            # [2,4,3]
   
   # permute
   x = torch.randn(2, 3, 4)  	# [B, C, D]
   y = x.permute(1, 0, 2)     	# 重排：原来1维、0维、2维
   print(y.shape)             	# [3,2,4]
   ```

   深度学习经典通道变换：

   ```python
   # NCHW -> NHWC
   # [B, C, H, W] → [B, H, W, C]
   x.permute(0, 2, 3, 1)
   ```

## 4. 拼接与拆分（cat、stack、split、chunk）

   torch.cat() 在现有维度上拼接，维度数量不变，只在某一维上变长。拼接维度的长度相加，其他维度必须完全相同。

   ```python
   a = torch.randn(3, 4)
   b = torch.randn(3, 4)
   
   c = torch.cat([a, b], dim=0)  # 在第0维拼接
   print(c.shape)  # (6, 4)
   
   d = torch.cat([a, b], dim=1)  # 在第1维拼接
   print(d.shape)  # (3, 8)
   ```

   `torch.stack()` 新增一个维度，把多个同形状张量沿新维堆叠。新维可以表示 batch，也可以表示时间、视角或其他语义；所有输入 shape 必须完全一致。

   ```python
   a = torch.randn(3, 4)
   b = torch.randn(3, 4)
   
   c = torch.stack([a, b], dim=0)
   print(c.shape)  # (2, 3, 4)
   ```

   `torch.split()` 按指定大小切分张量。参数既可以是统一的块大小，也可以是各块大小组成的列表；使用统一块大小时，最后一块可以更短。

   ```python
   x = torch.arange(10)

   parts = torch.split(x, 4)
   print([part.shape for part in parts])
   # [torch.Size([4]), torch.Size([4]), torch.Size([2])]

   parts = torch.split(x, [3, 2, 5])
   print([part.shape for part in parts])
   # [torch.Size([3]), torch.Size([2]), torch.Size([5])]
   ```

   `torch.chunk()` 尝试把张量切成指定数量的块；当该维度长度较小时，实际返回的块数可能少于请求值。需要严格控制每块大小时，优先使用 `split`。

   ```python
   x = torch.arange(10)
   parts = torch.chunk(x, 3)
   print([part.shape for part in parts])
   # [torch.Size([4]), torch.Size([4]), torch.Size([2])]
   ```

   `split` 和 `chunk` 返回的张量通常是原张量的视图；对它们做原地修改时要留意共享存储带来的影响。
