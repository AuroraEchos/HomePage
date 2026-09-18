(() => {
  const article = document.querySelector("#article");
  const titleNode = document.querySelector("#reader-title");
  const noteId = new URLSearchParams(location.search).get("id") || "";
  const note = window.noteCatalog?.notes?.find((item) => item.id === noteId);
  const escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[char]));

  function fail(message) {
    titleNode.textContent = "无法打开这篇笔记";
    article.innerHTML = `<p>${escapeHtml(message)}</p>`;
  }

  function preserveDisplayMath(markdown) {
    const blocks = [];
    const content = markdown.replace(/^[ \t]*\$\$[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\$\$[ \t]*$/gm, (_, formula) => {
      const index = blocks.push(formula) - 1;
      return `<div data-math-block="${index}"></div>`;
    });
    return { content, blocks };
  }

  function restoreDisplayMath(blocks) {
    article.querySelectorAll("[data-math-block]").forEach((node) => {
      const index = Number(node.dataset.mathBlock);
      if (!Number.isInteger(index) || index < 0 || index >= blocks.length) return;
      node.removeAttribute("data-math-block");
      node.textContent = `$$\n${blocks[index]}\n$$`;
    });
  }

  function resolveRelativeUrls(baseUrl) {
    article.querySelectorAll("img[src]").forEach((image) => {
      const value = image.getAttribute("src");
      if (!/^(?:[a-z]+:|\/|#)/i.test(value)) image.src = new URL(value, baseUrl).href;
      image.loading = "lazy";
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

  function prepareDiagrams() {
    return [...article.querySelectorAll("pre code.language-mermaid")].map((code) => {
      const diagram = document.createElement("div");
      diagram.className = "mermaid";
      diagram.source = code.textContent;
      diagram.textContent = code.textContent;
      code.parentElement.replaceWith(diagram);
      return diagram;
    });
  }

  function restoreDiagramSource(diagram) {
    if (diagram.querySelector("svg")) return;
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.className = "language-mermaid";
    code.textContent = diagram.source;
    pre.append(code);
    diagram.replaceWith(pre);
  }

  function loadMermaid() {
    return new Promise((resolve, reject) => {
      if (window.mermaid) return resolve();
      const script = document.createElement("script");
      script.src = "../assets/vendor/mermaid.min.js";
      script.onload = resolve;
      script.onerror = () => reject(new Error("Mermaid 加载失败"));
      document.head.append(script);
    });
  }

  async function renderDiagrams(nodes) {
    if (!nodes.length) return;
    try {
      await loadMermaid();
      window.mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "neutral" });
      await window.mermaid.run({ nodes });
    } catch (error) {
      console.warn("Mermaid rendering failed", error);
      nodes.forEach(restoreDiagramSource);
    }
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
      const math = preserveDisplayMath(markdown);
      const html = window.marked.parse(math.content, { gfm: true, breaks: false });
      article.innerHTML = window.DOMPurify.sanitize(html, { ADD_ATTR: ["data-math-block"] });
      restoreDisplayMath(math.blocks);

      const firstHeading = article.querySelector("h1, h2");
      const title = firstHeading?.textContent.trim() || note.title;
      titleNode.textContent = title;
      document.title = `${title} · Wenhao Liu`;
      if (firstHeading?.tagName === "H1") firstHeading.remove();
      resolveRelativeUrls(requestUrl);
      const diagrams = prepareDiagrams();
      window.renderMathInElement?.(article, {
        throwOnError: false,
        ignoredClasses: ["mermaid"],
        delimiters: [
          { left: "$$", right: "$$", display: true },
          { left: "\\[", right: "\\]", display: true },
          { left: "$", right: "$", display: false },
          { left: "\\(", right: "\\)", display: false },
        ],
      });
      await renderDiagrams(diagrams);
    } catch (error) {
      fail(error.message || "Markdown 文件读取失败。");
    }
  }

  load();
})();
