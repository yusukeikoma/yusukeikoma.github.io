// Learn bubbles can be grabbed and moved around. They stay ordinary links: a click, tap or
// Enter still navigates, and a release after a drag does not. Mouse and pen grab right away;
// touch needs a short long-press so a normal swipe keeps scrolling the page.
(() => {
  const DRAG_THRESHOLD = 6;
  const LONG_PRESS_MS = 280;

  for (const bubble of document.querySelectorAll(".learn-bubble")) {
    let start = null;
    let origin = { x: 0, y: 0 };
    let offset = { x: 0, y: 0 };
    let dragging = false;
    let pressTimer = 0;

    const place = (x, y) => {
      offset = { x, y };
      bubble.style.translate = `${x}px ${y}px`;
    };

    const begin = () => {
      dragging = true;
      bubble.classList.add("is-dragging");
      navigator.vibrate?.(8);
    };

    const end = () => {
      clearTimeout(pressTimer);
      if (dragging) {
        bubble.classList.remove("is-dragging");
        // Swallow the click that follows the drag.
        bubble.addEventListener("click", (e) => e.preventDefault(), { capture: true, once: true });
        setTimeout(() => { dragging = false; }, 0);
      }
      start = null;
    };

    bubble.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      start = { x: e.clientX, y: e.clientY };
      origin = { ...offset };
      if (e.pointerType === "touch") {
        pressTimer = setTimeout(() => {
          begin();
          bubble.setPointerCapture(e.pointerId);
        }, LONG_PRESS_MS);
      }
    });

    bubble.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        if (e.pointerType === "touch") {
          // Moved before the long-press fired: this is a scroll, not a grab.
          clearTimeout(pressTimer);
          start = null;
          return;
        }
        begin();
        bubble.setPointerCapture(e.pointerId);
      }
      place(origin.x + dx, origin.y + dy);
    });

    bubble.addEventListener("pointerup", end);
    bubble.addEventListener("pointercancel", end);
    // Keep the page still while a touch drag is in progress.
    bubble.addEventListener("touchmove", (e) => { if (dragging) e.preventDefault(); }, { passive: false });
    bubble.addEventListener("contextmenu", (e) => { if (dragging) e.preventDefault(); });
    bubble.addEventListener("dragstart", (e) => e.preventDefault());
  }
})();
