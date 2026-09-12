# Wenhao Liu — Static Personal Website

纯静态个人技术网站，不需要 Node.js、数据库或构建步骤。首页采用 90 年代学术主页风格，并内置 Markdown 阅读器。

## 页面

- `index.html`：一页式个人主页与网站默认入口
- `about/`：旧版独立介绍页
- `projects/`：公开项目
- `notes/`：技术笔记列表与阅读页
- `songs/`：喜欢的苏联时期歌曲与中俄歌词
- `posts/`：Markdown 原文与笔记图片；新增正文继续放在这里
- `assets/vendor/`：随站点部署的 Markdown、公式、图表和代码高亮依赖

根目录的 `index.html` 汇总个人介绍、项目、技术笔记与歌集入口。

## 笔记管理

笔记元数据（日期、分类、标题）以 front-matter 形式写在每篇 Markdown 顶部，示例：

```markdown
---
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

`date` 是已发布笔记的必填字段，必须是真实的 `YYYY-MM-DD` 日期。`category` 可取 `llm`、`agent`、`paper` 或 `other`，省略时使用 `other`；`title` 省略时取正文首个一级标题。

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

所有站内资源均使用相对路径。阅读器支持阅读进度、代码高亮与复制、KaTeX 公式、Mermaid 图表、表格及 Markdown 相对路径图片，运行时不依赖 CDN。
