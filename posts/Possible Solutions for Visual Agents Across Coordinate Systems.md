---
date: 2026-08-25
category: agent
title: 视觉智能体的跨模型坐标协议
---

# 视觉智能体的跨模型坐标协议

## 摘要

视觉智能体最危险的一类故障，不是模型没有找到目标，而是模型找到了目标，执行器却把正确的坐标解释成了另一个坐标系中的点。

在一次真实 Android 设备测试中，视觉模型返回坐标 <code>[362, 825]</code>。运行时把它当成 0..999 归一化坐标，最终执行了：

~~~bash
adb shell input tap 440 2179
~~~

点击没有任何效果。把同一坐标解释为模型实际看到的 590×1280 输入图像像素后，得到：

~~~bash
adb shell input tap 747 1702
~~~

应用被正常打开。

这个问题表面上是一次缩放错误，实质上却是一个通用的协议设计问题：

> 坐标不是两个数字。一个可执行坐标必须同时包含数值、坐标空间、参考帧、方向、裁减关系和变换版本。

更近一步，在真实的实践中还会遇到一个反直觉的事实：不能把“某个模型的原生坐标习惯”视为稳定能力。同一个模型在缺少唯一契约时，可能在不同请求中混用归一化坐标和输入图像像素。因此，可靠系统不应该猜模型偏好，而应该与模型协商一个可验证、可冻结、可审计的坐标契约。

本文从故障复现开始，给出一套不依赖具体模型供应商、移动端平台或 Agent 框架的完整方案：

- 显式建模坐标空间，而不是传递裸 <code>[x, y]</code>；
- 使用 canonical 坐标隔离模型协议与设备执行协议；
- 用合成图进行零触摸协议协商；
- 对越界、歧义和校准失败执行 fail-closed；
- 将原始坐标、映射过程和最终设备坐标写入轨迹；
- 区分“恢复程序成功”和“原始动作成功”，避免错误恢复循环；
- 用数学回归、模拟模型、集成测试和真机测试共同验收。

虽然案例来自 Android 视觉智能体，但同样的问题存在于浏览器 Agent、桌面自动化、远程桌面、游戏操作、机器人视觉和任何“模型看图、系统执行坐标动作”的应用中。

## 1. 一次看似普通的点击故障

### 1.1 现场条件

真实设备与模型输入的几何信息如下：

| 对象               |   宽 |   高 | 含义                                   |
| ------------------ | ---: | ---: | -------------------------------------- |
| Android 物理显示   | 1216 | 2640 | ADB 最终执行触控的显示空间             |
| 发给视觉模型的截图 |  590 | 1280 | 为控制 Token、延迟和带宽而缩放后的图像 |
| 模型输出           |  362 |  825 | 未携带坐标空间声明的裸坐标             |

系统原先规定模型应输出 0..999 坐标，因此执行器采用以下变换：



~~~text
x_device = round(x_model / 999 × (display_width - 1))
y_device = round(y_model / 999 × (display_height - 1))
~~~

代入数据：

~~~text
x_device = round(362 / 999 × 1215) = 440
y_device = round(825 / 999 × 2639) = 2179
~~~

因此得到错误点击：

~~~bash
adb shell input tap 440 2179
~~~

然而，模型实际返回的是输入图像像素坐标。正确变换应为：

~~~text
x_device = round(362 / (590 - 1) × (1216 - 1)) = 747
y_device = round(825 / (1280 - 1) × (2640 - 1)) = 1702
~~~

对应命令：

~~~bash
adb shell input tap 747 1702
~~~

真机立即产生了预期效果。

### 1.2 为什么这个案例具有普遍性

很多系统在接口中只保存：

~~~json
{"action": "click", "point": [362, 825]}
~~~

这个结构看起来简洁，却缺失了执行所需的关键语义：

- 362 和 825 是归一化值、图像像素还是设备像素？
- 参考的是原始截图、压缩截图、裁剪区域还是浏览器 viewport？
- 坐标原点在左上、左下还是某个局部区域？
- 边界是闭区间 0..999、0..1000，还是 0..width-1？
- 图像是否经过旋转、letterbox、裁剪、拼接或 DPR 缩放？
- 模型看到的 frame 是否仍然是执行瞬间的 frame？

所以，一个更准确的工程定义是：

~~~text
Point = (x, y, coordinate_space, frame_id, transform_version)
~~~

如果只有 <code>(x, y)</code>，它不是一个完整的点，只是两个缺少单位和参照物的数。

---

## 2. GUI Agent 中常见的坐标空间

### 2.1 归一化坐标

