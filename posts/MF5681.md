---
id: mf5681
date: 2025-08-23
category: other
title: 海康威视 MF5681（800 万 4K USB 摄像头）Ubuntu 使用记录
---

# 海康威视 MF5681（800 万 4K USB 摄像头）Ubuntu 使用记录

> 型号：MF5681，京东商品名：海康威视 800 万 4k 超清电脑摄像头 
>
> USB 设备 ID：`2bdf:02b1`，固件上报设备名：`General 4K USB Camera` 
>
> 环境：Ubuntu Linux，标准 UVC 协议免驱摄像头，**不使用海康工业相机 MVS/MSDK**

> 

## 一、硬件基本信息

1. **物理形态**：摄像头与 USB 线缆一体不可更换，无可拆卸 USB 线。
2. **USB 硬件层**：硬件 PHY 仅支持 **USB2.0（480Mbps）**。即使插入主板 / 笔记本蓝色 USB3.0 接口，也只会向下工作在 USB2.0 模式，无法协商 5000M SuperSpeed。
3. **图像输出格式**
   - `MJPG`（硬件压缩）：支持 3840×2160@30fps、2560×1440@30fps、1080P@30fps 等档位。**4K 分辨率仅支持 MJPG 压缩格式**。
   - `YUYV`（无压缩）：最高仅支持 1920×1080@5fps，**不存在 4K YUYV 输出**。
4. 定位：面向会议、面试的消费级 USB 摄像头，并非工业相机。依靠 MJPG 硬件压缩，在 USB2.0 带宽下实现 4K 输出。

> ⚠️ 硬件限制：USB2.0 总线带宽有限，长距离、信号质量差时高码率 MJPG 会出现丢帧、读取失败。禁止通过 USB Hub / 扩展坞，必须直插主机 / 笔记本原生 USB 口。

## 二、Linux (Ubuntu) 下驱动与设备识别

### 1. 驱动

使用系统自带`uvcvideo`内核驱动，无需安装第三方驱动。

```
# 查看是否识别设备
lsusb
# 输出示例：Bus 003 Device 005: ID 2bdf:02b1 General 4K USB Camera
```

### 2. V4L 设备节点

每一台 UVC 摄像头会生成 2 个 `/dev/video*`设备：

- index0：图像数据流，实际采集使用（如`/dev/video4`）
- index1：元数据节点，**不可用于图像采集**

```
# 列出本机全部摄像头设备
v4l2-ctl --list-devices
```

> 设备号 `/videoX` 会随插拔、其他摄像头接入发生漂移。 推荐使用`by-id`永久符号链接，不受物理端口、设备编号影响： `/dev/v4l/by-id/usb-2bdf_02b1-video-index0`

```
# 查看by-id与by-path链接
ls -l /dev/v4l/by-id/
ls -l /dev/v4l/by-path/
```

- `by-id`：绑定摄像头设备本身，换主板 USB 口链接不变；
- `by-path`：绑定主板物理 USB 端口，换口链接改变。

### 3. 权限配置

普通用户访问 video 设备权限配置，避免每次使用`sudo`。

```
# 将当前用户加入video用户组
sudo usermod -aG video $USER
newgrp video
```

udev 永久规则（可选，设备固定权限）

```
echo 'SUBSYSTEM=="video4linux", ATTRS{idVendor}=="2bdf", ATTRS{idProduct}=="02b1", MODE="0666"' | sudo tee /etc/udev/rules.d/99-mf5681.rules
sudo udevadm control --reload-rules
sudo udevadm trigger
```

## 三、命令行测试工具

### 1. 查询摄像头支持分辨率、帧率

```
v4l2-ctl -d /dev/v4l/by-id/usb-2bdf_02b1-video-index0 --list-formats-ext
```

### 2. 设置硬件输出格式

```
# 设置为4K MJPG（本地测试，会议不推荐）
v4l2-ctl -d /dev/v4l/by-id/usb-2bdf_02b1-video-index0 --set-fmt-video=width=3840,height=2160,pixelformat=MJPG

# 设置为1080P MJPG【会议/面试推荐档位】
v4l2-ctl -d /dev/v4l/by-id/usb-2bdf_02b1-video-index0 --set-fmt-video=width=1920,height=1080,pixelformat=MJPG

# 查看当前实际生效的图像参数
v4l2-ctl -d /dev/v4l/by-id/usb-2bdf_02b1-video-index0 --get-fmt-video
```

