const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

const visible = (el: Element) => el.getClientRects().length > 0 && !el.closest("[inert]");

// The open modal in front: the last visible aria-modal element in the
// document. Dialogs portal to the end of <body> or render after the page, so
// a dialog opened from another comes later.
const topModal = (): HTMLElement | null => {
  const all = [...document.querySelectorAll<HTMLElement>('[aria-modal="true"]')].filter(visible);
  return all.length ? all[all.length - 1] : null;
};

// Tab and Shift+Tab wrap inside the modal in front instead of walking out to
// the page behind it. One listener for every dialog, so each one doesn't need
// its own. A key a control already handled (a terminal's Tab) is left alone.
export const installModalTabTrap = () => {
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Tab" || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    const modal = topModal();
    if (!modal) return;
    const items = [...modal.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(visible);
    const now = document.activeElement as HTMLElement | null;
    if (items.length === 0) { e.preventDefault(); modal.focus({ preventScroll: true }); return; }
    const first = items[0];
    const last = items[items.length - 1];
    const inside = !!now && modal.contains(now);
    if (!inside) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
    if (e.shiftKey && (now === first || now === modal)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && now === last) { e.preventDefault(); first.focus(); }
  });
};
