---
date: 2026-08-18
category: other
title: 《A Programming Paradigm for Spatiotemporal Composability》阅读分析
---

# 《A Programming Paradigm for Spatiotemporal Composability》阅读分析

> 作者：Yifan Shi、Wei Zhang、Tianyi Cui  
> 单位：北京大学、DeepSeek-AI  
> 报告撰写日期：2026 年 8 月 18 日  
> 版本提示：论文明确标注为持续修订中的预印本；以下判断只针对当前 PDF。

## 一、结论先行

这篇论文提出的不是一个单独的插件 API，而是一套解释“运行中的软件如何安全地增、删、换组件”的统一模型。作者把问题拆成两个正交维度：

- **时间可组合性（temporal composability）**：组件卸载后，它在共享环境中留下的影响能否被完整撤销；
- **空间可组合性（spatial composability）**：组件能否声明依赖，并在依赖出现、消失或更换提供者时自动调整生命周期。

论文的中心思想是把传统上用于静态类型分析的 effect/coeffect 转成运行时实体：effect 不再只是“这段代码会做什么”的注解，而是一次状态变换及其逆操作；coeffect 不再只是“这段代码需要什么”的注解，而是运行时可解析、可监听的依赖规范。二者统一到一个 context 中，再由 component/fiber 生命周期演算处理多组件交错、异步、失败和撤回。

我的总体判断是：**论文最有价值的贡献是给动态组件系统建立了一套相当完整的语义骨架，并把“卸载清理”和“依赖重连”证明为同一套 context 纪律的两个方向。**其理论设计具有原创性和工程启发性，特别是“提供者先停止对外提供、等待消费者完成 teardown、最后再撤回自身资源”的协议。然而，论文的系统级结论建立在较强的封闭性、可逆性、独立性和无环性假设上；当前实现证据主要是设计映射与单一生态案例，尚无机械化证明、性能数据或 Cordis v4 的直接生产验证。因此，它更像一篇很有潜力的“基础模型 + 参考实现设计”论文，而不是已经充分实证的成熟系统结论。

## 二、论文试图解决什么问题

### 2.1 现有动态组合的粒度错位

插件系统、可热更新服务以及未来的自演化 agent harness 都希望在进程不中断的情况下改变自身组成。但当前常用兜底方案通常停留在进程或容器粒度：组件出问题就重启进程，依赖变化就交给服务编排器。这会丢弃缓存、连接和进行中的计算，也无法自然描述同一地址空间内的细粒度依赖。

论文以 VS Code 扩展为反例：扩展能动态安装，却不能真正从 extension host 中单独卸载可执行代码；`deactivate` 与 `activate` 分离，也使清理是否完整难以验证。对 self-evolving agent harness 而言，问题更严重：如果每次自修改都重启，连续服务和进程内状态无法保留；如果依赖没有结构化表达，模块替换会把失配传播给依赖方。

### 2.2 两个维度不是一回事

论文的重要澄清是：能撤销副作用，并不自动意味着能管理依赖；能解析依赖，也不自动意味着卸载时不会泄漏资源。

| 维度 | 核心问题 | 静态世界中的近似物 | 动态世界新增的困难 |
|---|---|---|---|
| 时间 | 卸载后能否消除组件贡献 | 词法作用域、RAII、bracket | effect 生命周期很长，且与其他组件交错 |
| 空间 | 依赖能否被声明、解析和重连 | 模块 import | provider 会出现、消失或换身份 |

这一区分使论文能够分别提出局部保证，再在第 4 节把它们提升为全局保证。

## 三、形式化核心（一）：可撤销 effect

### 3.1 从状态变换到“状态变换 + 逆操作”

设共享上下文类型为 `Γ`。普通副作用可以重写成状态变换 `Γ → Γ`。论文将可撤销 effect 定义为：

```text
e : Γ → Γ × (Γ → Γ)
```

在状态 `γ` 上执行 `e`，得到新状态 `δ` 和一个逆函数 `g`。见证条件只要求：

```text
g(δ) = γ
```

这是**在本次实际执行点成立的左逆**，而非要求 `g` 是全局双向逆。这个放宽很重要：注册事件监听器时，逆操作只需要删掉本次注册的那个监听器；分配资源时，逆操作可以捕获本次分配得到的句柄，不必事先知道它。

