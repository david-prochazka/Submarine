import { useEffect, useRef } from "react";

// Keyboard behaviour for a modal dialog that mounts while open: Escape closes
// it, and closing gives focus back to the element that opened it (Tab stays
// inside through installModalTabTrap). Focus moves to the panel unless a field inside it
// took it already (autoFocus). Put the returned ref on the element with
// role="dialog", with tabIndex={-1} so it can hold focus.
export const useModalDialog = (open: boolean, onClose: () => void) => {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  // Read during render: by the time effects run, autoFocus has already moved
  // focus into the dialog and the opener is lost.
  const openerRef = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== "undefined") {
    const had = document.activeElement;
    openerRef.current = had instanceof HTMLElement && had !== document.body ? had : null;
  }
  wasOpen.current = open;

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    if (!panel) return;
    const opener = openerRef.current;
    if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true });

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
      }
    };
    panel.addEventListener("keydown", onKey);
    return () => {
      panel.removeEventListener("keydown", onKey);
      const now = document.activeElement;
      if (opener?.isConnected && (!now || now === document.body || panel.contains(now))) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [open]);

  return panelRef;
};