视觉模型和 Computer Use API 常使用固定范围的归一化坐标，例如 0..999 或 0..1000。Google Gemini Computer Use 的官方文档明确要求调用方把归一化的 1000×1000 坐标缩放到实际屏幕；其新接口动作参数也声明为 0..999。参见：

- [Gemini Computer Use 官方文档](https://ai.google.dev/gemini-api/docs/computer-use)
- [Gemini 图像理解中的 0..1000 bounding box](https://ai.google.dev/gemini-api/docs/generate-content/image-understanding)

归一化坐标的优点是与分辨率解耦，缺点是存在端点定义、舍入和供应商协议差异。

### 2.2 输入图像像素

模型可能直接输出它所看到的编码图像中的像素。例如输入图像是 590×1280，那么合法范围通常为：

~~~text
x ∈ [0, 589]
y ∈ [0, 1279]
~~~

这种协议对视觉定位很自然，但执行器必须知道图像到真实显示之间的完整变换。

### 2.3 设备显示像素

Android 的 <code>input tap x y</code> 最终构造并注入带有 x、y 的 MotionEvent。AOSP 的实现可以直接在 [InputShellCommand.java](https://android.googlesource.com/platform/frameworks/base/+/master/services/core/java/com/android/server/input/InputShellCommand.java) 中看到。

设备显示像素通常是执行边界的坐标空间，但不一定适合作为模型协议，因为模型看到的图像可能已经被缩放或裁剪。

### 2.4 CSS viewport 像素与 device pixel

浏览器 Agent 至少还要区分：

- CSS pixel；
- device pixel；
- screenshot pixel；
- viewport 坐标；
- document 坐标；
- iframe 局部坐标；
- 受页面缩放和 devicePixelRatio 影响的坐标。

Playwright 文档说明部分坐标相对于 viewport 且使用 CSS pixels，同时截图又可以选择 CSS scale 或 device scale。参见 [Playwright Page API](https://playwright.dev/docs/api/class-page)。W3C Pointer Events 也把 client 坐标定义为相对于 viewport，参见 [Pointer Events 规范](https://www.w3.org/TR/pointerevents/)。

这说明即使离开移动端，“像素”仍然不是一个充分精确的单位。

### 2.5 裁剪、letterbox、旋转与局部坐标

生产系统还经常出现：

- 长图被分块或裁剪；
- 图像按比例缩放后补黑边；
- 横竖屏旋转；
- 折叠屏或多显示器；
- 浏览器 iframe；
- 远程桌面的画面缩放；
- 相机图像到机器人工作空间的投影。

此时简单的宽高比例已经不够，必须保存仿射变换、透视变换或局部 frame 的偏移。

---

## 3. 为什么一些直觉修复并不可靠

### 3.1 为某一家模型写死坐标协议

~~~python
if model_name.startswith("vendor-a"):
    use_normalized()
else:
    use_pixels()
~~~

问题在于：

- 同一供应商的不同模型可能不同；
- 同一模型的不同版本可能不同；
- 网关可能重写模型名；
- prompt 模板可能改变模型输出习惯；
- 同一模型也可能在模糊提示下跨请求混用协议。

供应商名称可以作为显式配置或诊断信息，但不应成为隐式真相。

### 3.2 根据数值范围猜坐标系

例如“如果 x 小于图像宽度，就认为是图像像素，否则认为是归一化坐标”。

这在案例中会立即产生歧义。对于宽度 590 的图像，归一化点 <code>[362, 825]</code> 的 x 也小于 590；大量常见点击都位于两个协议的重叠区间。范围启发式无法证明坐标语义。

### 3.3 自动 clamp 到合法范围

静默裁剪常被当作安全措施：

~~~python
x = max(0, min(width - 1, x))
~~~

这只能避免越界，不能保证语义正确。更危险的是，它会把一个明确错误的输出转换成一个看似合法、但可能点击敏感控件的动作。

模型边界应该拒绝不符合契约的坐标。clamp 只能作为底层防御，不应掩盖协议错误。

### 3.4 在 prompt 中同时提供所有尺寸

把 device width、device height、image width、image height、viewport 和归一化范围全部交给模型，通常不会增加确定性，反而会制造多个同样合理的坐标参照。

正确做法是：

> 每轮只展示当前冻结契约需要的几何信息，并明确声明这是唯一有效的坐标空间。

例如，使用输入图像像素时不应再向模型展示设备显示尺寸；使用归一化坐标时甚至不需要展示任何像素宽高。

### 3.5 只依赖自然语言提示

prompt 是协议的一部分，但不是验证。即使系统提示写了“输出 0..999”，模型仍可能受训练分布、图像元数据或其他上下文影响而输出图像像素。

可靠系统必须把 prompt、解析、边界校验、映射、校准和轨迹共同组成协议。

### 3.6 校准“模型原生习惯”

这是最容易被忽视的失败方式。

在一次真实探测中，同一个视觉模型面对三个合成靶标，分别返回：

~~~text
[180, 230]
[456, 525]
[630, 820]
~~~

第一和第三个结果接近 0..999 归一化坐标，第二个结果接近输入图像像素。也就是说，“请使用你原生或默认的坐标方式”并不能得到稳定协议。

因此，校准不应问：

> 你习惯使用什么坐标？

而应验证：

> 当我给出一个唯一契约时，你能否连续、稳定地遵守它？

---

## 4. 设计目标与系统不变量

一个通用坐标层至少应该满足以下不变量。

### 4.1 模型协议与执行协议隔离

模型可以使用不同坐标空间，但 Agent 内核和动作执行器只处理一种统一格式。

### 4.2 每次运行冻结一个协议

不能在单次任务中按动作猜测坐标空间。协议一旦配置或协商成功，就应在整个任务中冻结。

### 4.3 坐标变换可逆向审计

任意一个设备点击都应能回答：

- 模型原始输出是什么？
- 使用了哪个 profile？
- 当时模型图像和设备显示尺寸是什么？
- canonical 坐标是什么？
- 最终执行坐标是什么？

### 4.4 歧义时不触摸设备

无法建立可信契约时，系统应终止、请求显式配置或重新校准，而不是选择“最可能”的坐标。

### 4.5 校准不操作真实 UI

协议校准只向模型发送合成图，不向手机、浏览器或桌面发送动作。

### 4.6 坐标绑定到观察帧

坐标必须绑定到模型规划时看到的 frame。执行前如果目标区域或布局发生变化，应取消旧动作并重新规划。

---

## 5. 推荐架构：Coordinate Contract Layer

### 5.1 总体数据流

~~~mermaid
flowchart LR
    A[采集真实显示] --> B[缩放/裁剪/编码]
    B --> C[模型输入图像 Frame]
    C --> D[坐标协议配置或零触摸协商]
    D --> E[冻结 CoordinateProfile]
    E --> F[构造唯一 coordinate_contract]
    F --> G[视觉模型输出原始坐标]
    G --> H[契约边界校验]
    H --> I[Canonical 0..1]
    I --> J[统一运行时坐标]
    J --> K[执行前新鲜度检查]
    K --> L[设备/浏览器/桌面坐标]
    L --> M[执行与验证]
    G --> N[轨迹审计]
    H --> N
    I --> N
    L --> N
~~~

### 5.2 显式类型

不要让坐标空间隐藏在注释或变量名中。可以定义：

~~~python
class CoordinateSpace(Enum):
    AUTO = "auto"
    RELATIVE_0_999 = "relative_0_999"
    IMAGE_PIXELS = "image_pixels"
    DISPLAY_PIXELS = "display_pixels"


@dataclass(frozen=True)
class CoordinateFrame:
    image_width: int
    image_height: int
    display_width: int
    display_height: int
    frame_id: str


@dataclass(frozen=True)
class CoordinateProfile:
    space: CoordinateSpace
    source: str
    confidence: float | None
    calibration_error: float | None
    protocol_version: str
~~~

如果系统支持裁剪、旋转或透视，还应增加：

~~~python
@dataclass(frozen=True)
class FrameTransform:
    source_frame_id: str
    target_frame_id: str
    matrix_3x3: tuple[tuple[float, float, float], ...]
    transform_version: str
~~~

### 5.3 以 canonical 坐标作为内部边界

建议使用连续的 0..1 坐标作为几何 canonical 层：

~~~text
u = x / x_max
v = y / y_max
~~~

不同协议只负责决定 <code>x_max</code> 和 <code>y_max</code>：

| 协议           |             x_max |              y_max |
| -------------- | ----------------: | -----------------: |
| relative_0_999 |               999 |                999 |
| image_pixels   |   image_width - 1 |   image_height - 1 |
| display_pixels | display_width - 1 | display_height - 1 |

然后统一映射到设备：

~~~text
x_device = round(u × (display_width - 1))
y_device = round(v × (display_height - 1))
~~~

使用 <code>width - 1</code> 而不是 <code>width</code>，是因为离散像素下标通常从 0 到 width-1。系统必须统一端点定义，否则右边界和下边界会产生 off-by-one。

### 5.4 不止是缩放：一般化变换

当模型输入图像包含裁剪和 letterbox 时，可以把点写成齐次坐标：

~~~text
p_target ∝ H × p_source
~~~

其中 H 是 3×3 变换矩阵。最常见的仿射情形包括：

~~~text
x_display = scale_x × x_image + offset_x
y_display = scale_y × y_image + offset_y
~~~

如果发生旋转，应把方向变换纳入矩阵，而不是先交换宽高再依靠分支修补。对于相机到机器人工作空间的投影，则可能需要单应矩阵、深度或完整标定模型。

### 5.5 动态收敛模型上下文

模型每轮看到的 contract 应类似：

~~~json
{
  "space": "image_pixels",
  "image_width": 590,
  "image_height": 1280,
  "x_range": [0, 589],
  "y_range": [0, 1279],
  "instruction": "Use pixel coordinates in the exact image attached to this turn."
}
~~~

使用该协议时，不再暴露 display width 和 display height。

如果冻结的是归一化协议：

~~~json
{
  "space": "relative_0_999",
  "x_range": [0, 999],
  "y_range": [0, 999],
  "instruction": "Use normalized coordinates; bottom-right is [999,999]."
}
~~~

此时不应同时发送 image width 或 display width。

------

## 6. 从“推断原生协议”改为“协商可遵守协议”

### 6.1 两层配置

推荐同时支持：

1. 显式模式：部署者已经知道模型协议时直接配置；
2. 自动模式：通过零触摸探测验证模型能稳定遵守哪一个候选协议。

例如：

~~~dotenv
MODEL_COORDINATE_SPACE=auto
~~~

显式备选：

~~~dotenv
MODEL_COORDINATE_SPACE=relative_0_999
MODEL_COORDINATE_SPACE=image_pixels
MODEL_COORDINATE_SPACE=display_pixels
~~~

### 6.2 零触摸合成图

校准图应满足：

- 只包含一个高对比度目标；
- 目标中心位置已知；
- 使用多个不对称位置，避免中心点和轴对称带来的歧义；
- 与生产模型输入尺寸一致；
- 不包含真实用户页面和隐私数据；
- 校准输出永远不被派发到设备。

例如使用三个 canonical 靶标：

~~~text
(0.18, 0.23)
(0.79, 0.41)
(0.63, 0.82)
~~~

不要只测试中心点 <code>(0.5, 0.5)</code>。中心点在多种协议下都会落在相似位置，无法区分缩放、翻转和偏移错误。

### 6.3 候选协议验证

自动模式可以按偏好顺序测试：

1. relative_0_999；
2. image_pixels；
3. 其他项目需要的协议。

每一组探测都明确声明唯一契约，然后计算模型输出与已知靶标的 canonical 距离：

~~~text
error_i = sqrt((u_i - u_target_i)² + (v_i - v_target_i)²)
mean_error = average(error_i)
max_error = max(error_i)
~~~

接受条件必须同时限制平均误差和最大误差。例如：

~~~text
mean_error <= 0.04
max_error  <= 0.07
~~~

平均误差防止整体偏移，最大误差防止“两个点很好、一个点完全错误”被平均值掩盖。阈值需要根据目标大小、模型抖动和任务风险通过评测确定，不应盲目复制。

### 6.4 为什么应优先验证，而不是分类

这是协议协商与协议分类的根本区别：

- 分类问题：猜测这组输出属于哪种坐标系；
- 协商问题：提出一个契约，验证模型能否持续遵守。

分类面对重叠数值区间和混合输出时不可判定；协商把问题转化为有真值的能力测试。

### 6.5 校准输出解析

生产动作协议可以要求“输出后不得有任何文本”。但部分模型在校准时可能返回一个完整动作后再附加说明。

由于校准不会执行动作，可以做一个受限兼容：

- 必须只有一个完整 Tap 调用；
- 允许该调用之后存在惰性文本；
- 多动作、残缺调用、动态表达式仍然拒绝；
- 提取的坐标只参与误差计算，绝不进入设备执行路径。

这是一种局部、无副作用的兼容边界，不应该放宽主任务执行协议。

### 6.6 缓存与失效

校准会增加模型调用和 Token 成本，因此成功 profile 可以缓存。但缓存键不能只使用模型名，至少应包含：

~~~text
hash(
  endpoint,
  model_name,
  thinking_mode,
  screenshot_resize_policy,
  coordinate_protocol_version
)
~~~

以下情况应使缓存失效：

- 模型版本或 endpoint 改变；
- prompt/协议版本改变；
- 图像预处理策略改变；
- 旋转、裁剪或 letterbox 逻辑改变；
- 校准阈值或候选协议集合发生不兼容变化。

缓存文件不应保存 API Key。写入应采用临时文件加原子替换，避免进程中断留下半个 JSON。

------

## 7. 执行路径：从不可信模型输出到设备动作

下面是一份平台无关的伪代码：

~~~python
async def run_step(observation):
    profile = await resolve_coordinate_profile(observation)
    if profile is None:
        return fail_closed("coordinate contract unavailable")

    contract = build_contract(profile, observation.frame)
    context = build_model_context(
        screenshot=observation.image,
        coordinate_contract=contract,
        hide_irrelevant_geometry=True,
    )

    response = await model.request(context)
    model_action = parse_action_without_coordinate_assumption(response)

    canonical_action, audit = mapper.map_action(
        model_action,
        profile=profile,
        frame=observation.frame,
    )

    validate_canonical_bounds(canonical_action)

    fresh_observation = observe_again()
    if target_or_layout_changed(observation, fresh_observation, canonical_action):
        reject_without_touch("stale visual precondition")

    execution_action = convert_to_executor_space(
        canonical_action,
        fresh_observation.display_frame,
    )

    result = executor.dispatch(execution_action)
    verification = verify_visual_effect(result)
    record_full_coordinate_audit(audit, result, verification)
    return result
~~~

几个关键点：

1. 解析阶段不能预设所有模型都输出 0..999；
2. mapper 之前保留模型原始动作；
3. mapper 之后，Agent 内部只处理统一协议；
4. 风险审核、新鲜度检查和执行使用 canonical 动作；
5. 模型历史应保留它自己的原始坐标，而不是把转换后的坐标回灌给模型；
6. 执行前必须确认观察帧仍然新鲜。

---

## 8. 验证与 fail-closed

### 8.1 坐标值的边界校验

每个坐标值必须：

- 是数字，且不能是布尔值；
- 有限，不能是 NaN 或 Infinity；
- 非负；
- 不超过当前 profile 的 x/y 上界；
- 不超过独立的硬安全上限；
- 对需要两个点的动作完整提供 start 和 end。

错误坐标必须被拒绝，而不是裁剪后继续。

### 8.2 校准失败

以下情况都应结束自动协商：

- 模型没有返回唯一 Tap；
- 候选协议的平均或最大误差超限；
- 所有候选协议都失败；
- 请求被截断或取消；
- frame 几何非法；
- 缓存内容无法验证。

系统可以提示用户显式设置协议，但不能替用户猜一个协议后触摸设备。

### 8.3 执行前视觉新鲜度

即使坐标数学完全正确，它也只对规划截图有效。在模型思考、用户确认或网络等待期间，页面可能发生变化。

因此，坐标动作应绑定原始 frame，并在派发前重新观察：

- 目标局部区域是否改变；
- 屏幕尺寸或方向是否改变；
- 是否发生近全屏页面替换；
- 是否出现弹窗、键盘或系统面板。

如果发生变化，旧坐标应以零触摸方式取消。

### 8.4 敏感动作

对支付、发送、删除、授权、账户安全等高后果动作，仅有坐标正确还不够。仍需：

- 任务范围审核；
- 截图支持的动作风险复核；
- 必要时人工确认；
- 执行后的视觉验证；
- 可审计的停止条件。

坐标层解决“点到哪里”，不解决“是否应该点”。

---

## 9. 可观测性：让每次点击都能解释

一个建议的轨迹记录如下：

~~~json
{
  "coordinate_profile": {
    "space": "image_pixels",
    "source": "calibrated",
    "confidence": 0.87,
    "calibration_error": 0.0101,
    "calibration_samples": 3,
    "protocol_version": "1"
  },
  "frame": {
    "image_width": 590,
    "image_height": 1280,
    "display_width": 1216,
    "display_height": 2640
  },
  "fields": {
    "element": {
      "model_coordinate": [358, 830],
      "canonical_coordinate": [0.6078, 0.6489],
      "runtime_coordinate_0_999": [607.20, 648.30],
      "device_coordinate": [738, 1713]
    }
  }
}
~~~

还应记录：

- profile 是显式配置、自动校准还是缓存命中；
- 每次合成探测的目标、输出和误差；
- 校准模型调用的 Token、延迟和费用；
- 坐标动作是否真正派发；
- 执行前 frame 是否新鲜；
- 设备命令是否成功；
- 视觉效果是否可观察；
- 最终任务成功是否由独立评测确认。

不要只在日志里打印最终 ADB 命令。只有最终坐标无法诊断错误发生在模型、协议、映射、frame 还是执行器。

### 9.1 运行时成功不等于任务成功

需要分离三种事实：

1. command success：输入命令被系统接受；
2. observable effect：截图发生了符合策略的变化；
3. task success：用户目标在语义上真正完成。

坐标映射正确只能提高前两者的可信度，不能自动证明第三者。

---

## 10. 一个相关但独立的陷阱：恢复成功不等于动作成功

坐标故障常与恢复循环同时出现。

假设系统发现点击无效果，于是成功完成“重新观察”或“重新规划”。如果运行时把这个程序性恢复标记为成功，并清空原始失败计数，那么模型可以无限重复：

~~~text
点击错误位置
→ 无效果
→ 重新观察成功
→ 清空失败预算
→ 再次点击同一位置
→ 无效果
→ ...
~~~

这里要区分：

- mitigation succeeded：重新观察、重新规划这项恢复程序成功完成；
- original action recovered：原动作经过有界重试后真正成功并验证；
- task progressed：任务出现了可观察进展。

只有实际动作成功且通过验证，才应重置对应失败 episode。一次成功的 reobserve 或 replan 不应抹掉触发它的失败。

对于被重复保护器拦截、根本没有派发的动作，还应把模型历史中的上一条“可执行助手动作”替换为非执行的拒绝摘要，例如：

~~~json
{
  "rejected_action": {"action": "Tap", "element": [362, 825]},
  "command_dispatched": false,
  "do_not_repeat": true,
  "required_strategy_change": true
}
~~~

否则，模型会在历史中看到自己的动作像是被系统接受了一样，从而继续强化错误策略。

这一原则适用于所有 Agent：

> 恢复控制流的成功，不应伪装成业务动作的成功。

---

## 11. 测试策略

坐标系统不能只靠 mock 单元测试，也不能只靠一次真机演示。建议采用分层测试。

### 11.1 纯数学回归

固定案例：

~~~text
image:   590 × 1280
display: 1216 × 2640
raw:     [362, 825]
~~~

断言：

| profile        | 期望设备坐标 |
| -------------- | ------------ |
| image_pixels   | [747, 1702]  |
| relative_0_999 | [440, 2179]  |

这个测试证明“相同数值在不同空间中必须得到不同结果”。

### 11.2 契约边界测试

覆盖：

- x、y 分别越界；
- 负数；
- NaN、Infinity；
- 布尔值；
- 缺少坐标分量；
- 0 和最大端点；
- 宽或高为 1 的退化 frame；
- swipe 的 start/end 使用同一 profile。

### 11.3 合成协商测试

准备可控 fake model：

- 始终遵守 0..999；
- 始终输出输入图像像素；
- 所有点都返回 [0,0]；
- 在两个协议间混用；
- 返回一个动作后附加文本；
- 返回两个动作；
- 请求取消或截断。

验证：

- 正确 profile 被选中；
- 不稳定模型 fail-closed；
- 校准永不触摸设备；
- 失败校准的模型用量仍然进入审计。

### 11.4 Agent 集成测试

测试完整路径：

~~~text
auto 协商
→ 冻结 image_pixels
→ 模型输出图像像素
→ canonical 映射
→ fake device 收到正确点
→ 轨迹包含完整映射
→ profile cache 写入
~~~

同时测试第二次运行从缓存加载，不应重复消耗校准请求。

### 11.5 真机测试

真机验收至少包括：

1. 读取物理显示和编码截图尺寸；
2. 自动协商真实模型；
3. 只执行低风险、结果明显的导航动作；
4. 读取最终前台窗口仅用于诊断；
5. 检查轨迹中的 raw/canonical/device 映射；
6. 恢复设备现场。

一次真实验收中，自动协商冻结为 <code>image_pixels</code>，模型原始点击 <code>[358,830]</code> 被映射为设备坐标 <code>[738,1713]</code>，目标应用成功打开。

### 11.6 推荐测试矩阵

| 维度 | 建议覆盖                                 |
| ---- | ---------------------------------------- |
| 模型 | 至少两个供应商、不同视觉模型版本         |
| 图像 | 原尺寸、缩放、letterbox、裁剪            |
| 设备 | 不同宽高比、横竖屏、不同 DPR             |
| 动作 | Tap、Double Tap、Long Press、Swipe、Drag |
| 状态 | 静态页、动画页、弹窗、键盘、方向变化     |
| 失败 | 歧义坐标、越界、协议混用、缓存损坏、取消 |
| 风险 | 普通导航、敏感动作前停止、人工确认       |

---

## 12. 如何推广到其他系统

### 12.1 浏览器 Agent

推荐 canonical 路径：

~~~text
model screenshot pixel
→ screenshot canonical
→ CSS viewport pixel
→ iframe/local transform
→ pointer action
~~~

必须记录 viewport、截图 scale、devicePixelRatio、页面缩放、滚动位置和 iframe offset。若自动化框架提供元素引用或 accessibility ref，应优先使用语义引用；坐标用于 canvas、地图、远程画布等无法可靠引用元素的场景。

### 12.2 桌面 Agent 与远程桌面

需要额外处理：

- 操作系统缩放比例；
- 多显示器原点；
- 负坐标显示器；
- 远程桌面客户端缩放；
- 窗口装饰和内容区偏移；
- 截图捕获 API 与鼠标注入 API 是否共享同一坐标空间。

### 12.3 游戏与流媒体画面

视频帧可能被动态缩放、裁边或以非整数比例渲染。应为每一帧保存 presentation rectangle，并把模型坐标映射到实际交互 surface，而不是整个窗口。

### 12.4 机器人视觉

图像坐标到机械执行空间通常不是简单比例缩放。需要：

- 相机内参；
- 相机畸变校正；
- 相机外参；
- 深度或平面假设；
- 机器人基座与末端执行器坐标系；
- 标定版本和不确定性。

但架构原则不变：显式 frame、canonical 中间层、可验证变换、失败关闭和完整审计。

---

## 13. 上线与迁移策略

### 13.1 Shadow mapping

在真正改变执行坐标前，可以同时计算：

- legacy mapping；
- new mapping；
- 两者距离；
- 是否落在同一个目标区域。

只记录、不改变执行，用真实轨迹估算风险。

### 13.2 显式 override

自动模式不是万能的。部署者应始终能显式指定协议，以便：

- 高风险环境禁用自动协商；
- 模型供应商已提供强契约；
- 离线评测需要完全固定配置；
- 校准 API 成本不可接受；
- 特殊图像管线无法由通用探测覆盖。

### 13.3 冷启动与评测公平性

自动协商会增加首次运行的 Token 和延迟。评测时不能让一部分模型使用暖缓存、另一部分模型承担冷校准成本。

应明确区分：

- cold run：包含协议协商；
- warm run：使用冻结缓存；
- task latency：是否包含 capability negotiation；
- calibration cost：单独报告。

### 13.4 监控指标

建议监控：

- 每种 profile 的使用占比；
- 自动协商成功率；
- 候选协议平均/最大误差；
- cache hit rate；
- coordinate out-of-contract rate；
- pre-action stale rate；
- coordinate no-effect rate；
- repeated-action blocked rate；
- raw-to-device 映射距离异常。

如果模型升级后误差分布漂移，应使旧 cache 失效并重新协商。

---

## 14. 工程检查清单

在发布任何视觉坐标执行系统前，可以逐项确认。

### 协议

- [ ] 坐标对象是否携带明确的 coordinate space？
- [ ] 是否定义了 0..999 与 0..1000 的端点差异？
- [ ] 是否区分 image、display、viewport、CSS 和 device pixels？
- [ ] 每轮模型是否只看到一个权威 contract？
- [ ] 显式配置是否可以覆盖自动模式？

### 变换

- [ ] 是否保存原图到模型图的缩放、裁剪、补边和旋转？
- [ ] 是否使用 width-1/height-1 的一致端点定义？
- [ ] 是否通过 canonical 层隔离模型和执行器？
- [ ] 是否支持 frame id 与 transform version？
- [ ] 是否拒绝越界而不是静默 clamp？

### 自动协商

- [ ] 是否使用多个不对称合成靶标？
- [ ] 校准是否绝不触摸真实设备？
- [ ] 是否同时限制 mean error 和 max error？
- [ ] 是否验证模型遵守候选契约，而不是猜原生偏好？
- [ ] 校准失败是否 fail-closed？
- [ ] 缓存键是否包含协议和图像预处理版本？

### 执行安全

- [ ] 坐标是否绑定规划 frame？
- [ ] 派发前是否重新检查页面新鲜度？
- [ ] 敏感动作是否有独立风险审核与人工确认？
- [ ] 被拦截动作是否从可执行模型历史中移除？
- [ ] 恢复程序成功是否与动作成功严格分离？

### 可观测性

- [ ] 是否记录模型原始坐标？
- [ ] 是否记录 canonical 坐标？
- [ ] 是否记录最终设备坐标？
- [ ] 是否记录 frame 几何与 profile 来源？
- [ ] 校准请求的 Token、延迟和费用是否计入？
- [ ] runtime success 与外部 task success 是否分离？

### 测试

- [ ] 是否有确定性数学回归案例？
- [ ] 是否覆盖协议混用和歧义输出？
- [ ] 是否覆盖缓存命中与失效？
- [ ] 是否有完整 Agent 集成测试？
- [ ] 是否在真实设备或真实浏览器上验收？

---

## 15. 最重要的几个结论

第一，坐标是协议，不是数字。

第二，不要假设所有视觉模型共享一个坐标空间，也不要假设同一模型在模糊提示下永远使用同一个空间。

第三，不要通过数值范围猜协议。重叠区间使这种推断在一般情况下不可判定。

第四，自动化的正确方向不是“识别模型原生习惯”，而是“提出唯一契约并验证模型能稳定遵守”。

第五，模型坐标和设备坐标之间应有一个 canonical 中间层。这样模型供应商、图像预处理和执行平台可以独立变化。

第六，越界、歧义和校准失败必须 fail-closed。错误点击的代价往往高于中止一次任务。

第七，必须保存 raw → canonical → device 的完整证据链。没有这条链，线上“点错了”几乎无法被准确归因。

第八，恢复程序成功不等于动作成功。错误地清空失败预算，会把一次坐标 bug 放大成无限循环。

最后，提示词只能表达协议，不能证明协议被遵守。可靠性来自提示、类型、校准、验证、映射、执行前检查、轨迹和真机测试共同形成的闭环。

---

## 参考资料

1. Google AI for Developers, [Gemini Computer Use](https://ai.google.dev/gemini-api/docs/computer-use)：Computer Use 动作坐标及从归一化空间缩放到实际屏幕的示例。
2. Google AI for Developers, [Image understanding / Object detection](https://ai.google.dev/gemini-api/docs/generate-content/image-understanding)：0..1000 bounding box 与原始图像尺寸反缩放。
3. Android Open Source Project, [InputShellCommand.java](https://android.googlesource.com/platform/frameworks/base/+/master/services/core/java/com/android/server/input/InputShellCommand.java)：Android shell tap/swipe 到 MotionEvent 注入的实现。
4. Microsoft Playwright, [Page API](https://playwright.dev/docs/api/class-page)：viewport、CSS pixels、device pixels 和截图 scale。
5. W3C, [Pointer Events](https://www.w3.org/TR/pointerevents/)：指针事件相对 viewport 的坐标定义。

---

## 附录 A：最小 CoordinateMapper 示例

~~~python
from dataclasses import dataclass
from enum import Enum
import math


class Space(Enum):
    RELATIVE_0_999 = "relative_0_999"
    IMAGE_PIXELS = "image_pixels"
    DISPLAY_PIXELS = "display_pixels"


@dataclass(frozen=True)
class Frame:
    image_width: int
    image_height: int
    display_width: int
    display_height: int


def denominators(space: Space, frame: Frame) -> tuple[float, float]:
    if space is Space.RELATIVE_0_999:
        return 999.0, 999.0
    if space is Space.IMAGE_PIXELS:
        return float(frame.image_width - 1), float(frame.image_height - 1)
    return float(frame.display_width - 1), float(frame.display_height - 1)


def to_device(
    point: tuple[float, float],
    *,
    space: Space,
    frame: Frame,
) -> tuple[int, int]:
    x, y = point
    if not all(math.isfinite(v) and v >= 0 for v in (x, y)):
        raise ValueError("coordinates must be finite and non-negative")

    max_x, max_y = denominators(space, frame)
    if x > max_x or y > max_y:
        raise ValueError("coordinate exceeds the declared contract")

    u = x / max_x if max_x else 0.0
    v = y / max_y if max_y else 0.0

    device_x = round(u * (frame.display_width - 1))
    device_y = round(v * (frame.display_height - 1))
    return device_x, device_y
~~~

这个最小示例只覆盖等比例 frame 映射。生产系统还需要 frame id、旋转/裁剪变换、协议协商、缓存、执行前新鲜度检查和轨迹审计。

## 附录 B：案例计算复核

~~~python
frame = Frame(
    image_width=590,
    image_height=1280,
    display_width=1216,
    display_height=2640,
)

assert to_device(
    (362, 825),
    space=Space.IMAGE_PIXELS,
    frame=frame,
) == (747, 1702)

assert to_device(
    (362, 825),
    space=Space.RELATIVE_0_999,
    frame=frame,
) == (440, 2179)
~~~

同一组数字得到两个都“数学合法”的设备点。只有显式坐标契约才能决定哪一个具有正确语义。
