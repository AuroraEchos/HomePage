"use strict";

const catalog = window.noteCatalog;
const groups = document.getElementById("home-notes");

if (!catalog || !Array.isArray(catalog.notes) || !catalog.categoryLabels) {
  groups.innerHTML = "<p>笔记目录暂时无法载入，请稍后刷新页面。</p>";
} else {
  groups.replaceChildren();

  Object.entries(catalog.categoryLabels).forEach(([category, label]) => {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    const list = document.createElement("ul");
    const notes = catalog.notes.filter((note) => note.category === category);

    summary.textContent = label;

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
