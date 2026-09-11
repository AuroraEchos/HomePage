---
date: 2025-09-18
category: llm
title: LoRA & QLoRA
---

# LoRA 与 QLoRA：从低秩适配到 4-bit 微调

LoRA 对应论文 **LoRA: Low-Rank Adaptation of Large Language Models**，最早于 2021 年发布，后发表于 ICLR 2022，核心作者来自微软等机构。

QLoRA 对应论文 **QLoRA: Efficient Finetuning of Quantized LLMs**，发表于 NeurIPS 2023，核心作者来自华盛顿大学。

这两项工作解决的是同一个大问题：**如何在不更新完整大模型参数的前提下，高效地完成下游任务适配**。其中 LoRA 主要降低可训练参数量和训练显存开销；QLoRA 则进一步把冻结的基座模型压缩到 4-bit 存储，使单卡微调更大规模的模型成为可能。

---

## 1. 场景定义：自回归语言模型的下游任务适配

考虑一个自回归语言模型：

$$
P_\Phi(y \mid x)
$$

其中 $\Phi$ 是模型全部参数，$x$ 是输入提示词或上下文，$y$ 是模型需要生成的输出。典型下游任务包括：

1. **摘要任务**：$x$ 是文章，$y$ 是摘要；
2. **NL2SQL 任务**：$x$ 是自然语言查询，例如“查询今年销售额前十的商品”，$y$ 是对应的 SQL 语句，例如 `SELECT ... ORDER BY ... LIMIT 10`。

给定训练数据集 $\mathcal{Z}=\{(x_i,y_i)\}$，标准的自回归训练目标通常是最大化条件对数似然：

$$
\max_{\Phi} \sum_{(x,y) \in \mathcal{Z}} \sum_{t=1}^{|y|}
\log P_{\Phi}(y_t \mid x, y_{<t})
$$

含义是：在给定输入 $x$ 和已经生成的前缀 $y_{<t}$ 时，让模型尽可能提高正确下一个 token $y_t$ 的概率。

---

## 2. 全量微调的问题

在全量微调中，我们从预训练权重 $\Phi_0$ 出发，通过训练得到新的参数：

$$
\Phi = \Phi_0 + \Delta \Phi
$$

这里 $\Delta\Phi$ 表示下游任务带来的参数更新量。全量微调的问题在于：

- **训练成本高**：所有参数都要参与梯度计算和优化器更新；
- **显存占用高**：除了模型权重，还需要保存梯度、优化器状态和中间激活；
- **多任务部署成本高**：如果每个任务都保存一个完整 checkpoint，那么每个任务都近似需要一份完整模型参数。

以 GPT-3 175B 这类模型为例，如果分别对“摘要”和“NL2SQL”训练两个完整微调模型，部署时通常要额外保存两份 175B 级别的模型权重。即使只保存参数差分，差分张量的维度也仍然与原模型一致。因此，全量微调在大模型时代很难作为低成本的通用适配方案。

---

## 3. 参数高效微调：只训练一个小的任务补丁

参数高效微调（Parameter-Efficient Fine-Tuning, PEFT）的核心思想是：**冻结大部分预训练参数，只训练一小部分新增参数**。

可以把下游任务的参数增量写成：

$$
\Delta \Phi = \Delta \Phi(\Theta), \qquad |\Theta| \ll |\Phi_0|
$$

其中 $\Theta$ 是一个远小于原模型参数规模的可训练参数集合。优化目标变为：

$$
\max_{\Theta} \sum_{(x,y) \in \mathcal{Z}} \sum_{t=1}^{|y|}
\log P_{\Phi_0 + \Delta \Phi(\Theta)}(y_t \mid x, y_{<t})
$$

训练时，基座模型 $\Phi_0$ 被冻结，不作为优化器更新对象；只有 $\Theta$ 被训练。这样最终保存的不是一个完整模型，而是一个很小的 **adapter / 参数补丁**。