### 3.2 逆操作如何自动组合

effect context 写为：

```text
∂Γ = Γ × (Γ → Γ)
```

第二项是 accumulator，保存已经发生的 effect 的复合逆操作。若先执行 `f₁`、再执行 `f₂`，撤回必须先运行 `g₂`、再运行 `g₁`，即 LIFO。论文用 twisted composition 和 effect composition `⋄` 证明：

- effect 构成带单位元的幺半群；
- 每个原子 effect 只需就地返回自己的逆；
- 复合 effect 的逆由运行时自动组合；
- 若严格按执行顺序的逆序撤回，则每一步都回到前一状态（定理 16）。

这比单独的 `activate/deactivate` 回调更强的地方在于**关注点局部化**：创建资源的代码必须同时交出如何撤销它，组件作者不再另写一个容易遗漏的全局卸载流程。

### 3.3 为什么还需要 effect 独立性

一个真实系统不会总按全局逆序卸载。组件 A 和 B 的 effect 可能交错，而系统可能先移除 A、保留 B。此时 A 的逆操作遇到的已不是 A 刚执行完时的状态。

论文因此定义 effect 独立性，要求两部分：

1. 两个 effect 能产生的所有正向变换和逆向变换彼此可交换；
2. 一方的变换不会改变另一方在某状态上生成的逆操作。

在该前提下，定理 20 与推论 21说明：任一 effect 的逆可以从后续 effect 中“穿过”，只撤掉自己的贡献；一组两两独立的 effect 可以按任意顺序撤回，最终仍回到初态。

这里有一个很值得保留的设计原则：**组件内部的顺序敏感性由本组件的 LIFO accumulator 管理；跨组件的顺序敏感性不能假装成独立 effect，而应显式提升为 coeffect 依赖。**

## 四、形式化核心（二）：反应式 coeffect

### 4.1 类型化依赖表

coeffect context 被建模为依赖键到对应值类型的有限偏函数：

```text
Σ = (k : K) ⇀ Vₖ
```

`set(k, v)` 不只是写入依赖表，也返回删除该绑定的逆操作，所以 `set` 本身就是一个可撤销 effect。由此，“提供依赖”和“以后撤回依赖”被接入同一套 effect 追踪机制。

每个 key 不只携带值类型，还携带：

- 该值的观察等价关系；
- 组件可对该值执行的一组操作；
- 每个操作的参数、结果、状态变换和逆操作。

### 4.2 依赖规范与通知

组件以键集合 `d ⊆ K` 声明依赖。当 `d` 中所有 key 都存在时，状态满足该规范。每一次 context 变化都被分为：

- activating：此前不满足、此后满足；
- deactivating：此前满足、此后不满足；
- neutral：满足性未改变。

因此，组件只在依赖全部存在时激活；依赖丢失时，运行时必然检测到并触发停用。这给出了局部空间可组合性。

论文还引入两种派生 context：

- **isolation**：同一个逻辑 key 在不同 realm 中解析到不同值，适合多租户、测试环境和组件沙箱；
- **interception**：在访问依赖时合并 context 侧与组件侧元数据，适合权限、路径范围、只读约束等横切策略。

二者不直接改写共享表，而是派生子 context；回收时丢弃子 context 即可。

### 4.3 观察等价与 effect 独立性的来源

“恢复到完全相同的物理状态”通常不可能。例如 `free` 后的堆布局不一定与 `malloc` 前逐位相同，新生成的名字也不会倒退。论文因此用 coeffect 可观察操作定义状态等价 `≃`：只要任何允许的测试都无法区分两个状态，它们就算相等。

随后得到两个关键结果：

- 不同 key 上的操作天然独立，因为它们只读写各自绑定（定理 40）；
- 同一 key 若声明为 commutative，则由这些 key 操作构造的两个组件 effect 独立（定理 42）。

这一步是 effect/coeffect 真正“咬合”的位置：coeffect 把共享状态切成有接口、有观察语义的 key；这种空间分割反过来为跨组件 effect 的可交换性提供依据。

## 五、统一 context 是否构成一种编程范式

论文定义自相似 context：

```text
Γ∞ = μΓ. Γ × (Γ → Γ) × Σ
```

