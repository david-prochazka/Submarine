import { useEffect, useMemo, useRef, useState, forwardRef, useImperativeHandle } from "react";
import { createPortal } from "react-dom";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { File as FileIcon, Folder, Rows, Columns, LayoutPanelTop, Shield, ShieldAlert, GitCompare } from "lucide-react";
import FilePanel, { ActiveDrag, FilePanelHandle, OverwriteBatch, transferWithOverwriteCheck } from "./FilePanel";
import TransferQueue, { Transfer, TransferFix } from "./TransferQueue";
import type { FileEntry } from "../fs/types";
import MirrorsPanel from "./MirrorsPanel";
import { createLocalProvider } from "../fs/localProvider";
import { createRemoteProvider } from "../fs/remoteProvider";
import { useOverwritePrompt, useTextPrompt } from "../ui/confirm";
import { useIsNarrow } from "../hooks/useViewport";
import { bookmarksKey } from "../util/sftpBookmarks";
import { IS_ANDROID, IS_WINDOWS } from "../util/platform";

// Root (sudo) mode for the remote pane — see `sftp_set_elevated` in lib.rs.
type ElevationStatus = { elevated: boolean; passwordless: boolean };

const SUDO_MESSAGES: Record<string, string> = {
  "[SUDO] NEED_PASSWORD": "sudo needs a password.",
  "[SUDO] WRONG_PASSWORD": "Wrong sudo password.",
  "[SUDO] NOT_ALLOWED": "This user isn't allowed to run sftp-server with sudo.",
  "[SUDO] REQUIRETTY": "sudo on this server requires a terminal (requiretty), so it can't be used for file access.",
  "[SUDO] NO_SUDO": "sudo isn't installed on this server.",
  "[SUDO] NO_SFTP_SERVER": "Couldn't find the sftp-server program on this server.",
};

const describeSudoError = (raw: string) => {
  const code = Object.keys(SUDO_MESSAGES).find((k) => raw.includes(k));
  return code ? SUDO_MESSAGES[code] : raw.replace(/^\[SUDO\] FAILED:?\s*/, "sudo failed: ");
};

const LOCAL_NAME = IS_ANDROID ? "This device" : IS_WINDOWS ? "This PC" : /Mac/i.test(navigator.platform) ? "This Mac" : "This computer";

// Dual-pane SFTP workspace. Owns the two FilePanels, the cross-pane drag
// state, and the global mouseup that turns a release over the opposite pane
// into the source pane's own upload or download (FilePanelHandle.sendTo).

export type SftpView = "files" | "mirror";

interface SftpWorkspaceProps {
  sessionId: string;
  disabled?: boolean;
  // Mirror config from the parent session — both pieces are needed by the
  // nested MirrorsPanel. Mirror lives in this workspace so going between
  // Files and Mirror keeps the mirrors' live state.
  serverId?: number;
  mirrorsConfig?: any[];
  view?: SftpView;
  // The unlocked profile: with the server id it keys the panes' bookmarks
  // (util/sftpBookmarks). A server that isn't saved (Quick Connect) has none.
  profile?: string | null;
  /** Shown beside "Remote" in that pane's header. */
  serverName?: string;
  /** Where the layout and Compare controls go: the tool's header. Without one they get a bar of their own. */
  headerSlot?: HTMLElement | null;
}
// "split" is Local above Remote; the name predates "side" and stays because
// it is what earlier versions saved.
type FilesLayout = "tabs" | "split" | "side";
type FilesSide = "local" | "remote";

const LAYOUT_OPTIONS: { id: FilesLayout; title: string; Icon: typeof Rows }[] = [
  { id: "side", title: "Side by side", Icon: Columns },
  { id: "split", title: "Local above Remote", Icon: Rows },
  { id: "tabs", title: "One at a time", Icon: LayoutPanelTop },
];

const lastName = (path: string) => {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || path;
};

// Where a drag would land: the folder row under the pointer in the other
// pane, or else the folder that pane shows.
interface DropTarget {
  dir: string;
  row: HTMLElement | null;
  list: HTMLElement | null;
}