LoRA 就是 PEFT 中最经典的一类方法。

---

## 4. LoRA 的核心思想：用低秩矩阵表示权重增量

LoRA 的直觉来自一个经验观察：大模型在适配下游任务时，完整参数更新 $\Delta W$ 虽然维度很高，但有效变化可能集中在一个低维子空间中。换句话说，更新矩阵可能具有较低的“内在秩”（intrinsic rank）。

考虑 Transformer 中某个线性层的权重矩阵：

$$
W_0 \in \mathbb{R}^{d \times k}
$$

全量微调会直接更新 $W_0$，得到：

$$
W = W_0 + \Delta W
$$

LoRA 不直接训练完整的 $\Delta W \in \mathbb{R}^{d \times k}$，而是用两个低秩矩阵来分解它：

$$
\Delta W = BA
$$

其中：

$$
A \in \mathbb{R}^{r \times k}, \qquad
B \in \mathbb{R}^{d \times r}, \qquad
r \ll \min(d,k)
$$

于是线性层的前向传播从：

$$
h = W_0 x
$$

变为：

$$
h = W_0x + BAx
$$

在实际实现中通常还会加入缩放系数：

$$
h = W_0x + \frac{\alpha}{r}BAx
$$

其中 $r$ 是 LoRA rank，$\alpha$ 是缩放超参数。$\alpha/r$ 的作用是控制 LoRA 分支的更新幅度，使不同 rank 下的更新尺度更稳定。

---

## 5. LoRA 的参数量为什么小

原始矩阵 $W_0$ 的参数量是：

$$
dk
$$

LoRA 新增的可训练参数量是：

$$
rk + dr = r(d+k)
$$

当 $r \ll \min(d,k)$ 时，LoRA 参数量远小于完整矩阵。

例如对于一个 $4096 \times 4096$ 的线性层：

- 全量更新参数量：

$$
4096 \times 4096 = 16,777,216
$$

- 若 LoRA rank $r=8$，则新增参数量：

$$
8 \times (4096 + 4096) = 65,536
$$

只相当于原矩阵参数量的约 $0.39\%$。

这也是 LoRA 能显著降低可训练参数量和优化器状态显存的根本原因。

---

## 6. LoRA 的初始化方式

LoRA 通常采用如下初始化：

- $A$ 使用随机高斯初始化；
- $B$ 初始化为全零矩阵。

因此训练开始时：

$$
\Delta W = BA = 0
$$

初始模型等价于原始预训练模型：

$$
h = W_0x
$$

这样做的好处是训练从原模型行为平稳开始，不会因为新增分支的随机输出破坏模型初始分布。

---

## 7. LoRA 的优势与边界

LoRA 的主要优势包括：

1. **可训练参数少**  
   只训练低秩矩阵 $A$ 和 $B$，显著减少梯度和优化器状态开销。

2. **任务切换成本低**  
   不同任务可以保存不同的 LoRA adapter。部署时只需要加载对应 adapter，而不需要加载完整模型副本。

3. **可合并到原权重中**  
   微调完成后可以把 LoRA 权重合并到基座权重：

   $$
   W_{\text{merged}} = W_0 + \frac{\alpha}{r}BA
   $$

   合并后推理只需要执行一次普通线性层计算：

   $$
   h = W_{\text{merged}}x
   $$

   因此在 **合并部署** 的场景下，LoRA 不引入额外推理延迟。

4. **表达能力可随 rank 增强**  
   $\Delta W=BA$ 的秩最多为 $r$。提高 $r$ 可以提高更新矩阵的表达能力。当 $r$ 足够大时，理论上可以表达更复杂的权重更新。

需要注意几个边界条件：

