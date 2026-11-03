import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Trash2, X } from "lucide-react";
import { useFocusTrap } from "../ui/confirm";

// Deletions a shared profile's sync would have made here, held until this
// device's user decides (src-tauri/src/approvals.rs, hold_deletions): one
// sync deleting much of the profile at once, or an SSH key. Opened from the
// notice above the server list.

export type HeldDeletion = { uuid: string; entity_type: string; name: string };

const KINDS: [string, string][] = [
  ["servers", "Servers"],
  ["folders", "Folders"],
  ["credentials", "Logins"],
  ["ssh_keys", "SSH keys"],
  ["commands", "Commands"],
  ["notes", "Notes"],
  ["monitor_configs", "Monitoring settings"],
];

export function HeldDeletions({ items, onResolve, onClose }: {
  items: HeldDeletion[];
  onResolve: (deleteThem: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(1, panelRef);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Decided: nothing left to review.
  useEffect(() => {
    if (items.length === 0) onClose();
  }, [items.length, onClose]);

  const decide = async (deleteThem: boolean) => {
    setBusy(true);
    try { await onResolve(deleteThem); } finally { setBusy(false); }
  };
  const groups = KINDS.map(([type, label]) => [label, items.filter((i) => i.entity_type === type)] as const)
    .filter(([, list]) => list.length > 0);

  return createPortal(
    <div className="fixed inset-0 z-[9998] bg-scrim flex items-center justify-center p-4" onClick={onClose}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="held-deletions-title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-[520px] max-h-[80vh] flex flex-col bg-elevated rounded-xl shadow-sheet text-[13px] animate-in zoom-in-95 fade-in duration-150"
      >
        <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-1">
          <div className="flex items-center gap-2.5">
            <Trash2 size={16} aria-hidden className="text-warning shrink-0" />
            <h2 id="held-deletions-title" className="text-[15px] font-semibold text-white">
              Deleted by someone else
            </h2>
          </div>
          <button aria-label="Close" onClick={onClose} className="icon-btn -mr-1 -mt-0.5">
            <X size={14} />
          </button>
        </div>
        <p className="px-4 pb-3 text-zinc-400 leading-[18px]">
          Someone you share this profile with deleted these in one go. They're still here: delete them here too,
          or keep them. Kept items come back for everyone, or, if you can only view this profile, stay on this
          device.
        </p>
        <div className="flex-1 overflow-y-auto custom-scrollbar px-4 pb-2 space-y-3">
          {groups.map(([label, list]) => (
            <section key={label} aria-label={label} className="rounded-[10px] bg-panel shadow-[0_0_0_0.5px_var(--border)] p-3">
              <h3 className="text-[11.5px] font-semibold text-zinc-500 mb-1.5">{label}</h3>
              <ul className="space-y-1">
                {list.map((i) => (
                  <li key={i.uuid} className="text-white break-words">{i.name || "(no name)"}</li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <div className="flex justify-end gap-2 px-4 py-3 border-t border-white/[0.075]">
          <button
            disabled={busy}
            onClick={() => decide(true)}
            className="btn text-danger"
          >
            Delete here too
          </button>
          <button
            disabled={busy}
            onClick={() => decide(false)}
            className="btn btn-primary"
          >
            Keep them
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