// Cursor-following drag ghost, isolated into its own component so that the
// per-mousemove position updates re-render ONLY this tiny node — not the whole
// SftpWorkspace and, through it, both (un-memoized) FilePanels with their full
// row lists. The parent drives it imperatively via the ref.
export interface DragGhostHandle {
  show: (drag: ActiveDrag, label: string | null) => void;
  hide: () => void;
}

const DragGhost = forwardRef<DragGhostHandle>((_props, ref) => {
  const [state, setState] = useState<{ drag: ActiveDrag; label: string | null } | null>(null);
  useImperativeHandle(ref, () => ({
    show: (drag, label) => setState({ drag, label }),
    hide: () => setState(null),
  }), []);
  if (!state) return null;
  const { drag, label } = state;
  const first = drag.entries[0];
  // Through a portal, so an ancestor's `transform` / `backdrop-filter`
  // doesn't re-anchor the `position: fixed` element.
  return createPortal(
    <div
      aria-hidden="true"
      style={{ position: "fixed", top: drag.y + 10, left: drag.x + 14, pointerEvents: "none", zIndex: 10000 }}
    >
      <div className="relative w-max max-w-[240px] flex items-center gap-2 px-2.5 py-2 rounded-lg bg-elevated shadow-pop -rotate-2 text-[13px] font-medium text-white">
        {first.isDir
          ? <Folder size={14} className="text-primary shrink-0" />
          : <FileIcon size={14} className="text-zinc-500 shrink-0" />}
        <span className="truncate">{first.name}</span>
        {drag.entries.length > 1 && (
          <span className="absolute -right-2 -top-2 min-w-5 h-5 px-1 rounded-full bg-primary text-black text-[11px] font-bold flex items-center justify-center tabular-nums">
            {drag.entries.length}
          </span>
        )}
      </div>
      {label && <div className="w-max mt-1.5 ml-3 px-1.5 py-0.5 rounded-md bg-elevated shadow-pop text-[11.5px] font-medium text-primary whitespace-nowrap">{label}</div>}
    </div>,
    document.body
  );
});
DragGhost.displayName = "DragGhost";

const QUEUE_OPEN_KEY = "submarine-sftp-queue-open";
const QUEUE_MAX = 100;

