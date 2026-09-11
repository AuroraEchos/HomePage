---
date: 2025-09-20
category: other
title: Python Async/Await：协程与异步编程
---

# Python Async/Await：协程与异步编程

`async` 和 `await` 是 Python 编写协程的核心语法。它们最适合处理“等待占比高”的任务，例如网络请求、异步数据库驱动和定时等待：一个任务等待时，事件循环可以运行其他已经就绪的任务。

异步不会自动让单个操作变快，也不会把同步阻塞函数变成非阻塞函数。普通磁盘文件 API、`requests.get()`、`time.sleep()` 或耗时 CPU 计算如果直接放进协程，仍会阻塞事件循环；这类操作需要异步库，或使用线程/进程执行器隔离。

## 同步、异步、并发与并行

- **同步/异步**描述调用者如何等待结果。同步调用通常停在原地等待；异步调用可以把控制权交还给调度器，结果就绪后再恢复。
- **并发**表示多个任务在同一段时间内共同推进。并发既可以来自协程，也可以来自线程或多进程。
- **并行**表示多个任务在同一时刻真正执行，通常依赖多个 CPU 核、GPU 或其他执行单元。

并发不排斥并行：多线程或多进程程序既可以并发，也可能并行。单个 `asyncio` 事件循环通常在一个线程中协作式调度协程，因此同一时刻只执行一段 Python 协程代码；但它也可以通过 `asyncio.to_thread()`、执行器、子进程或异步底层库与其他线程/进程协作。

## 协程与 async/await

用 `async def` 定义的是协程函数。调用它不会立即执行函数体，而是返回协程对象：

```python
async def fetch_value():
    return 1

coroutine = fetch_value()
```

协程需要被 `await`、包装成 Task，或交给事件循环运行。`await` 后面必须是 awaitable，例如协程、Task 或 Future：

```python
async def demo():
    result = await fetch_value()
    print(result)
```

当被等待的对象尚未完成时，当前协程可以暂停并把控制权交还事件循环。是否真的发生切换取决于 awaitable：如果结果已经就绪，它可能直接继续执行。

## 完整示例

```python
import asyncio
import time


async def task(name: str, delay: float) -> str:
    print(f"任务 {name} 开始，需要等待 {delay} 秒")
    await asyncio.sleep(delay)
    print(f"任务 {name} 完成")
    return f"任务 {name} 结果"


async def main():
    start = time.perf_counter()

    # create_task 负责调度协程；任务会在事件循环下次获得控制权时开始推进。
    first = asyncio.create_task(task("A", 2))
    second = asyncio.create_task(task("B", 3))

    results = await asyncio.gather(first, second)
    print(results)
    print(f"总耗时：{time.perf_counter() - start:.2f} 秒")


asyncio.run(main())
```

执行过程如下：

1. `asyncio.run()` 创建事件循环并运行 `main()`。
2. 两个协程被包装为 Task，等待事件循环调度。
3. `main()` 在 `await asyncio.gather(...)` 处让出控制权。
4. A、B 先后运行到 `asyncio.sleep()`，分别挂起计时。
5. 约 2 秒后 A 恢复；约 3 秒后 B 恢复。
6. 总耗时接近 3 秒，而不是 5 秒，因为等待时间发生了重叠。

这里的两个任务是并发，不是 CPU 并行。若把 `asyncio.sleep()` 换成 `time.sleep()`，第一个任务会阻塞事件循环，两个等待就无法重叠。

## 处理阻塞调用与 CPU 密集任务

无法改成异步 API 的短时间阻塞 I/O，可以放到工作线程：

```python
import asyncio
from pathlib import Path


async def read_text(path: str) -> str:
    return await asyncio.to_thread(Path(path).read_text, encoding="utf-8")
```

CPU 密集型 Python 代码通常应考虑多进程、原生扩展或能够释放 GIL 的计算库。把很重的 CPU 工作直接写在协程里，会卡住事件循环；`asyncio` 本身不是绕过 GIL 的 CPU 并行方案。

## 并发安全与取消

“单线程”不等于“不需要并发控制”。多个协程可能在 `await` 之间交错访问共享状态，因此 Python 提供 `asyncio.Lock`、`Queue`、`Semaphore` 等原语。设计协程时还应处理：

- 超时：`asyncio.timeout()` 或 `asyncio.wait_for()`；
- 取消：捕获 `asyncio.CancelledError` 时先清理资源，通常再继续抛出；
- 限流：用 `Semaphore` 控制同时请求数；
- 异常：使用 `TaskGroup`（Python 3.11+）或妥善检查 `gather()` 的结果。

## 核心结论

1. `async def` 定义协程函数，调用后得到协程对象。
2. `await` 暂停的是当前协程，不应阻塞整个事件循环。
3. `asyncio` 的优势是重叠等待时间，适合大量 I/O 并发，而不是让 CPU 计算自动并行。
4. `create_task()` 只负责调度；真正开始运行要等控制权回到事件循环。
5. 同步阻塞函数、共享状态、超时和取消都需要显式处理。

选择协程、线程还是进程，应以依赖库、任务类型、并发量和可维护性为准，不存在对所有场景都成立的固定效率排名。