它同时包含下层 context、该层 accumulator 和 coeffect 表。加载组件就是在 context 上执行 effect，卸载就是应用 accumulator；父 context 又能承载子 context 的 effect，形成层级化组件树。

作者将其称为一种“context paradigm”，理由是它试图结合两种传统范式的优点：

- 像函数式显式状态传递一样，让 effect 与依赖可追踪、可推理；
- 像命令式/OOP 一样，避免每一层函数都手工传递和拼装状态。

这个定位在工程直觉上成立：它不规定业务领域，只规定所有跨组件交互必须通过 context。不过，`Γ` 在函数空间 `Γ → Γ` 的参数位置出现，是非严格正的递归类型；论文没有给出该递归域方程的构造语义或存在性说明。因此，目前更稳妥的理解是：它是描述运行时层级结构的抽象方程，而不是已经在标准类型论中完成合法性论证的归纳类型。

## 六、动态组合演算

### 6.1 Component、fiber 与 registry

一个 component 是三元组：

```text
(d, p, e)
```

- `d`：需要的 coeffect keys；
- `p`：可能提供的 keys；
- `e`：激活时执行的、带逆操作见证的 effect。

component 的一次运行时实例叫 fiber。fiber 还保存父 fiber、自己的 coeffect 表、退休标记、accumulator、已提交的依赖提供者视图，以及生命周期状态。registry 保存所有 fiber。

基础演算要求不同 fiber 的 `p` 不相交，因此每个 key 最多有一个 provider；isolation realm 在实现层可放宽为“每个 realm 内唯一”。

### 6.2 生命周期为什么不只有 Active/Inactive

为了覆盖真实运行时，论文最终使用四类状态：

```text
Inactive → Reloading → Active → Unloading → Inactive
```

此外还有 divert、raise，以及卸载完成后因 target 又改变而立刻 reload 的链式路径。这个扩展分别处理：

- **多步 effect**：用 iterator 在每一步产生一个逆操作；
- **异步**：已经发出的异步步骤具有 inertia，不能因为 target 改变就假装没有发生；
- **中途依赖变化**：在 iterator 边界检查 target，必要时停止后续步骤并撤回已完成部分；
- **失败**：失败步骤本身无 effect，但此前积累的 effect 必须先撤回，再把错误记录到 fiber；
- **依赖撤回顺序**：provider 先进入 Unloading 并停止对新消费者可见，但保留实际资源，等待已有消费者完成 teardown 后才真正执行 accumulator。

最后一点是全文最重要的运行时协议。若 B 依赖 A，正确撤回顺序不是简单地“先删 A，再通知 B”，而是：

```text
A 停止对外提供
  → B 的 target 失效并进入卸载
  → B 仍可通过 committed view 使用 A 完成 teardown
  → B 完成
  → A 的 relied guard 释放
  → A 执行自己的逆操作
```

这同时保证了“消费者不再新增”和“旧消费者的清理期间依赖仍可读”。

### 6.3 元理论的结论与前提

| 结果 | 结论 | 关键前提/边界 |
|---|---|---|
| 定理 59：Preservation | 每条规则都保持 registry 良构 | effect 必须 confined；provision 唯一；撤回 guard 正确执行 |
| 定理 61：Recovery exactness | 移除某 fiber 后，只保留其他 fiber 本来会产生的状态 | 参与序列的组件 effect 两两独立 |
| 推论 62：Terminal recovery | fiber 无论正常、divert 还是失败退出，最终贡献都归零 | 同上；控制字段按单独等价忽略 |
| 定理 63：Ordering | 消费者晚于 provider 激活，并早于 provider 完成卸载；依赖值在消费者 episode 内稳定 | committed view、relied guard、良构 registry |
| 定理 64：Resolution coherence | 一次 activation 不会跨越两套依赖解析；若异步步骤因 inertia 落地，其 effect 会随后被撤回 | 每个迭代边界检查 target |
| 定理 66：Progress | 无死锁并终止到 quiescent 状态 | 依赖优先关系无环、每个 iterator 长度有界、涉及的 fiber 名集合有限、期间只有 lifecycle steps |
| 定理 73：Confluence | 相同编排输入最终得到唯一的静态装配式 normal form，与调度和中间 reload 历史无关 | quiescent、无失败、effect 两两独立、组件对 provision 是 total、依赖/父子支持关系良基；结论只到观察等价、控制字段等价和名字重命名 |

