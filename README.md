# Wenhao Liu — Static Personal Website

纯静态个人技术网站，不需要 Node.js、数据库或构建步骤。页面使用语义化 HTML 和一份只负责基础可读性的共享 CSS；笔记由一个轻量 Markdown 阅读器呈现。

## 页面

- `index.html`：一页式个人主页与网站默认入口
- `notes/reader.html`：Markdown 笔记阅读器
- `songs/`：喜欢的苏联时期歌曲与中俄歌词
- `posts/`：Markdown 原文与笔记图片；新增正文继续放在这里
- `assets/vendor/marked.js`：Markdown 解析器
- `assets/vendor/purify.min.js`：解析结果的 HTML 安全清理
- `assets/vendor/katex/`：数学公式渲染
- `assets/vendor/mermaid.min.js`：Mermaid 图表渲染（按需加载）

根目录的 `index.html` 是唯一的内容索引页，汇总个人介绍、项目、笔记与歌集入口。

## 笔记管理

笔记元数据（日期、分类、标题）以 front-matter 形式写在每篇 Markdown 顶部，示例：

```markdown
---
id: agent-runtime
date: 2026-08-01
category: llm
title: Agent Runtime Notes
---

# 正文标题
```

新增或修改笔记后，在仓库根目录运行：

```bash
python3 tools/build_notes.py
```

`id` 和 `date` 是已发布笔记的必填字段。`id` 是用于公开链接的稳定短标识，只能包含小写字母、数字和连字符，并且不能重复；`date` 必须是真实的 `YYYY-MM-DD` 日期。`category` 可取 `llm`、`agent`、`paper` 或 `other`，省略时使用 `other`；`title` 省略时取正文首个一级标题。

脚本会严格校验所有元数据，同时检查未闭合的代码围栏和失效的本地图片引用，再重新生成 `assets/js/notes-data.js`。该生成文件需要和代码一起提交，不要手动编辑。CI 或提交前可以使用下面的命令检查数据是否为最新：

```bash
python3 tools/build_notes.py --check
```

## 本地预览

Markdown 阅读器需要通过 HTTP 读取文章，不能直接用 `file://` 打开。可在仓库根目录运行：

```bash
python3 -m http.server 8000
```

然后访问 `http://localhost:8000/`。

## 部署到 GitHub Pages

1. 将项目内容放到 GitHub 仓库根目录并推送。
2. 打开仓库的 `Settings → Pages`。
3. 在 `Build and deployment` 中选择 `Deploy from a branch`。
4. 选择 `main` 分支和 `/ (root)` 目录。
5. 保存并等待部署完成。

所有站内资源均使用相对路径。阅读器解析并安全输出 GFM，修正正文中的相对链接和图片路径，并支持 KaTeX 公式与 Mermaid 图表；运行时不依赖 CDN。