- LoRA 的“零额外推理延迟”成立于 **adapter 已经合并进权重** 的场景；如果推理时动态挂载 LoRA 分支，则仍然会有额外计算。
- LoRA 不保证在所有任务上都等价于全量微调；性能取决于任务、数据、rank、目标层选择和训练超参数。
- 如果把 rank 提高到接近完整矩阵秩，LoRA 的参数效率优势会下降，甚至可能不再划算。

---

## 8. LoRA 在 Transformer 中通常作用在哪些层

一个标准 Transformer block 通常包含：

- Self-Attention 中的投影矩阵：$W_q, W_k, W_v, W_o$；
- MLP / FFN 中的上投影、下投影，有些结构中还有 gate projection；
- LayerNorm、bias 等其他参数。

LoRA 原论文中的经典配置主要把 LoRA 加到 Attention 的部分投影矩阵上，尤其是 $W_q$ 和 $W_v$。后续开源实践中，常见配置包括：

- 只作用于 `q_proj`、`v_proj`：参数最省，经典默认配置；
- 作用于 `q_proj`、`k_proj`、`v_proj`、`o_proj`：适配能力更强；
- 作用于 Attention + MLP 的所有线性层：参数更多，但通常更适合高质量指令微调，QLoRA 论文也强调了 all linear layers 对恢复 16-bit 性能的重要性。

因此，目标层选择是 LoRA/QLoRA 实践中非常关键的超参数。

---

## 9. QLoRA 的动机：LoRA 省的是训练参数，不是基座模型本身

LoRA 只训练少量 adapter 参数，但基座模型 $\Phi_0$ 通常仍然以 FP16/BF16 形式常驻显存。对于 33B、65B 这类模型，仅加载基座模型就需要很高显存。

QLoRA 的核心目标是进一步降低基座模型的显存占用：

> 将冻结的预训练模型权重量化为 4-bit 存储，同时仍然通过 LoRA adapter 进行高精度训练。

也就是说：

- 基座模型：冻结，4-bit NF4 存储；
- LoRA adapter：可训练，通常使用 BF16/FP16；
- 前向和反向计算：需要时将 4-bit 权重反量化到 BF16/FP16 参与矩阵乘法；
- 参数更新：只更新 LoRA adapter，不更新 4-bit 基座权重。

QLoRA 的关键贡献包括：

1. **NF4（NormalFloat 4-bit）量化格式**；
2. **Double Quantization（双重量化）**；
3. **Paged Optimizers（分页优化器）**。

---

## 10. NF4：面向正态分布权重的 4-bit 量化格式

量化的本质是把高精度连续值映射到低 bit 离散值。它是有损压缩，不是数学意义上的无损压缩。

传统均匀 4-bit 量化会把数值范围均匀切成 16 个区间。但神经网络权重通常近似集中在 0 附近，呈零均值、类正态分布。若仍然使用均匀量化，会出现两个问题：

- 0 附近有大量权重，却只有有限几个量化 bin 表示，误差较大；
- 分布尾部样本较少，却占用了一些量化区间。

NF4 的核心思想是：**不要在数值轴上均匀划分，而是按照正态分布的分位数来划分**，使每个量化 bin 在理论上接收近似相同数量的权重值。

对于 $k$ bit 的 NormalFloat，可以从标准正态分布 $\mathcal{N}(0,1)$ 的分位数函数 $Q_X(\cdot)$ 构造量化点。简化形式可以写为：

$$
q_i = \frac{1}{2}\left(
Q_X\left(\frac{i}{2^k+1}\right) +
Q_X\left(\frac{i+1}{2^k+1}\right)
\right)
$$

其中 $Q_X(\cdot)$ 是标准正态分布的分位数函数。实际 NF4 还会做一个重要修正：为了精确表示 0，会采用非完全对称的 codebook，并合并正负两侧重复的零点。

因此，NF4 可以理解为一种 **为零均值正态分布权重设计的非均匀 4-bit 数据类型**。它不能让量化误差消失，但相比普通 INT4/FP4，在大模型权重量化上通常能保留更多有效信息。

