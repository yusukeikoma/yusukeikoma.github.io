// Keyboard navigation by arrow keys only.
// The page is a stack of rows (header, breadcrumbs, Learn fields, post list, ...), in page order.
//   Left / Right   move within a row.
//   Up / Down      move to the previous / next row. In a row laid out vertically (a list),
//                  they walk its items first and step to the neighbouring row at either end.
//   Home / End     jump to the ends of the row.
//   Tab            moves to the next / previous row too: each row is a single Tab stop
//                  (roving tabindex, WAI-ARIA APG), entered at the item last used.
// With nothing focused, the first arrow press focuses the top-most item in view.
(() => {
  const ROWS = [
    { root: ".header-nav", item: "a, button" },
    { root: ".breadcrumbs", item: "a" },
    { root: "#searchbox", item: "#searchInput" },
    { root: ".learn-bubbles", item: ".learn-bubble" },
    { root: ".learn-steps", item: ".learn-step" },
    { root: "main.main", item: ".post-entry > .entry-link" },
    { root: ".toc", item: "summary, .inner a" },
    { root: ".post-content", item: "a" },
    { root: ".post-tags", item: "a" },
    { root: ".paginav", item: "a" },
    { root: ".pagination", item: "a" },
    { root: ".footer", item: "a" },
  ];
  const last = new WeakMap(); // row root -> item last focused

  const visible = (el) => el.getClientRects().length > 0 && !el.closest("[hidden], [aria-hidden='true']");

  // Rows present on this page, each with its visible items, in document order.
  const rows = () =>
    ROWS.flatMap(({ root, item }) =>
      [...document.querySelectorAll(root)].map((el) => ({
        root: el,
        items: [...el.querySelectorAll(item)].filter(visible),
      })),
    )
      .filter((r) => r.items.length)
      .sort((a, b) => (a.items[0].compareDocumentPosition(b.items[0]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));

  const isVertical = (items) => {
    if (items.length < 2) return false;
    const [a, b] = items.map((el) => el.getBoundingClientRect());
    return b.top >= a.bottom - 1;
  };

  const enterRow = (row, fromAbove) => {
    const remembered = last.get(row.root);
    const target = remembered && row.items.includes(remembered)
      ? remembered
      : fromAbove || !isVertical(row.items) ? row.items[0] : row.items.at(-1);
    target.focus();
  };

  // One Tab stop per row: the item last used, or the first one.
  const roving = () => {
    for (const r of rows()) {
      const current = r.items.includes(last.get(r.root)) ? last.get(r.root) : r.items[0];
      for (const el of r.items) el.tabIndex = el === current ? 0 : -1;
    }
  };
  roving();
  new MutationObserver(roving).observe(document.querySelector("main") || document.body, { childList: true, subtree: true });

  document.addEventListener("focusin", (e) => {
    for (const r of rows()) if (r.items.includes(e.target)) last.set(r.root, e.target);
    roving();
  });

  // Capture phase: decide from where focus was before other handlers (PaperMod's search) move it.
  window.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const all = rows();
    const active = document.activeElement;
    const ri = all.findIndex((r) => r.items.includes(active));

    if (ri < 0) {
      // Nothing of ours focused yet: the first arrow press picks the top-most row in view.
      if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"].includes(e.key)) return;
      if (active && active !== document.body) return; // focus is somewhere else (e.g. a search result)
      const shown = (el) => el.getBoundingClientRect().bottom > 0;
      const row = all.find((r) => r.items.some(shown));
      if (!row) return;
      e.preventDefault();
      row.items.find(shown).focus();
      return;
    }
    // PaperMod's search moves between the input and its results itself.
    if (e.key === "ArrowDown" && active.id === "searchInput" && document.querySelector("#searchResults li")) return;

    const row = all[ri];
    const i = row.items.indexOf(active);
    const vertical = isVertical(row.items);
    const typing = active.matches("input, textarea");
    const within = (j) => row.items[Math.max(0, Math.min(j, row.items.length - 1))].focus();
    const toRow = (d) => { if (all[ri + d]) enterRow(all[ri + d], d > 0); };

    switch (e.key) {
      case "ArrowRight":
      case "ArrowLeft":
        if (typing) return;
        within(i + (e.key === "ArrowRight" ? 1 : -1));
        break;
      case "ArrowDown":
        vertical && i < row.items.length - 1 ? within(i + 1) : toRow(1);
        break;
      case "ArrowUp":
        vertical && i > 0 ? within(i - 1) : toRow(-1);
        break;
      case "Home":
        if (typing) return;
        within(0);
        break;
      case "End":
        if (typing) return;
        within(row.items.length - 1);
        break;
      default:
        return;
    }
    e.preventDefault();
  }, true);
})();