这些定理共同构成论文所说的“全局时空可组合性”。需要注意，confluence 不是“任何情况下都收敛到同一状态”：失败可以依赖执行时状态，从而造成真实分歧；外部 emission 也不在定理覆盖范围内。

## 七、Cordis 实现如何对应理论

Cordis 被定位为 meta-framework：它不提供 Web、ORM 或聊天机器人等领域能力，只提供动态组合语义。

| 理论对象 | Cordis 对应物 | 作用 |
|---|---|---|
| `Γ∞` | `ctx` | 一等 context 与层级 context 树 |
| effect iterator | `ctx.effect(callback)` | 执行 effect、收集 disposer、LIFO 回收 |
| `Σ` | context 内部 store | 保存 coeffect bindings |
| `get/set` | `ctx.get` / `ctx.set` | 读取与可撤销地提供依赖 |
| isolation/interception | `ctx.isolate` / `ctx.intercept` | realm 隔离与访问元数据注入 |
| component instance | fiber | 保存 inject、apply、target、committed、dispose、state、inertia |
| 注册/退休 | `ctx.use` 及其 disposer | 子组件生命周期成为父组件的一个 effect |
| target change | `notify` + `refresh` | 重新解析依赖并触发 reload/unload |

### 7.1 Core library

`ctx.effect` 驱动普通函数或 generator/iterator，每步得到一个 disposer 并合入 accumulator。`ctx.set` 自身通过 `ctx.effect` 实现，因此依赖提供的撤回无需特殊机制。`notify` 找出同 realm 下声明了受影响 key 的 fiber，然后调用 `refresh`。

实现中的 `fiber.target` 记录 provider 的 uid，而不是只记录“依赖是否存在”。因此一个 provider 被另一个等值 provider 替换时，消费者仍会重新加载；同一个 provider 原地修改 value 则不会自动触发 provider-identity 变化，若希望传播替换，必须先撤回再重新提供。

TypeScript Proxy 让 `ctx[key]` 看起来像普通属性访问，但运行时会沿 fiber 链检查 committed view：依赖未激活时抛出 `INACTIVE_ACCESS`，未声明时抛出 `UNDECLARED_ACCESS`。这是一种运行时 capability mediation，而不是完整安全沙箱。

### 7.2 Loader 与 HMR

声明式 loader 用 entry 描述 fiber：稳定 id、模块 URL、isolate、intercept、config、disabled。配置变化通过 reconciliation 转成最小范围的 fiber 操作。HMR 分三步：模块分类、过期 entry 检测、带 cache 备份的 reload；导入失败时恢复旧 cache 并重建旧 fiber。

这种 HMR 的优势是组件本身已经有完整 effect 边界，不需要每个模块另外声明 HMR acceptance boundary。它更接近“撤回旧实例并从干净状态创建新实例”，而不是 DSU 式的内部状态迁移；需要保留的状态必须放在生命周期更长的依赖中。

## 八、案例研究的证据强度

论文以 Koishi 聊天机器人生态为案例，指出其拥有 4000 多个社区插件，服务器端和浏览器控制台都建立在 Cordis 抽象上。该案例较好地支持两点：

1. context primitives 足以承载一个大规模插件生态，说明模型具有表达力；
2. 同一模型能跨服务端和浏览器场景，说明它不完全依赖某个业务领域。

但它不能独立证明：

- Cordis 相比 OSGi、DI、React effect、传统插件 teardown 的性能或生产率优势有多大；
- runtime notification、Proxy、iterator 和依赖 drain 的时间/内存开销；
- 大规模依赖拓扑快速变化时的尾延迟、抖动和最坏情况；
- 当前形式系统与实际实现完全一致。

论文自己也承认，该案例是 existence-and-adoption 证据，而非受控实验。更关键的是，Koishi 当前使用 Cordis v3，而论文描述的是重做 effect/coeffect 语义和 loader 的 Cordis v4；因此生产采用只能验证共享的核心思想，不能直接验证 v4 的全部算法和元理论映射。

## 九、论文的主要优点

### 9.1 问题分解准确

