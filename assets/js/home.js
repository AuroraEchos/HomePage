"use strict";

const catalog = window.noteCatalog;
const list = document.getElementById("home-notes");
const filters = document.getElementById("note-filters");

if (!catalog || !Array.isArray(catalog.notes) || !catalog.categoryLabels) {
  list.innerHTML = "<li>笔记目录暂时无法载入，请稍后刷新页面。</li>";
} else {
  let activeCategory = "all";

  function renderNotes() {
    const notes = activeCategory === "all"
      ? catalog.notes
      : catalog.notes.filter((note) => note.category === activeCategory);

    list.replaceChildren();

    if (notes.length === 0) {
      const item = document.createElement("li");
      item.textContent = "该分类暂时没有笔记。";
      list.append(item);
      return;
    }

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
  }

  const categories = [
    ["all", "All"],
    ...Object.entries(catalog.categoryLabels),
  ];

  categories.forEach(([key, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.disabled = key === activeCategory;
    button.setAttribute("aria-pressed", String(key === activeCategory));
    button.addEventListener("click", () => {
      activeCategory = key;
      filters.querySelectorAll("button").forEach((candidate) => {
        const active = candidate.dataset.category === activeCategory;
        candidate.disabled = active;
        candidate.setAttribute("aria-pressed", String(active));
      });
      renderNotes();
    });
    button.dataset.category = key;
    filters.append(button, document.createTextNode(" "));
  });

  renderNotes();
}