const SftpWorkspace = ({ sessionId, disabled = false, serverId = 0, mirrorsConfig = [], view = "files", profile, serverName, headerSlot }: SftpWorkspaceProps) => {
  // Mirror needs a saved server; without one the files always show.
  const shownView: SftpView = view === "mirror" && serverId ? "mirror" : "files";
  // Files layout, kept for every server: side by side unless the user picked
  // otherwise.
  const [layout, setLayout] = useState<FilesLayout>(() => {
    try {
      const v = localStorage.getItem("submarine-sftp-layout");
      return v === "split" || v === "tabs" ? v : "side";
    } catch { return "side"; }
  });
  // Two lists side by side don't fit a phone-width window: there "side" shows
  // as "split", and the saved choice comes back once the window is wider.
  const isNarrow = useIsNarrow();
  const shownLayout: FilesLayout = layout === "side" && isNarrow ? "split" : layout;
  const setLayoutPersisted = (l: FilesLayout) => {
    setLayout(l);
    try { localStorage.setItem("submarine-sftp-layout", l); } catch { /* quota — ignore */ }
  };
  // Active side in tabs mode, per session, so the user returns to the side
  // they were last using.
  const sideStorageKey = `submarine-sftp-side-${sessionId}`;
  const [activeSide, setActiveSide] = useState<FilesSide>(() => {
    try {
      const v = localStorage.getItem(sideStorageKey);
      return v === "remote" ? "remote" : "local";
    } catch { return "local"; }
  });
  const setActiveSidePersisted = (s: FilesSide) => {
    setActiveSide(s);
    try { localStorage.setItem(sideStorageKey, s); } catch { /* ignore */ }
  };
  // Providers are created once per session so the panels' provider identity
  // is stable across renders (the FilePanel's load-on-mount effect keys off it).
  const localProvider = useMemo(() => createLocalProvider(), []);
  const remoteProvider = useMemo(() => createRemoteProvider(sessionId), [sessionId]);

  const localRef = useRef<FilePanelHandle | null>(null);
  const remoteRef = useRef<FilePanelHandle | null>(null);

  // Compare (#18): each pane's listing, for the other to mark its rows by.
  const [compareOn, setCompareOn] = useState(false);
  const [hideSame, setHideSame] = useState(false);
  const [localEntries, setLocalEntries] = useState<FileEntry[]>([]);
  const [remoteEntries, setRemoteEntries] = useState<FileEntry[]>([]);

  // ---- Root (sudo) mode for the remote pane ---------------------------------
  // Elevated = SFTP runs as root through sudo (passwordless or with a password
  // kept in backend memory for this tab only). A direct root login is flagged
  // with the same badge so it's always obvious when file ops have full power.
  const textPrompt = useTextPrompt();
  const overwritePrompt = useOverwritePrompt();
  const [elevation, setElevation] = useState<ElevationStatus>({ elevated: false, passwordless: false });
  const [loginUser, setLoginUser] = useState<string | null>(null);
  const [elevBusy, setElevBusy] = useState(false);
  const [elevError, setElevError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<ElevationStatus>("sftp_elevation_status", { sessionId })
      .then((s) => { if (!cancelled) setElevation(s); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [sessionId]);

  useEffect(() => {
    if (disabled) return;
    let cancelled = false;
    invoke<string>("sftp_login_user", { sessionId })
      .then((u) => { if (!cancelled) setLoginUser(u || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [sessionId, disabled]);

  const flashElevError = (msg: string) => {
    setElevError(msg);
    window.setTimeout(() => setElevError(null), 6000);
  };

  // Turn root mode on: passwordless sudo first, a password only when sudo
  // wants one. True once it is on.
  const elevate = async (): Promise<boolean> => {
    let password: string | null = null;
    for (let wrongTries = 0; ; ) {
      try {
        setElevation(await invoke<ElevationStatus>("sftp_set_elevated", { sessionId, enabled: true, password }));
        return true;
      } catch (e: any) {
        const raw = String(e);
        const wrong = raw.includes("[SUDO] WRONG_PASSWORD");
        if (!wrong && !raw.includes("[SUDO] NEED_PASSWORD")) throw e;
        if (wrong && ++wrongTries >= 3) throw e;
        password = await textPrompt({
          title: "Run file operations as root",
          message: wrong
            ? "Wrong sudo password, try again."
            : "Enter your sudo password. It's kept in memory for this tab only and never saved.",
          password: true,
          keepWhitespace: true,
          okLabel: "Use sudo",
          validate: (v) => (v ? null : "Enter the password"),
        });
        if (password === null) return false;
      }
    }
  };

  const toggleElevation = async () => {
    if (elevBusy || disabled) return;
    setElevBusy(true);
    setElevError(null);
    try {
      if (elevation.elevated) {
        setElevation(await invoke<ElevationStatus>("sftp_set_elevated", { sessionId, enabled: false, password: null }));
      } else if (!(await elevate())) {
        return;
      }
      await remoteRef.current?.refresh();
    } catch (e: any) {
      flashElevError(describeSudoError(String(e)));
    } finally {
      setElevBusy(false);
    }
  };

  const rootByLogin = !elevation.elevated && loginUser === "root";
  // The remote pane's header says how much room this control has (FilePanel
  // sets `data-elev` on the pane): the icon alone, the word, or the word
  // and how root was reached.
  const elevWord = "group-data-[elev=icon]/pane:hidden";
  const elevMore = "hidden group-data-[elev=full]/pane:inline";
  const elevBox = "h-6 px-1.5 shrink-0 flex items-center gap-1 rounded-md text-[12px] font-medium";
  const rootBadgeClass = `${elevBox} bg-danger/[0.12] text-danger`;
  const elevationControl = elevation.elevated ? (
    <button
      type="button"
      onClick={toggleElevation}
      disabled={elevBusy}
      title={`File operations run as root via sudo${elevation.passwordless ? " (passwordless)" : ""}. Click to go back to ${loginUser || "your login user"}.`}
      aria-label="root (sudo)"
      className={`${rootBadgeClass} hover:bg-danger/20 disabled:opacity-50`}
    >
      <ShieldAlert size={13} className="shrink-0" />
      <span className={elevWord}>root<span className={elevMore}> · sudo</span></span>
    </button>
  ) : rootByLogin ? (
    <span title="Logged in as root: file operations run with full privileges." className={rootBadgeClass}>
      <ShieldAlert size={13} className="shrink-0" />
      <span className={elevWord}>root</span>
    </span>
  ) : (
    <button
      type="button"
      onClick={toggleElevation}
      disabled={elevBusy || disabled}
      title="Run file operations as root (sudo)"
      aria-label="sudo"
      className={`${elevBox} text-zinc-400 hover:bg-white/[0.09] hover:text-white disabled:opacity-40`}
    >
      <Shield size={13} className={`shrink-0 ${elevBusy ? "animate-pulse" : ""}`} />
      <span className={elevWord}>{elevBusy ? "…" : "sudo"}</span>
    </button>
  );
  // Why sudo failed: a line of its own under the header, so the whole
  // sentence shows and the buttons keep their places.
  const elevationNote = elevError ? (
    <div role="alert" className="px-3 py-1.5 border-b border-white/[0.075] text-[12px] leading-snug text-danger break-words">{elevError}</div>
  ) : null;

  // Persist the last directory each panel was in per (session, side) so the
  // user lands on the same path next time they open this server. If the
  // saved path no longer exists, FilePanel falls back to provider.homePath().
  const storageKey = `submarine-server-dirs-${sessionId}`;
  const savedDirsRef = useRef<{ local?: string; remote?: string }>(
    (() => {
      try {
        const raw = localStorage.getItem(storageKey);
        return raw ? JSON.parse(raw) : {};
      } catch { return {}; }
    })()
  );
  const saveDir = (side: "local" | "remote", path: string) => {
    savedDirsRef.current[side] = path;
    try { localStorage.setItem(storageKey, JSON.stringify(savedDirsRef.current)); }
    catch { /* quota or private-mode storage — ignore */ }
  };
  // Where each pane keeps its bookmarks; none for a server that isn't saved.
  const bookmarkKeyFor = (side: "local" | "remote") =>
    profile && serverId > 0 ? bookmarksKey(profile, serverId, side) : undefined;

  const [notification, setNotification] = useState<{ msg: string; type: "info" | "success" | "error" } | null>(null);
  const notify = (msg: string, type: "info" | "success" | "error" = "info") => {
    setNotification({ msg, type });
    setTimeout(() => setNotification(null), 4000);
  };

  // ---- Cross-pane drag ------------------------------------------------------
  // The workspace's own element: a drop counts only on its panes.
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Source of truth for the active drag. Updated SYNCHRONOUSLY from the
  // panel's onMove via the ref so the window mouseup handler (which runs in
  // the same tick as the panel's own mouseup that clears it) can still see
  // the source pane and entry.
  const dragRef = useRef<ActiveDrag | null>(null);
  const ghostRef = useRef<DragGhostHandle>(null);
  // The row or list marked as the drop target. Marked through attributes,
  // not state, so a mousemove never re-renders the panes.
  const markedRef = useRef<HTMLElement[]>([]);

  const unmark = () => {
    for (const el of markedRef.current) el.removeAttribute("data-drop");
    markedRef.current = [];
  };

  const dropTargetAt = (x: number, y: number, sourcePane: string): DropTarget | null => {
    const hit = document.elementFromPoint(x, y) as HTMLElement | null;
    const pane = hit?.closest("[data-fs-pane]") as HTMLElement | null;
    if (!pane || !rootRef.current?.contains(pane)) return null;
    if (pane.getAttribute("data-fs-pane") === sourcePane) return null;
    // A folder row: into that folder, as in Finder or Explorer.
    const row = hit?.closest("[data-fs-row-isdir='1']") as HTMLElement | null;
    const rowPath = row?.getAttribute("data-fs-row-path");
    if (row && rowPath) return { dir: rowPath, row, list: null };
    const dir = pane.getAttribute("data-fs-current-path") || "";
    if (!dir) return null;
    return { dir, row: null, list: pane.querySelector<HTMLElement>("[data-fs-list]") };
  };

  const handleDragMove = (drag: ActiveDrag | null) => {
    dragRef.current = drag;
    unmark();
    if (!drag) { ghostRef.current?.hide(); return; }
    const target = dropTargetAt(drag.x, drag.y, drag.paneId);
    const verb = drag.paneId === "local" ? "upload" : "download";
    const count = drag.entries.length;
    if (target) {
      const pill = `Drop to ${verb} ${count === 1 ? "it" : `${count} items`}`;
      if (target.row) {
        target.row.setAttribute("data-drop", pill);
        markedRef.current = [target.row];
      } else if (target.list) {
        target.list.setAttribute("data-drop", pill);
        markedRef.current = [target.list];
      }
    }
    ghostRef.current?.show(drag, target ? `${verb === "upload" ? "Upload" : "Download"} to ${lastName(target.dir)}/` : null);
  };

  // A release over the other pane: the pane the drag came from sends what was
  // dragged there with its own upload or download (folders, several items,
  // the overwrite prompts). A release over another session's workspace (tabs
  // side by side) is not this one's to handle.
  useEffect(() => {
    const onMouseUp = (e: MouseEvent) => {
      const active = dragRef.current;
      if (!active) return;
      // Clear immediately so a second mouseup (e.g. the FilePanel's own
      // listener clearing the ghost) doesn't re-enter this branch.
      dragRef.current = null;
      unmark();
      const target = dropTargetAt(e.clientX, e.clientY, active.paneId);
      if (!target) return;
      const source = active.paneId === "local" ? localRef.current : remoteRef.current;
      source?.sendTo(active.entries, target.dir).catch((err) => notify(`Transfer failed: ${err}`, "error"));
    };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Transfers ------------------------------------------------------------
  // Every transfer of this session, in the order they started. They stay
  // after they end, so a failure can be read and fixed, until the user
  // clears them. A folder delete that takes a while comes through here too
  // (kind "delete"); it goes away by itself once done.
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [queueOpen, setQueueOpen] = useState(() => {
    try { return localStorage.getItem(QUEUE_OPEN_KEY) !== "0"; } catch { return true; }
  });
  const toggleQueue = () => setQueueOpen((v) => {
    try { localStorage.setItem(QUEUE_OPEN_KEY, v ? "0" : "1"); } catch { /* ignore */ }
    return !v;
  });

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    listen<Omit<Transfer, "startedAt">>(`sftp-transfer-${sessionId}`, (event) => {
      const report = event.payload;
      if (!report || !report.id) return;
      const now = performance.now();
      setTransfers((prev) => {
        const i = prev.findIndex((t) => t.id === report.id);
        const before = i >= 0 ? prev[i] : null;
        const next: Transfer = { ...before, ...report, startedAt: before?.startedAt ?? now };
        if (report.status !== "progress") next.endedAt = now;
        // Speed: smoothed over reports at least a fifth of a second apart.
        if (report.kind !== "delete") {
          const at = before?.sampleAt ?? now;
          const from = before?.sampleBytes ?? report.bytes;
          const dt = (now - at) / 1000;
          if (!before) {
            next.sampleAt = now; next.sampleBytes = report.bytes;
          } else if (dt >= 0.2) {
            const instant = Math.max(0, report.bytes - from) / dt;
            next.speed = before.speed ? before.speed * 0.7 + instant * 0.3 : instant;
            next.sampleAt = now; next.sampleBytes = report.bytes;
          }
        }
        let list = i >= 0 ? prev.map((t, j) => (j === i ? next : t)) : [...prev, next];
        // Keep the list bounded: the oldest finished go first.
        while (list.length > QUEUE_MAX) {
          const k = list.findIndex((t) => t.status !== "progress");
          if (k < 0) break;
          list = list.filter((_, j) => j !== k);
        }
        return list;
      });
      if (report.kind === "delete" && report.status === "done") {
        window.setTimeout(() => setTransfers((prev) => prev.filter((t) => t.id !== report.id)), 1800);
      }
    }).then((fn) => { if (disposed) fn(); else unlisten = fn; });
    return () => { disposed = true; if (unlisten) unlisten(); };
  }, [sessionId]);

  const cancelTransfer = (id: string) => {
    // The backend reports "cancelled" once its loop notices the flag.
    invoke("sftp_cancel_transfer", { transferId: id }).catch(() => {});
  };

  const clearFinished = () => setTransfers((prev) => prev.filter((t) => t.status === "progress"));

  const retryTransfer = async (t: Transfer, fix: TransferFix) => {
    if (!t.from || !t.to || t.kind === "delete") return;
    if (fix === "sudo" && !elevation.elevated) {
      try {
        setElevBusy(true);
        if (!(await elevate())) return;
        await remoteRef.current?.refresh();
      } catch (e: any) {
        flashElevError(describeSudoError(String(e)));
        return;
      } finally {
        setElevBusy(false);
      }
    }
    setTransfers((prev) => prev.filter((x) => x.id !== t.id));
    const cmd = `sftp_${t.kind}_${t.dir ? "dir" : "file"}`;
    const args = t.kind === "download"
      ? { sessionId, remotePath: t.from, localPath: t.to }
      : { sessionId, localPath: t.from, remotePath: t.to };
    const batch: OverwriteBatch = { kind: "ask" };
    try {
      const res = await transferWithOverwriteCheck(
        (overwrite) => invoke(cmd, { ...args, overwrite }),
        t.name, t.kind, 1, batch, overwritePrompt,
      );
      if (res === "done") await (t.kind === "download" ? localRef : remoteRef).current?.refresh();
    } catch (err) {
      // A failure the backend reported comes back as a row of its own.
      if (!String(err).startsWith("EXISTS:")) notify(`Retry failed: ${err}`, "error");
    }
  };

  const revealTransfer = (t: Transfer) => {
    if (!t.to) return;
    invoke("local_open_in_explorer", { localPath: t.to }).catch((err) => notify(`Couldn't open the folder: ${err}`, "error"));
  };

  // ---- Controls in the tool's header ----------------------------------------
  const controls = (
    <div className="flex items-center gap-1.5">
      {shownLayout === "tabs" && (
        <div className="seg" role="group" aria-label="Side">
          {(["local", "remote"] as const).map((side) => (
            <button key={side} type="button" className="seg-item" aria-pressed={activeSide === side} onClick={() => setActiveSidePersisted(side)}>
              {side === "local" ? "Local" : "Remote"}
            </button>
          ))}
        </div>
      )}
      <button
        type="button"
        onClick={() => setCompareOn((v) => !v)}
        aria-pressed={compareOn}
        title={compareOn ? "Stop comparing" : "Compare: mark what differs between the two folders"}
        className={`icon-btn ${compareOn ? "bg-primary/15 text-primary hover:text-primary" : ""}`}
      >
        <GitCompare size={14} />
      </button>
      <div role="group" aria-label="Files layout" className="seg">
        {LAYOUT_OPTIONS.filter((o) => o.id !== "side" || !isNarrow).map(({ id, title, Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => setLayoutPersisted(id)}
            title={title}
            aria-label={title}
            aria-pressed={shownLayout === id}
            className="seg-item px-1.5"
          >
            <Icon size={13} />
          </button>
        ))}
      </div>
    </div>
  );

  const queueShown = shownView === "files" && transfers.length > 0;

  return (
    <div ref={rootRef} className="flex-1 flex flex-col h-full overflow-hidden bg-surface relative">
      {/* Files view — dual-pane browser. Stays mounted when Mirror is on top
          so directory state and selection don't reset. Both FilePanels are
          always mounted (one is CSS-hidden in tabs mode) so their folder,
          scroll position and selection survive a side swap. */}
      <div className={`${shownView === "files" ? "flex-1 flex flex-col min-h-0" : "hidden"}`}>
        {shownView === "files" && (headerSlot
          ? createPortal(controls, headerSlot)
          : <div className="shrink-0 h-10 flex items-center justify-end px-2 border-b border-white/[0.075]">{controls}</div>)}

        {compareOn && (
          <div className="shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 border-b border-white/[0.075] bg-panel text-[12px] text-zinc-400">
            <span className="text-zinc-500">Each folder against the other, by name, size and time:</span>
            <span className="flex items-center gap-1.5"><span className="w-1 h-3 rounded-sm bg-amber-400" /> only here</span>
            <span className="flex items-center gap-1.5"><span className="w-1 h-3 rounded-sm bg-rose-400" /> another size or kind</span>
            <span className="flex items-center gap-1.5"><span className="w-1 h-3 rounded-sm bg-emerald-400" /> newer</span>
            <span className="flex items-center gap-1.5"><span className="w-1 h-3 rounded-sm bg-zinc-500" /> older</span>
            <label className="ml-auto flex items-center gap-1.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={hideSame}
                onChange={(e) => setHideSame(e.target.checked)}
                className="accent-[var(--primary-hex)]"
              />
              Hide files that are the same
            </label>
          </div>
        )}
        {/* Both panels share one box: a column for tabs and split, a row
            for side by side. */}
        <div className={`flex-1 min-h-0 flex ${shownLayout === "side" ? "flex-row" : "flex-col"}`}>
          <div className={
            shownLayout === "split"
              ? "flex-1 min-h-0 border-b border-white/[0.14]"
              : shownLayout === "side"
                ? "flex-1 min-w-0 min-h-0 border-r border-white/[0.14]"
                : activeSide === "local" ? "flex-1 min-h-0" : "hidden"
          }>
            <FilePanel
              ref={localRef}
              provider={localProvider}
              subtitle={LOCAL_NAME}
              // The local pane also needs sessionId: its Upload button runs
              // sftp_upload_file / sftp_upload_dir on this session.
              sessionId={sessionId}
              disabled={disabled}
              onDragMove={handleDragMove}
              initialPath={savedDirsRef.current.local}
              onPathChange={(p) => saveDir("local", p)}
              getOppositeDir={() => remoteRef.current?.currentDir()}
              onTransferred={() => remoteRef.current?.refresh()}
              bookmarksKey={bookmarkKeyFor("local")}
              onEntriesChange={setLocalEntries}
              compareWith={compareOn ? remoteEntries : null}
              hideSame={hideSame}
            />
          </div>
          <div className={
            shownLayout === "split"
              ? "flex-1 min-h-0"
              : shownLayout === "side"
                ? "flex-1 min-w-0 min-h-0"
                : activeSide === "remote" ? "flex-1 min-h-0" : "hidden"
          }>
            <FilePanel
              ref={remoteRef}
              provider={remoteProvider}
              subtitle={serverName}
              sessionId={sessionId}
              disabled={disabled}
              onDragMove={handleDragMove}
              initialPath={savedDirsRef.current.remote}
              onPathChange={(p) => saveDir("remote", p)}
              getOppositeDir={() => localRef.current?.currentDir()}
              onTransferred={() => localRef.current?.refresh()}
              bookmarksKey={bookmarkKeyFor("remote")}
              onEntriesChange={setRemoteEntries}
              compareWith={compareOn ? localEntries : null}
              hideSame={hideSame}
              headerExtra={elevationControl}
              headerNote={elevationNote}
              rootMode={elevation.elevated || rootByLogin}
              archiveOff={elevation.elevated ? "Archive and extract aren't available in root mode: they run as the login user, not through sudo" : undefined}
            />
          </div>
        </div>

        {queueShown && (
          <TransferQueue
            transfers={transfers}
            open={queueOpen}
            onToggle={toggleQueue}
            onCancel={cancelTransfer}
            onClearFinished={clearFinished}
            onFix={retryTransfer}
            onReveal={revealTransfer}
            canSudo={!elevation.elevated && !rootByLogin && !disabled}
          />
        )}
      </div>

      {/* Mirror view — kept MOUNTED (CSS hidden) so the live worker's logs
          and progress counters survive when the user pops back to Files. */}
      {!!serverId && (
        <div className={`${shownView === "mirror" ? "flex-1 flex flex-col min-h-0" : "hidden"}`}>
          <MirrorsPanel
            sessionId={sessionId}
            serverId={serverId}
            configuredMirrors={mirrorsConfig}
            disabled={disabled}
          />
        </div>
      )}

      {notification && (
        <div className="absolute bottom-3 inset-x-3 z-50 flex justify-center pointer-events-none">
          <div role="status" className={`max-w-full px-3 py-1.5 rounded-lg bg-elevated shadow-pop text-[12px] [overflow-wrap:anywhere] animate-in fade-in slide-in-from-bottom-4 duration-300 ${
            notification.type === "success" ? "text-success" : notification.type === "error" ? "text-danger" : "text-white"
          }`}>{notification.msg}</div>
        </div>
      )}

      <DragGhost ref={ghostRef} />
    </div>
  );
};

export default SftpWorkspace;