将动态组合拆成时间与空间两个轴，比把一切都归为“热更新”更清楚。它解释了为什么 restart、DI、HMR、cleanup hook 各自只覆盖问题的一部分。

### 9.2 原子操作局部给逆，复合清理由运行时生成

这把“清理完整性”从一个远距离、事后编写的 teardown 函数，转成与 effect 创建共址的结构要求。它不能消灭错误逆操作，但显著降低了遗漏清理的概率，并让组合规律可证明。

### 9.3 对撤回依赖的时序处理很成熟

provider 先变为不可供新绑定使用，再等待旧 consumer teardown，最后撤回资源，是比普通 service availability callback 更完整的异步协议。committed view 也避免消费者在 teardown 期间看到一半新、一半旧的解析结果。

### 9.4 形式模型覆盖真实控制流

论文没有停在原子、同步、永不失败的理想模型，而是依次加入多步 iterator、异步 inertia、失败、divert 和嵌套注册，并对 preservation、progress 与 confluence 给出证明。这使理论和框架设计之间的映射较有说服力。

### 9.5 清楚承认系统边界

论文区分 acquisition 与 emission：文件句柄、连接、监听器等“获得通道”的 effect 可以撤回，但已经写出的字节、发出的网络包、外部支付等通常不能倒流。对外部 emission 只能延迟提交或做补偿，而原有元理论不能自动迁移过去。这一限制说明作者没有把“可撤销”包装成不现实的全局事务。

## 十、关键限制与需要作者进一步澄清之处

### 10.1 可逆性由框架组织，但不由框架验证

形式系统中的 `E*` 带有“逆操作确实恢复原状态”的见证；实际 `ctx.effect` 只接收组件作者返回的 closure，并不验证它正确。忘记返回 disposer 的风险被 API 结构降低了，但“返回了错误 disposer”仍会破坏定理前提。

因此，论文中“结构性保证”的准确表述应是：**在所有 effect 都通过 context，且每个原子 effect 提供正确逆操作的条件下，组合和调用顺序由运行时结构性保证。**它不是对任意组件代码的无条件保证。

### 10.2 所有跨组件共享状态必须被 context 化

若组件通过全局变量、原生模块、未代理对象或闭包直接共享状态，这些状态不会自动进入 coeffect 分区，也就无法获得独立性和撤回保证。TypeScript 库无法阻止组件保存或误用别的 context。论文在第 6.7 节提出语言/操作系统共设计，恰好说明当前库层实现的封闭性主要依靠纪律。

### 10.3 全局定理的前提较强

- 跨组件 effect 必须两两独立；同 key 的操作必须由 provider 证明可交换；
- 依赖优先关系必须无环；互相依赖要拆成 core 与 integration components；
- progress 需要 fiber 总数有限、iterator 长度有界；
- confluence 排除失败，并要求组件在激活完成时提供 `p` 中的所有 key；
- 单 realm 演算要求每个 key 只有一个潜在 provider；多 provider 依赖 isolation 或 broker 模式；
- final-state confluence 不涵盖运行中已经对外产生的 emission。

这些不是小字条件，而是决定结论能否应用于实际系统的核心契约。论文未来最好提供静态检查、运行时诊断或接口认证机制，帮助工程系统判断这些条件是否真的成立。

### 10.4 统一递归 context 的类型论基础尚不完整

`μΓ. Γ × (Γ → Γ) × Σ` 中 `Γ` 在箭头左侧负出现，不能直接当作常规严格正递归数据类型。论文没有说明它是在何种 domain category、递归类型系统或等递归/同构递归语义下求解。若“编程范式”的理论身份依赖这个 fixed point，后续版本应给出更精确的语义构造，或改写为显式层级/存在封装，避免把工程自引用结构直接当作无条件存在的类型。

### 10.5 等价关系与证明层次较复杂，适合机械化

第 4 节同时使用 `≃`（观察等价）与 `≈`（忽略 registry 控制字段但精确比较 effect 状态），还要再商掉动态生成名字的重命名。部分定理文字说“同时在两种关系下成立”，公式和证明中又交替使用它们。整体意图可以理解，但手写证明很难排除隐含的 congruence、定义域和偏函数前提。使用 Lean、Coq、Agda 或 Isabelle 机械化核心演算，会显著提升可信度，也可能迫使作者更清楚地陈述定理 73 所依赖的无环条件。

