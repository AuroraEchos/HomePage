"use strict";

function renderNotes() {
  const catalog = window.noteCatalog;
  const groups = document.getElementById("home-notes");

  if (!groups) return;

  if (!catalog || !Array.isArray(catalog.notes) || !catalog.categoryLabels) {
    groups.innerHTML = "<p>笔记目录暂时无法载入，请稍后刷新页面。</p>";
    return;
  }

  groups.replaceChildren();

  Object.entries(catalog.categoryLabels).forEach(([category, label], index) => {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const list = document.createElement("ul");
    const notes = catalog.notes.filter((note) => note.category === category);

    details.open = index === 0;
    summary.textContent = `${label} (${notes.length})`;

    notes.forEach((note) => {
      const item = document.createElement("li");
      const time = document.createElement("time");
      const link = document.createElement("a");
      time.dateTime = note.date.replaceAll(".", "-");
      time.textContent = note.date;
      link.href = `notes/reader.html?id=${encodeURIComponent(note.id)}`;
      link.textContent = note.title;

      item.append(time, document.createTextNode(" — "), link);
      list.append(item);
    });

    if (notes.length === 0) {
      const item = document.createElement("li");
      item.textContent = "暂无笔记。";
      list.append(item);
    }

    details.append(summary, list);
    groups.append(details);
  });
}

function initWindowControls() {
  document.querySelectorAll("[data-window-action]").forEach((control) => {
    control.addEventListener("click", () => {
      const windowElement = control.closest(".window");
      const content = windowElement?.querySelector(".window-content");
      if (!windowElement || !content) return;

      switch (control.dataset.windowAction) {
        case "minimize": {
          const minimized = content.hidden;
          content.hidden = !minimized;
          control.setAttribute("aria-label", minimized ? "最小化" : "还原");
          break;
        }
        case "maximize":
          windowElement.classList.toggle("is-maximized");
          control.setAttribute(
            "aria-label",
            windowElement.classList.contains("is-maximized") ? "还原" : "最大化",
          );
          break;
        case "close":
          windowElement.classList.add("is-closed");
          break;
      }
    });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    document.querySelectorAll(".window.is-maximized").forEach((windowElement) => {
      windowElement.classList.remove("is-maximized");
    });
  });
}

function initClock() {
  const clock = document.getElementById("system-clock");
  if (!clock) return;

  const update = () => {
    const now = new Date();
    clock.dateTime = now.toISOString();
    clock.textContent = new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(now);
  };

  update();
  window.setInterval(update, 1000);
}

renderNotes();
initWindowControls();
initClock();