---

## 11. Double Quantization：继续压缩量化常数

低 bit 量化通常不是直接对整个大矩阵使用同一个缩放系数，而是采用 block-wise quantization。假设每 64 个权重为一个 block，每个 block 共享一个缩放系数。

如果每个 block 的缩放系数都用 FP32 保存，那么缩放系数本身也会带来显著额外开销：

$$
\text{Cost}_{\text{scale}} = \frac{32}{64} = 0.5 \ \text{bit/parameter}
$$

QLoRA 的 Double Quantization 进一步对这些缩放系数再做一次量化。具体地：

- 一级：模型权重以 4-bit NF4 存储，每 64 个权重共享一个量化常数；
- 二级：一级量化常数再被量化为 8-bit，且每 256 个一级 block 共享一个二级 FP32 常数。

双重量化后的平均缩放开销为：

$$
\text{Cost}_{\text{double}} = \frac{8}{64} + \frac{32}{64 \times 256}
$$

计算得：

$$
\text{Cost}_{\text{double}} = 0.125 + 0.001953125 \approx 0.127 \ \text{bit/parameter}
$$

相比原来的 $0.5$ bit/parameter，节省：

$$
0.5 - 0.127 = 0.373 \approx 0.37 \ \text{bit/parameter}
$$

因此，更准确的说法是：**Double Quantization 将量化常数的平均额外开销从 0.5 bit/parameter 降低到约 0.127 bit/parameter，平均节省约 0.37 bit/parameter**。

---

## 12. Paged Optimizers：缓解训练过程中的显存峰值

QLoRA 的另一个工程贡献是分页优化器（Paged Optimizers）。

在长序列或较大 batch 训练时，即使平均显存占用可控，也可能因为某些时刻的激活、梯度或优化器状态峰值触发 `CUDA out of memory`。Paged Optimizers 利用 NVIDIA Unified Memory，把优化器状态放在可分页内存中：

- 当 GPU 显存紧张时，部分优化器状态可以被换出到 CPU 内存；
- 当优化器更新需要这些状态时，再换入 GPU 显存。

这可以缓解梯度检查点、长序列训练等场景中的显存尖峰。

但它不是“无限显存”，也不能保证任何配置都不 OOM。若模型、序列长度、batch size 或系统内存配置过于激进，仍然可能失败；而且频繁 CPU-GPU 换页也可能带来吞吐下降。

---

## 13. QLoRA 的前向与反向传播流程

以单个线性层为例，QLoRA 的计算过程可以概括为：

1. **静态存储**  
   基座权重 $W_0$ 以 4-bit NF4 存储，LoRA 矩阵 $A,B$ 以 BF16/FP16 存储。

2. **动态反量化**  
   当该层参与计算时，4-bit 权重按需反量化到 BF16/FP16 计算类型。

3. **主干计算**  
   使用反量化后的基座权重计算：

   $$
   W_0x
   $$

4. **LoRA 分支计算**  
   使用高精度 LoRA 参数计算：

   $$
   \frac{\alpha}{r}BAx
   $$

5. **输出相加**  
   得到最终输出：

   $$
   h = W_0x + \frac{\alpha}{r}BAx
   $$

6. **反向传播**  
   梯度会穿过冻结的量化基座模型传到 LoRA 分支，但参数更新只发生在 $A$ 和 $B$ 上。基座权重 $W_0$ 不被更新。

7. **存储保持低精度**  
   反量化权重只是计算时的临时表示，基座模型常驻存储仍然是 4-bit。

因此，QLoRA 可以理解为：**用 4-bit 存储降低基座模型显存，用 16-bit LoRA adapter 保持训练可塑性**。

---

## 14. LoRA 与 QLoRA 对比