### 3. ffplay 预览画面

```
# 1080P MJPG预览（会议推荐）
ffplay -f v4l2 -input_format mjpeg -video_size 1920x1080 /dev/v4l/by-id/usb-2bdf_02b1-video-index0
```

## 四、OpenCV Python 采集注意事项

> ⚠️重要坑点：OpenCV 默认优先尝试 YUYV 格式；该摄像头 4K 没有 YUYV，**不手动指定 MJPG FOURCC，会自动降级到低分辨率，拿不到 4K 画面**。

示例代码：

```
import cv2

CAP_PATH = "/dev/v4l/by-id/usb-2bdf_02b1-video-index0"
cap = cv2.VideoCapture(CAP_PATH, cv2.CAP_V4L2)

# 必须先设置FOURCC为MJPG，再设置分辨率
cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
cap.set(cv2.CAP_PROP_FPS, 30)

print(f"Opened: {cap.isOpened()}")
print(f"Actual W: {cap.get(cv2.CAP_PROP_FRAME_WIDTH)}")
print(f"Actual H: {cap.get(cv2.CAP_PROP_FRAME_HEIGHT)}")

while True:
    ret, frame = cap.read()
    if not ret:
        print("Frame read failed")
        break
    cv2.imshow("Camera", frame)
    if cv2.waitKey(1) & 0xFF == 27: # ESC退出
        break

cap.release()
cv2.destroyAllWindows()
```

## 五、会议、面试场景使用经验（腾讯会议 Linux）

1. **腾讯会议 Linux 客户端限制**
   - 免费账号对外推流最高仅 **720P**，无论摄像头原始是 1080P/4K，对方看到的画面最高 720P。
   - Linux 版本没有 Windows/macOS 上的 “高清摄像头画质” 开关。
2. **最佳实践**
   - 不要使用 4K 采集开会：4K MJPG 会打满 USB2.0 带宽，极易出现卡顿、丢帧、摄像头断开，网络会议也无法传输 4K。
   - **开会前预先把摄像头硬件锁定 1080P MJPG**，再打开腾讯会议。本地采集 1080P 给到会议软件，压缩输出 720P，人脸细节更好，稳定性更高。
   - 务必直插笔记本 / 主机原生 USB 口，**禁止扩展坞、USB Hub**。
   - 软件设备列表选择：`4K USB Camera`，不要误选笔记本内置摄像头。

> 结论：**该摄像头用于面试、线上会议完全够用，但不要迷信 4K 宣传参数。4K 更多用于本地预览，不适合实时网络会议。**

## 六、优缺点总结

### 优点

1. UVC 标准免驱，Ubuntu 开箱即用，不需要厂商私有 SDK。
2. CMOS 成像素质不错，普通室内办公灯光下人脸成像清晰。
3. 自带麦克风，会议可直接使用。
4. 价格友好，满足线上面试、远程答辩需求。

### 缺点与限制

1. **硬件为 USB2.0，无法升级 USB3.0，线材一体不可更换**。高码率 4K MJPG 存在带宽压力，线材信号差会丢帧。
2. 4K 输出只支持 MJPG 压缩格式，无 4K YUYV 无压缩流。
3. Linux 腾讯会议免费账号对外输出最高 720P，无法发挥硬件 4K 用于远程通信。
4. 不适合长时间高负载 4K 本地采集 AI 推理场景，带宽瓶颈会显现。

## 七、使用建议清单

- 📌会议面试：固定硬件输出 1080P MJPG，不要开启 4K。
- 📌物理连接：直插主机 / 笔记本原生 USB 口，拒绝 Hub 与扩展坞。
- 📌程序开发：优先使用`by‑id`路径，避免`/dev/videoX`编号漂移。
- 📌OpenCV 采集：**必须手动设置 FOURCC 为 MJPG**，否则分辨率异常降级。
- 📌本地 4K 测试：仅用于调试，不用于线上会议。
