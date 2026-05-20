// Shared helper to make a modal frame draggable by a handle element.
// Position is persisted per storageKey in localStorage so the dialog
// remembers where the GM dragged it last time.

const STORAGE_PREFIX = "pf2e-cinematic-merchant:dragpos:";

/**
 * Wire pointer-based drag on `handle` that moves `frame`.
 *
 * @param {HTMLElement} frame      The element to translate.
 * @param {HTMLElement} handle     The element the user grabs.
 * @param {string}      storageKey Stable identifier for persistence.
 * @param {object}      [opts]
 * @param {number}      [opts.margin=40]  Min visible edge so the user can't lose the dialog.
 */
export function makeDraggable(frame, handle, storageKey, opts = {}) {
  if (!frame || !handle) return;
  const margin = opts.margin ?? 40;
  const fullKey = STORAGE_PREFIX + storageKey;

  handle.classList.add("pf2e-cd-mer-drag-handle");

  let startX = 0, startY = 0, startLeft = 0, startTop = 0;
  let activePointerId = null;

  const isInteractive = (target) =>
    !!target.closest?.("button, a, input, select, textarea, [data-role]");

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    if (isInteractive(e.target)) return;
    const rect = frame.getBoundingClientRect();
    frame.style.left = `${rect.left}px`;
    frame.style.top = `${rect.top}px`;
    frame.style.right = "auto";
    frame.style.bottom = "auto";
    frame.style.transform = "none";
    frame.classList.add("is-dragged", "is-dragging");
    startX = e.clientX;
    startY = e.clientY;
    startLeft = rect.left;
    startTop = rect.top;
    activePointerId = e.pointerId;
    handle.setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e) => {
    if (activePointerId !== e.pointerId) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const maxLeft = window.innerWidth - margin;
    const maxTop = window.innerHeight - margin;
    const minLeft = margin - frame.offsetWidth;
    const minTop = 0;
    const left = Math.min(maxLeft, Math.max(minLeft, startLeft + dx));
    const top = Math.min(maxTop, Math.max(minTop, startTop + dy));
    frame.style.left = `${left}px`;
    frame.style.top = `${top}px`;
  };

  const onPointerUp = (e) => {
    if (activePointerId !== e.pointerId) return;
    activePointerId = null;
    handle.releasePointerCapture?.(e.pointerId);
    frame.classList.remove("is-dragging");
    const left = parseFloat(frame.style.left);
    const top = parseFloat(frame.style.top);
    if (Number.isFinite(left) && Number.isFinite(top)) {
      try {
        localStorage.setItem(fullKey, JSON.stringify({ left, top }));
      } catch {}
    }
  };

  handle.addEventListener("pointerdown", onPointerDown);
  handle.addEventListener("pointermove", onPointerMove);
  handle.addEventListener("pointerup", onPointerUp);
  handle.addEventListener("pointercancel", onPointerUp);

  // Double-click on the handle resets the dialog back to its CSS-defined
  // centered position.
  handle.addEventListener("dblclick", (e) => {
    if (isInteractive(e.target)) return;
    frame.classList.remove("is-dragged");
    frame.style.left = "";
    frame.style.top = "";
    frame.style.right = "";
    frame.style.bottom = "";
    frame.style.transform = "";
    try { localStorage.removeItem(fullKey); } catch {}
  });

  // Restore saved position immediately so the dialog opens where the user left it.
  try {
    const raw = localStorage.getItem(fullKey);
    if (raw) {
      const saved = JSON.parse(raw);
      if (Number.isFinite(saved.left) && Number.isFinite(saved.top)) {
        const left = Math.min(window.innerWidth - margin, Math.max(margin - frame.offsetWidth || -600, saved.left));
        const top = Math.min(window.innerHeight - margin, Math.max(0, saved.top));
        frame.style.left = `${left}px`;
        frame.style.top = `${top}px`;
        frame.style.right = "auto";
        frame.style.bottom = "auto";
        frame.style.transform = "none";
        frame.classList.add("is-dragged");
      }
    }
  } catch {}
}