| 维度 | LoRA | QLoRA |
|---|---|---|
| 基座模型存储 | 通常 FP16/BF16 | 4-bit NF4 |
| 基座模型是否更新 | 冻结 | 冻结 |
| 可训练参数 | LoRA adapter | LoRA adapter |
| Adapter 精度 | 通常 FP16/BF16 | 通常 FP16/BF16 或 BF16 |
| 主要节省对象 | 可训练参数、梯度、优化器状态 | 进一步节省基座模型权重显存 |
| 核心技术 | 低秩分解 $\Delta W=BA$ | NF4 + Double Quantization + Paged Optimizers + LoRA |
| 推理延迟 | 合并后无额外延迟 | 若保持量化推理，需要量化 kernel；若合并到高精度权重，则需要先反量化/合并 |
| 典型目标层 | 原论文常用 $W_q,W_v$；实践中可扩展到更多线性层 | 通常更倾向于覆盖所有线性层以弥补量化损失 |
| 适用场景 | 显存相对充足，但不想全量微调 | 显存受限，需要微调更大基座模型 |

---

## 15. 实践建议

如果做普通 LoRA/QLoRA 微调，可以优先关注以下超参数：

1. **target_modules**  
   小成本尝试可以从 `q_proj`、`v_proj` 开始；追求更高性能时可以覆盖 Attention 和 MLP 中的所有线性层。

2. **rank $r$**  
   常见取值包括 4、8、16、32、64。rank 越大，表达能力越强，但参数量和显存也更高。

3. **$\alpha$**  
   常见设置为 8、16、32、64。实践中常令 $\alpha$ 与 $r$ 同量级或略大。

4. **LoRA dropout**  
   小数据集上可以加入适度 dropout 防止过拟合；大规模指令数据上不一定需要较高 dropout。

5. **是否合并权重**  
   单任务部署可以 merge adapter；多任务动态切换时可以保留 adapter 形式。

6. **QLoRA compute dtype**  
   支持 BF16 的硬件上通常优先使用 BF16；否则使用 FP16。

---

## 16. 常见误区总结

1. **QLoRA 不是无损压缩**  
   4-bit 量化必然有信息损失；QLoRA 的贡献是让这种损失在很多微调场景中几乎不影响最终任务性能。

2. **LoRA 的零延迟依赖合并部署**  
   如果 LoRA 分支没有合并，推理时仍然需要额外矩阵乘法。

3. **Paged Optimizers 不是无限显存**  
   它缓解显存峰值，不改变模型和训练配置的基本内存下界。

4. **只调 $W_q,W_v$ 不一定总是最佳**  
   这是 LoRA 原论文和早期开源实践中的经典配置，但 QLoRA 论文发现，在量化微调中覆盖所有线性层对于恢复 16-bit 性能很关键。

5. **rank 越大不一定越好**  
   更大的 rank 提升表达能力，但也增加参数量、显存和过拟合风险。实际需要结合任务和数据规模调参。

---

## 17. 小结

LoRA 的核心是：

$$
\Delta W = BA, \qquad r \ll \min(d,k)
$$

它把完整权重更新限制在低秩子空间中，从而显著减少可训练参数量和优化器状态开销。

QLoRA 的核心是：

$$
\text{4-bit frozen base model} + \text{16-bit LoRA adapter}
$$

它在 LoRA 的基础上进一步压缩冻结基座模型，通过 NF4、Double Quantization 和 Paged Optimizers，使大模型微调对显存更加友好。

简单概括：

- **LoRA 解决的是“不要训练完整模型”**；
- **QLoRA 进一步解决的是“连冻结的基座模型也不要用高精度存储”**。

---

## 参考资料

1. Edward J. Hu et al., [LoRA: Low-Rank Adaptation of Large Language Models](https://arxiv.org/abs/2106.09685), 2021 / ICLR 2022.
2. Tim Dettmers et al., [QLoRA: Efficient Finetuning of Quantized LLMs](https://arxiv.org/abs/2305.14314), 2023 / NeurIPS 2023.
