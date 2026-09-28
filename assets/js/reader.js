(() => {
  const article = document.querySelector("#article");
  const titleNode = document.querySelector("#reader-title");
  const noteId = new URLSearchParams(location.search).get("id") || "";
  const note = window.noteCatalog?.notes?.find((item) => item.id === noteId);
  const vditorRoot = new URL("../assets/vendor/vditor", location.href).href.replace(/\/$/, "");
  const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));

  function fail(message) {
    titleNode.textContent = "无法打开这篇笔记";
    article.innerHTML = `<p>${escapeHtml(message)}</p>`;
  }

  function resolveRelativeUrls(baseUrl) {
    article.querySelectorAll("img[src]").forEach((image) => {
      const value = image.getAttribute("src");
      if (!/^(?:[a-z]+:|\/|#)/i.test(value)) image.src = new URL(value, baseUrl).href;
      image.loading = "lazy";
      image.decoding = "async";
    });
    article.querySelectorAll("a[href]").forEach((link) => {
      const value = link.getAttribute("href");
      if (!/^(?:[a-z]+:|\/|#)/i.test(value)) link.href = new URL(value, baseUrl).href;
      if (/^https?:/i.test(link.href)) {
        link.target = "_blank";
        link.rel = "noopener noreferrer";
      }
    });
  }

  function loadScript(src, id) {
    return new Promise((resolve, reject) => {
      const loaded = document.getElementById(id);
      if (loaded) return resolve();

      const script = document.createElement("script");
      script.id = id;
      script.src = src;
      script.onload = resolve;
      script.onerror = reject;
      document.head.append(script);
    });
  }

  async function prepareMermaid(markdown) {
    if (!/^[ \t]*(?:```|~~~)mermaid\b/im.test(markdown)) return;

    await loadScript(`${vditorRoot}/dist/js/mermaid/mermaid.min.js`, "vditorMermaidScript");
    if (!window.mermaid?.initialize) throw new Error("Mermaid 渲染器加载失败");

    const initialize = window.mermaid.initialize.bind(window.mermaid);
    window.mermaid.initialize = (options) => initialize({ ...options, securityLevel: "strict" });
  }

  async function renderMarkdown(markdown, requestUrl) {
    if (!window.Vditor?.preview) throw new Error("Markdown 渲染器加载失败");
    await prepareMermaid(markdown);

    await window.Vditor.preview(article, markdown, {
      mode: "light",
      lang: "zh_CN",
      cdn: vditorRoot,
      anchor: 1,
      hljs: {
        enable: true,
        lineNumber: false,
        style: "github",
      },
      math: {
        engine: "KaTeX",
        inlineDigit: true,
      },
      markdown: {
        footnotes: true,
        gfmAutoLink: true,
        linkBase: new URL(".", requestUrl).href,
        sanitize: true,
      },
      render: {
        media: { enable: false },
      },
      theme: {
        current: "light",
        path: `${vditorRoot}/dist/css/content-theme`,
      },
    });
  }

  async function load() {
    if (!note || !/^posts\/[^/\\]+\.md$/i.test(note.path) || note.path.includes("..")) {
      return fail("没有找到对应的笔记。");
    }
    if (location.protocol === "file:") {
      return fail("浏览器不允许网页直接读取本地 Markdown。请通过本地 HTTP 服务或 GitHub Pages 打开网站。");
    }

    try {
      const requestUrl = new URL(`../${note.path}`, location.href);
      const response = await fetch(requestUrl);
      if (!response.ok) throw new Error(`文件读取失败（${response.status}）`);
      const raw = await response.text();
      const markdown = raw.replace(/^(?:\uFEFF)?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
      await renderMarkdown(markdown, requestUrl);

      const firstHeading = article.querySelector("h1, h2");
      const title = firstHeading?.textContent.trim() || note.title;
      titleNode.textContent = title;
      document.title = `${title} · Wenhao Liu`;
      if (firstHeading?.tagName === "H1") firstHeading.remove();
      resolveRelativeUrls(requestUrl);
    } catch (error) {
      console.error("Note rendering failed", error);
      fail(error.message || "Markdown 文件读取失败。");
    }
  }

  load();
})();
