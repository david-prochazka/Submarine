import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { X, History } from "lucide-react";

// ─────────────────────────────────────────────────────────────────────────────
// Command History Search — Ctrl+Shift+R (Cmd+Shift+R on macOS) overlay
//
// Portaled modal that queries the encrypted profile vault's `cmd_history`
// table via the tauri commands defined in lib.rs. Fuzzy-ish (LIKE-based)
// server-side filter plus client-side highlight; keyboard-driven picker.
//
//   Enter        → insert command into the terminal, no newline
//   Shift+Enter  → insert + newline (execute)
//   Esc          → close
//   ↑ / ↓        → move selection
//
// Insert is done by the parent (TerminalView) via the `onInsert` callback
// so we don't have to know about xterm / write_terminal_data plumbing here.
// ─────────────────────────────────────────────────────────────────────────────

export interface CmdHistoryEntry {
  id: number;
  server_id: number | null;
  server_name: string | null;
  command: string;
  ts: number;
  exit_code: number | null;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** Restrict history list to just this server's rows. When null, all rows. */
  filterServerId?: number | null;
  /** Fires when the user picks a row. `execute=true` means the caller should
   *  append a newline (Shift+Enter path). */
  onInsert: (command: string, execute: boolean) => void;
}

const relTime = (ts: number): string => {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

const HistorySearchOverlay = ({ isOpen, onClose, filterServerId, onInsert }: Props) => {
  const [query, setQuery] = useState("");
  const [entries, setEntries] = useState<CmdHistoryEntry[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [restrictToServer, setRestrictToServer] = useState<boolean>(!!filterServerId);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset state on every open — leftover selection / error from a previous
  // session would confuse the user (row 3 highlighted for a totally different
  // list of results).
  useEffect(() => {
    if (!isOpen) return;
    setQuery("");
    setSelectedIdx(0);
    setError(null);
    setRestrictToServer(!!filterServerId);
    // Focus the input a tick after mount so the browser has finished the
    // portal render — otherwise focus() lands on an unmounted element.
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  }, [isOpen, filterServerId]);

  // Query the backend whenever the search text or the "this server only"
  // toggle changes. We debounce with a tiny setTimeout so fast typing
  // doesn't fire an IPC round-trip per keystroke.
  useEffect(() => {
    if (!isOpen) return;
    const handle = setTimeout(() => {
      invoke<CmdHistoryEntry[]>("cmd_history_list", {
        query: query || null,
        limit: 200,
      }).then((rows) => {
        const filtered = restrictToServer && filterServerId != null
          ? rows.filter(r => r.server_id === filterServerId)
          : rows;
        setEntries(filtered);
        setSelectedIdx(0);
        setError(null);
      }).catch((e) => {
        setError(String(e));
        setEntries([]);
      });
    }, 60);
    return () => clearTimeout(handle);
  }, [query, isOpen, restrictToServer, filterServerId]);

  const visibleEntries = entries;

  const commit = useCallback((execute: boolean) => {
    const row = visibleEntries[selectedIdx];
    if (!row) return;
    onInsert(row.command, execute);
    onClose();
  }, [visibleEntries, selectedIdx, onInsert, onClose]);

  // Keep the selected row scrolled into view so ↓ past the visible area
  // doesn't hide the highlight off-screen.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLDivElement>(`[data-idx="${selectedIdx}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [selectedIdx, visibleEntries.length]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx(i => Math.min(visibleEntries.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx(i => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      commit(e.shiftKey);
    }
    e.stopPropagation();
  };

  const emptyMsg = useMemo(() => {
    if (error) return `Error: ${error}`;
    if (query) return `No commands match "${query}".`;
    return "Nothing here yet. Commands you run in a terminal will appear in this list.";
  }, [error, query]);

  if (!isOpen) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[9998] bg-scrim flex items-start justify-center px-4 pt-[12vh]"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="cmd-history-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className="w-full max-w-[680px] flex flex-col max-h-[70vh] bg-elevated rounded-[14px] shadow-sheet overflow-hidden text-[13px] animate-in zoom-in-95 fade-in duration-150"
      >
        <h2 id="cmd-history-title" className="sr-only">Command history</h2>
        <div className="shrink-0 flex items-center gap-2.5 px-4 h-[54px] border-b border-white/[0.075]">
          <History size={18} className="shrink-0 text-zinc-500" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search command history"
            aria-label="Search command history"
            className="flex-1 min-w-0 h-[52px] bg-transparent outline-none text-[16px] text-white placeholder:text-zinc-500"
          />
          <span className="text-[12px] text-zinc-500 tabular-nums">{visibleEntries.length}</span>
          {filterServerId != null && (
            <label className="flex items-center gap-1.5 text-[12px] text-zinc-400 cursor-pointer select-none whitespace-nowrap">
              <input
                type="checkbox"
                className="accent-primary"
                checked={restrictToServer}
                onChange={(e) => setRestrictToServer(e.target.checked)}
              />
              This server only
            </label>
          )}
          <button onClick={onClose} className="icon-btn -mr-1.5" aria-label="Close">
            <X size={14} />
          </button>
        </div>
        <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-2 py-1.5">
          {visibleEntries.length === 0 ? (
            <div className="px-7 py-7 text-center text-zinc-400">
              {emptyMsg}
            </div>
          ) : (
            visibleEntries.map((row, i) => (
              <div
                key={row.id}
                data-idx={i}
                onMouseEnter={() => setSelectedIdx(i)}
                onClick={() => {
                  setSelectedIdx(i);
                  onInsert(row.command, false);
                  onClose();
                }}
                onDoubleClick={() => {
                  onInsert(row.command, true);
                  onClose();
                }}
                className={`px-3 py-2 rounded-lg cursor-default ${i === selectedIdx ? "bg-primary/[0.14]" : ""}`}
              >
                <div className="font-mono text-[12.5px] text-white whitespace-pre-wrap break-all leading-[18px]">
                  {row.command}
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-zinc-500 min-w-0">
                  <span title={new Date(row.ts).toISOString()} className="shrink-0">{relTime(row.ts)} ago</span>
                  {row.server_name && (
                    <>
                      <span aria-hidden>·</span>
                      <span className="truncate">{row.server_name}</span>
                    </>
                  )}
                  {row.exit_code != null && (
                    <>
                      <span aria-hidden>·</span>
                      <span className={`shrink-0 ${row.exit_code === 0 ? "text-success" : "text-danger"}`}>
                        exit {row.exit_code}
                      </span>
                    </>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
        <div className="shrink-0 hidden sm:flex items-center gap-4 px-4 h-9 border-t border-white/[0.075] bg-panel text-[11.5px] text-zinc-500">
          <span><kbd className="font-sans font-medium text-zinc-400">↩</kbd> Insert</span>
          <span><kbd className="font-sans font-medium text-zinc-400">⇧↩</kbd> Insert and run</span>
          <span className="flex-1" />
          <span><kbd className="font-sans font-medium text-zinc-400">esc</kbd> Close</span>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default HistorySearchOverlay;