### 10.6 Algorithm 1 的复合顺序疑似与正文约定相反

论文在 Algorithm 1 前明确约定：`f ∘ g` 表示先运行 `g`、再运行 `f`。若 effect 依次返回逆 `g₁`、`g₂`，正确的 LIFO disposer 应为：

```text
g₁ ∘ g₂    # 执行时先 g₂，再 g₁
```

但 Algorithm 1 第 6 行写的是：

```text
inverse ← value ∘ inverse
```

从 `id` 开始，两步后会得到 `g₂ ∘ g₁`，执行顺序是 `g₁` 后 `g₂`，即 FIFO。除非实际代码的 compose 运算方向与论文刚给出的约定相反，否则这一行应当是 `inverse ← inverse ∘ value`。这是预印本下一版最值得优先核对的具体问题，因为 LIFO 是定理 16、失败恢复和组件卸载的基础。

### 10.7 失败语义在演算与伪代码之间没有完全展开

形式演算有明确的 L-Raise：迭代失败后进入 Unloading，撤回此前 accumulator，再记录错误。但 Algorithm 1 的 `await iter.next()` 和 Algorithm 5 的 `await execute(...)` 没有展示 `try/catch/finally`；若 promise reject，伪代码表面上会直接跳出而不返回 recover closure。表 2 声称实现对应 L-Raise，但关键异常路径并未在算法中出现。正式实现也许处理了该路径，但论文需要把它呈现出来，才能证明 theory-to-implementation correspondence。

### 10.8 HMR 的“事务性”是最终恢复，不是外部可见的原子事务

Algorithm 10 会逐个 dispose 旧 fiber、导入并建立新 fiber；失败后再恢复 cache 和旧 fiber。在没有全局隔离或输出缓冲的情况下，中间状态可能被并发请求观察，新组件也可能已经产生不可撤回的外部 emission。因此它能较好保证“失败后最终回到旧组合”，却不能仅凭当前算法保证严格的 all-or-nothing 可见性。论文第 6.1 节的系统边界分析实际上也支持这个更弱、更准确的解释。

### 10.9 缺少定量评估与 v4 直接验证

当前没有 benchmark、内存开销、reload 延迟、依赖扇出实验、失败注入测试、与基线系统比较或开发者研究。实现章节主要给伪代码，案例主要证明采用。若论文目标是系统论文，至少应补充：

- effect 记录和 Proxy access 的单操作开销；
- `notify` 在 fiber 数与依赖扇出增长时的复杂度和实测；
- 深依赖链撤回的 drain 延迟；
- 高频配置抖动下 inertial chaining 的行为；
- 随机调度/故障注入下的恢复与 confluence 属性测试；
- Cordis v4 的真实应用迁移或生产案例。

## 十一、与相关工作的关系

论文的单项机制并非都没有先例，但组合方式有新意：

- 与 RAII、bracket、STM、reversible computing 相比，Cordis 的撤回范围由动态组件生命周期决定，而非预先固定的词法/事务作用域；
- 与 React `useEffect` 相比，原子 effect 可以嵌套、异步、迭代组合，复合 inverse 自动形成；
- 与 OSGi Declarative Services/iPOJO 相比，二者都能响应服务可用性，但 Cordis 把异步 teardown、自动 effect accumulation 和依赖撤回顺序纳入统一演算；
- 与普通 DI 相比，Cordis 会在 provider 改变时重新解析并驱动生命周期，而不是只在初始化时注入一次；
- 与 FRP/signal 相比，Cordis 处理组件级异步生命周期，不提供 value-level turn 或 glitch freedom；coeffect 内部可以再承载 signal；
- 与 DSU/HMR 状态迁移相比，Cordis 倾向于撤回旧状态、重建新组件；内部状态若要跨版本保留，需提升到更长寿命的 dependency。

因此，最合理的新颖性主张不是“首次有可撤销操作”或“首次有反应式依赖”，而是：**首次以运行时 effect/coeffect 的统一 context，把可撤销副作用、反应式依赖、异步生命周期与多组件交错的元理论系统化地连接起来。**

## 十二、对 self-evolving agent harness 的意义

论文把自演化 agent harness 作为动机和未来验证方向，而不是已经完成的案例。若应用到此类系统，最有价值的不是“让 agent 随便改自己”，而是把自修改限制成可审计的 component transaction：

1. 模型生成或选择一个新组件；
2. 组件显式声明需要的工具、记忆、权限和服务；
3. 所有资源注册必须通过 context 并返回 inverse；
4. 新组件在依赖满足后激活，旧组件继续服务到替代品准备好；
5. 依赖方按 committed view 有序 drain；
6. 新组件失败时撤回其 effect，保留旧系统；
7. 对网络发送、数据库提交等 emission 使用输出暂存、幂等键或补偿，而不是误认为普通 inverse 足够。

但 agent 场景会放大论文尚未解决的问题：生成代码可能谎报依赖、绕过 context、给出错误 inverse、制造无界 fiber 或依赖环；外部工具调用也往往不可逆。因此若要把 Cordis 作为自主 agent 的安全基础，还需要 capability sandbox、effect 审计、资源配额、版本化接口、超时/cancellation 语义，以及对 inverse 的属性测试或系统级强制生成。

## 十三、建议的后续研究与验证清单

按优先级排序：

1. 修正或解释 Algorithm 1 的 inverse composition 方向，并补全异常路径伪代码；
2. 对核心演算做机械化证明，统一 `≃`、`≈` 与名字重命名的关系；
3. 给 `Γ∞` 的递归类型提供严格语义；
4. 为 effect/coeffect interface 设计可检查的 commutativity、confinement、total provision 契约；
5. 在 runtime 中检测依赖环、无界注册趋势和 teardown 超时；
6. 将 dependency key 扩展为具命名空间、版本范围或结构兼容检查的接口标识；
7. 明确 cancellation 与 inertia 的边界，尤其是不可取消 I/O、超时和僵死 future；
8. 把 HMR 的恢复保证分成 final-state rollback、并发隔离、外部 emission 三个等级；
9. 在 Cordis v4 上做性能、压力、故障注入和跨生态实证；
10. 用一个真正会自修改的 agent harness 验证快速替换、权限缩减和故障恢复。

## 十四、简明术语表

| 术语 | 本文中的含义 |
|---|---|
| effect | 组件对环境造成的状态变换 |
| revertible effect | 执行时同时返回本次逆操作的 effect |
| coeffect | 组件从环境中需要的依赖/能力 |
| reactive coeffect | provider 变化时可触发生命周期重新求解的 coeffect |
| context | 统一承载 effect accumulator、coeffect store 和层级关系的运行时对象 |
| component | `(依赖声明, provision 声明, effect)` |
| fiber | component 的一次运行时实例及其生命周期状态 |
| committed view | fiber 激活时锁定的 key → provider 身份映射 |
| target view | 当前环境下该 fiber 应使用的 provider 映射，或 inactive |
| accumulator | 依执行历史组合得到的逆操作 |
| inertia | 已开始的异步步骤必须先落地，再决定是否撤回 |
| quiescence | 所有 fiber 的实际状态都与 target 一致，没有过渡待处理 |
| confluence | 相同编排输入经不同合法调度后到达等价 normal form |

## 十五、最终评价

若按不同维度分别评价：

- **问题重要性：高。**动态插件与 agent harness 确实缺少细粒度的统一基础。
- **概念贡献：高。**时间/空间二分与 runtime effect/coeffect 联结很有解释力。
- **形式完整度：中高。**覆盖了多组件、异步、失败与收敛，但强前提、递归类型和多重等价仍需精化与机械化。
- **工程设计质量：高。**fiber state machine、committed view、dependent drain 和 loader 映射都很具体。
- **经验验证：中低。**单一生态、v3/v4 差异、无定量实验。
- **当前结论可信范围：条件式可信。**在 context 封闭、逆正确、effect 独立、依赖无环且规模有限时，论文的组合性结论有清晰论证；超出这些边界，尤其涉及外部 emission、恶意组件、错误 inverse 和失败调度时，不能直接套用。

整体而言，这是一篇值得继续跟踪的预印本。它最可能产生长期影响的部分，不是某个 TypeScript API，而是“**把动态组件的所有环境修改做成可撤销 effect，把所有跨组件顺序约束做成反应式 coeffect，再让运行时统一协调二者**”这一设计纪律。
