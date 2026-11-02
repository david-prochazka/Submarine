import { Search, Plus, Server, Monitor, TerminalSquare, Folder, FolderPlus, ChevronRight, ArrowLeft, ArrowRight, LayoutGrid, List, MoreHorizontal, Pencil, Trash2, Zap, Check, X, Copy, GripVertical, ShieldAlert, KeyRound, ArrowUpDown } from "lucide-react";
import { useState, useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { useConfirm } from "../ui/confirm";
import { HeldReview } from "./HeldReview";
import { HeldDeletions } from "./HeldDeletions";
import { folderTree } from "../util/folderTree";
import { sinceLabel } from "../util/lastConnected";
import { ServersEmpty, type ImportRequest } from "./ServersEmpty";

export type ServerStatus = "connected" | "connecting" | "failed";

const STATUS: Record<ServerStatus, { label: string; tone: string; dot: string }> = {
  connected: { label: "Connected", tone: "bg-success/[0.12] text-success", dot: "bg-success" },
  connecting: { label: "Connecting", tone: "bg-warning/[0.13] text-warning", dot: "bg-warning animate-pulse motion-reduce:animate-none" },
  failed: { label: "Disconnected", tone: "bg-danger/[0.12] text-danger", dot: "bg-danger" },
};

const PROTOCOLS: Record<string, { label: string; icon: typeof Server }> = {
  ssh: { label: "SSH", icon: Server },
  rdp: { label: "RDP", icon: Monitor },
  vnc: { label: "VNC", icon: Monitor },
  telnet: { label: "Telnet", icon: TerminalSquare },
};
const protocolOf = (s: any) => PROTOCOLS[s.protocol] ?? PROTOCOLS.ssh;

const addressOf = (s: any) => `${s.username ? `${s.username}@` : ""}${s.host}:${s.port ?? 22}`;

const tunnelCount = (s: any) => {
  try { const t = JSON.parse(s.tunnels || "[]"); return Array.isArray(t) ? t.length : 0; } catch { return 0; }
};

type ViewMode = "grid" | "list";
type SortMode = "manual" | "name" | "recent";
const VIEW_KEY = "submarine-servers-view";
const SORT_KEY = "submarine-servers-sort";
const SORT_LABELS: Record<SortMode, string> = { manual: "Your order", name: "Name", recent: "Last connected" };

const readPref = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
  try {
    const v = localStorage.getItem(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  } catch { return fallback; }
};
const writePref = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch { /* storage blocked: the choice lasts this run */ }
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export const NodeGrid = ({ servers, folders, activeFolderId: activeFolderIdProp, onActiveFolderChange, onOpenServer, onEditServer, onAddClick, onQuickConnect, onRemoveServer, onRemoveFolder, onRenameFolder, onCreateFolder, onMoveServer, onMoveFolder, onCloneServer, onReorderServers, onAllowHeld, keyChange, onAcceptKey, heldDeletions, onResolveDeletions, serverStatus = {}, lastConnected = {}, onImport, isMobile }: any) => {
  const [search, setSearch] = useState("");
  const [view, setViewState] = useState<ViewMode>(() => readPref(VIEW_KEY, ["grid", "list"] as const, "grid"));
  const setView = (v: ViewMode) => { setViewState(v); writePref(VIEW_KEY, v); };
  const [sort, setSortState] = useState<SortMode>(() => readPref(SORT_KEY, ["manual", "name", "recent"] as const, "manual"));
  const setSort = (v: SortMode) => { setSortState(v); writePref(SORT_KEY, v); };
  // The card whose "More" menu is open.
  const [menuFor, setMenuFor] = useState<number | null>(null);
  useEffect(() => {
    if (menuFor === null) return;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as HTMLElement).closest?.("[data-card-menu]")) setMenuFor(null);
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", close);
    };
  }, [menuFor]);
  // Changes someone else made in a shared profile that this device holds
  // back until its user allows them (see HeldReview).
  const heldCount: number = (servers || []).reduce((n: number, s: any) => n + (s.held?.length || 0), 0);
  const [reviewOpen, setReviewOpen] = useState(false);
  const closeReview = useCallback(() => setReviewOpen(false), []);
  // Deletions someone else's sync would have made here, held until the user
  // decides (see HeldDeletions).
  const deletionCount: number = (heldDeletions || []).length;
  const [deletionsOpen, setDeletionsOpen] = useState(false);
  const closeDeletions = useCallback(() => setDeletionsOpen(false), []);
  // Native window.confirm() is a silent no-op inside Tauri's Android WebView
  // (same shim gap useTextPrompt was added for), so the delete buttons here
  // silently did nothing on Android after v0.2.32 made the action cluster
  // always-visible on mobile. Route through the themed useConfirm hook.
  const confirm = useConfirm();
  // A shared profile's new key, waiting for the user's OK: they compare its
  // fingerprint with the one in the owner's Profile panel first. Cancel has
  // the focus, so a stray Enter doesn't accept it.
  const reviewKey = async () => {
    if (!keyChange || !onAcceptKey) return;
    const ok = await confirm({
      title: "Use the new key?",
      message:
        `This shared profile's key was replaced, usually because its owner removed someone. The new key's fingerprint is ${keyChange}. ` +
        "Ask the owner whether their Profile panel shows the same one. If it doesn't, the key didn't come from them: don't use it.",
      okLabel: "Use the new key",
      cancelLabel: "Not now",
      safeDefault: true,
    });
    if (ok) onAcceptKey();
  };
  // Folder navigation is controlled when the parent passes both props, so the
  // selection survives NodeGrid unmount/remount (the parent sticks it onto
  // its own state). Falls back to local state for older callers that don't
  // lift the value — same behaviour as before, just optional.
  const [localFolderId, setLocalFolderId] = useState<number | null>(null);
  const activeFolderId: number | null = onActiveFolderChange ? (activeFolderIdProp ?? null) : localFolderId;
  const setActiveFolderId = (next: number | null) => {
    if (onActiveFolderChange) onActiveFolderChange(next);
    else setLocalFolderId(next);
  };
  // Per-folder inline rename state. Only one folder can be in edit mode at
  // a time, so a single { id, draft } slot is enough.
  const [renaming, setRenaming] = useState<{ id: number; draft: string } | null>(null);
  const commitRename = async () => {
    if (!renaming || !onRenameFolder) return;
    const next = renaming.draft.trim();
    if (next && next !== folders?.find((f: any) => f.id === renaming.id)?.name) {
      try { await onRenameFolder(renaming.id, next); } catch { /* parent surfaces error */ }
    }
    setRenaming(null);
  };

  // Folders nest (see util/folderTree): the grid shows the folders and
  // servers directly inside the open folder (or the top level).
  const tree = folderTree(folders);
  // The open folder was deleted (here or on another device): back to the top.
  useEffect(() => {
    if (activeFolderId !== null && folders && !tree.has(activeFolderId)) setActiveFolderId(null);
  }, [activeFolderId, folders]);

  // "Add folder": the name of the folder being made inside the open folder,
  // typed into a draft card at the head of the grid. null when none is open;
  // closed when another folder is opened.
  const [newFolder, setNewFolder] = useState<string | null>(null);
  useEffect(() => { setNewFolder(null); }, [activeFolderId]);
  const commitNewFolder = async () => {
    const name = (newFolder ?? "").trim();
    if (!name || !onCreateFolder) { setNewFolder(null); return; }
    try {
      await onCreateFolder(name, activeFolderId);
      setNewFolder(null);
    } catch { /* parent logs it; the input stays open for a retry */ }
  };

  const needle = search.trim().toLowerCase();
  const filteredServers = servers?.filter((s: any) =>
    !needle ||
    s.name.toLowerCase().includes(needle) ||
    String(s.host).toLowerCase().includes(needle) ||
    String(s.username || "").toLowerCase().includes(needle)
  ) || [];

  const currentFolder = folders?.find((f: any) => f.id === activeFolderId);

  // If search is active, we might want to just show all matching servers flat,
  // or still respect the folder. Let's just show them flat if searching.
  const isSearching = search.trim() !== "";

  const inPlace = isSearching
    ? filteredServers
    : filteredServers.filter((s: any) => tree.serverFolder(s) === activeFolderId);
  const byName = (a: any, b: any) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const displayedServers = sort === "name"
    ? [...inPlace].sort(byName)
    : sort === "recent"
      ? [...inPlace].sort((a: any, b: any) => (lastConnected[b.id] ?? 0) - (lastConnected[a.id] ?? 0) || byName(a, b))
      : inPlace;
  const displayedFolders = isSearching ? [] : tree.childrenOf(activeFolderId);

  // Drag a server or a folder onto a folder card (into it) or onto a step of
  // the path above the grid (up to it). The target under the pointer: a
  // folder id, or "root" for the top level.
  type DropTarget = number | "root";
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const dropTargetRef = useRef<DropTarget | null>(null);
  const targetAt = (x: number, y: number): DropTarget | null => {
    const el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>("[data-drop-folder]");
    if (!el) return null;
    const v = el.dataset.dropFolder;
    return v === "root" ? "root" : Number(v);
  };
  const setTarget = (t: DropTarget | null) => {
    if (dropTargetRef.current === t) return;
    dropTargetRef.current = t;
    setDropTarget(t);
  };

  // ── Modern floating drag-to-reorder (pointer-based: mouse AND touch) ────────
  // Grabbing the grip lifts the node out of the grid: a fixed-position clone
  // follows the pointer (the "floating" tile), the vacated slot shows a dashed
  // placeholder, and the remaining cards reflow with a smooth FLIP animation as
  // the placeholder tracks the pointer's insertion point. Drag it back and the
  // order returns; on release the final order is persisted via onReorderServers
  // and held until the props catch up so there's no flash of the old order.
  // Disabled while searching (results aren't the stored order).
  const canReorder = !!onReorderServers && !isSearching && sort === "manual";
  const [dragId, setDragId] = useState<number | null>(null);
  // Live id order during a drag (null when not dragging). Rendered from when set.
  const [order, setOrder] = useState<number[] | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const cloneRef = useRef<HTMLDivElement | null>(null);
  // Latest values read inside the window listeners without re-subscribing them.
  const orderRef = useRef<number[] | null>(null);
  orderRef.current = order;
  const initialOrderRef = useRef<number[]>([]);
  const onReorderRef = useRef<any>(onReorderServers);
  onReorderRef.current = onReorderServers;
  const onMoveServerRef = useRef<any>(onMoveServer);
  onMoveServerRef.current = onMoveServer;
  const rafRef = useRef<number | null>(null);
  // The scroll container + its scrollTop at drag start. The slot snapshot is in
  // viewport coords; if the list scrolls mid-drag the cards move but the
  // snapshot doesn't, so we subtract the scroll delta to keep them aligned.
  const scrollerRef = useRef<HTMLElement | null>(null);
  const scrollTop0Ref = useRef(0);
  // Pointer + grab geometry for the floating clone.
  const pointerRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const grabOffsetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const cardSizeRef = useRef<{ w: number; h: number }>({ w: 240, h: 64 });
  // Fixed snapshot of the grid CELL centres, captured at drag start. Insertion
  // is computed against these — never the live card rects — because the live
  // cards carry in-flight FLIP transforms that would corrupt the maths (the
  // grid cells themselves don't move as the order changes; only which card
  // occupies each cell does).
  const slotsRef = useRef<{ x: number; y: number; h: number }[]>([]);
  // Per-card rects for FLIP (measured after each render, keyed by server id).
  const flipRects = useRef<Map<number, DOMRect>>(new Map());
  // True once a drag actually moves, so the click synthesized on pointerup
  // doesn't open whatever card sits under the finger. Cleared next tick.
  const draggedRef = useRef(false);

  const moveClone = (x: number, y: number) => {
    const el = cloneRef.current;
    if (el) el.style.transform = `translate(${x - grabOffsetRef.current.x}px, ${y - grabOffsetRef.current.y}px) rotate(1.5deg) scale(1.03)`;
  };

  useEffect(() => {
    if (dragId === null) return;
    document.body.style.userSelect = 'none';
    const move = (e: PointerEvent) => {
      draggedRef.current = true;
      pointerRef.current = { x: e.clientX, y: e.clientY };
      moveClone(e.clientX, e.clientY); // clone tracks the pointer 1:1, every frame
      // Over a folder card or a step of the path: the drop moves it there.
      setTarget(onMoveServerRef.current ? targetAt(e.clientX, e.clientY) : null);
      if (rafRef.current != null) return; // coalesce the reflow recompute
      const px = e.clientX, py = e.clientY;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        if (dropTargetRef.current !== null) {
          // Not a new place in this list: show the list as it was.
          const initial = initialOrderRef.current;
          setOrder((prev) => (prev && prev.length === initial.length && prev.every((v, i) => v === initial[i]) ? prev : [...initial]));
          return;
        }
        // Insertion index = how many grid CELLS sit before the pointer in
        // reading order (earlier row, or same row and left of it), measured
        // against the fixed drag-start snapshot. Counting the dragged card's
        // own cell is intentional: removing dragId below shifts everything left
        // by one, so inserting at this raw count lands the card exactly under
        // the pointer. Pure function of pointer position → no flicker, and it
        // works across rows because the snapshot never moves.
        // Compensate for any list scroll since drag start: the cells moved by
        // this delta in viewport space but the snapshot didn't.
        const sd = scrollerRef.current ? scrollerRef.current.scrollTop - scrollTop0Ref.current : 0;
        let idx = 0;
        for (const c of slotsRef.current) {
          const cy = c.y - sd;
          const before = (cy < py - c.h / 2) || (Math.abs(cy - py) <= c.h / 2 && c.x < px);
          if (before) idx++;
        }
        setOrder((prev) => {
          const base = (prev ?? initialOrderRef.current).filter((x) => x !== dragId);
          const clamped = Math.max(0, Math.min(idx, base.length));
          base.splice(clamped, 0, dragId);
          if (prev && prev.length === base.length && prev.every((v, i) => v === base[i])) return prev;
          return base;
        });
      });
    };
    const finish = () => {
      if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      document.body.style.userSelect = '';
      // Clear any leftover FLIP transforms so cards sit cleanly after the drop.
      gridRef.current?.querySelectorAll<HTMLElement>('[data-sid]').forEach((el) => {
        el.style.transition = ''; el.style.transform = '';
      });
      const target = dropTargetRef.current;
      setTarget(null);
      if (target !== null) {
        // Into a folder (or up the path). The card leaves this list once the
        // move is stored, so the order override goes when it's done.
        Promise.resolve(onMoveServerRef.current?.(dragId, target === "root" ? null : target))
          .catch(() => {})
          .finally(() => setOrder(null));
        setDragId(null);
        setTimeout(() => { draggedRef.current = false; }, 0);
        return;
      }
      const final = orderRef.current;
      const initial = initialOrderRef.current;
      const changed = !!final && (final.length !== initial.length || final.some((v, i) => v !== initial[i]));
      if (changed) {
        // Persist and KEEP `order` applied — the catch-up effect below clears it
        // once get_servers returns the same sequence, so the grid never flashes
        // back to the old order between release and refresh. If the persist
        // FAILS, drop the override so the grid reverts to the real (unchanged)
        // order instead of showing an arrangement the DB never accepted.
        Promise.resolve(onReorderRef.current?.(final)).catch(() => setOrder(null));
      } else {
        setOrder(null); // dropped where it started: revert cleanly
      }
      setDragId(null);
      setTimeout(() => { draggedRef.current = false; }, 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.body.style.userSelect = '';
    };
  }, [dragId]);

  // FLIP: after each drag render, animate every card from its previous box to
  // its new one so the reflow around the placeholder is smooth, not a jump.
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid || order === null) { flipRects.current.clear(); return; }
    grid.querySelectorAll<HTMLElement>('[data-sid]').forEach((el) => {
      const id = Number(el.dataset.sid);
      // Strip any in-flight FLIP transform first so we read the true LAYOUT box,
      // not a mid-animation position — otherwise fast successive moves compound.
      el.style.transition = 'none';
      el.style.transform = '';
      const next = el.getBoundingClientRect();
      const prev = flipRects.current.get(id);
      if (prev) {
        const dx = prev.left - next.left, dy = prev.top - next.top;
        if (dx || dy) {
          el.style.transform = `translate(${dx}px, ${dy}px)`;
          void el.getBoundingClientRect(); // force reflow so the next line animates
          el.style.transition = 'transform 180ms cubic-bezier(0.2,0,0,1)';
          el.style.transform = '';
        }
      }
      flipRects.current.set(id, next);
    });
  }, [order]);

  // Clear the local `order` override once the incoming servers prop reflects it
  // (or the drag ended with no change) — avoids a flash back to the old order.
  useEffect(() => {
    if (dragId !== null || order === null) return;
    const cur = displayedServers.map((s: any) => s.id);
    if (cur.length === order.length && cur.every((v: number, i: number) => v === order[i])) {
      setOrder(null);
    }
  }, [dragId, order, displayedServers]);

  const beginDrag = (e: any, id: number) => {
    if (!canReorder) return;
    e.preventDefault();
    e.stopPropagation();
    const card = (e.currentTarget as HTMLElement).closest('[data-sid]') as HTMLElement | null;
    const r = card?.getBoundingClientRect();
    grabOffsetRef.current = r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: 20, y: 32 };
    cardSizeRef.current = r ? { w: r.width, h: r.height } : { w: 240, h: 64 };
    pointerRef.current = { x: e.clientX, y: e.clientY };
    // Snapshot every grid cell's centre NOW, while all cards are full and
    // untransformed, in visual (row-major) order — the stable reference the
    // move handler counts against.
    const cells = gridRef.current ? Array.from(gridRef.current.querySelectorAll<HTMLElement>('[data-sid]')) : [];
    slotsRef.current = cells.map((el) => {
      const rr = el.getBoundingClientRect();
      return { x: rr.left + rr.width / 2, y: rr.top + rr.height / 2, h: rr.height };
    });
    // Remember the scroll container + position so mid-drag scrolling can be
    // compensated in the move handler (keeps the drop index aligned).
    scrollerRef.current = (gridRef.current?.closest('.custom-scrollbar') as HTMLElement | null) ?? null;
    scrollTop0Ref.current = scrollerRef.current ? scrollerRef.current.scrollTop : 0;
    draggedRef.current = false;
    initialOrderRef.current = displayedServers.map((s: any) => s.id);
    setOrder(initialOrderRef.current);
    setDragId(id);
  };

  // The servers to render, honouring the live drag order when one is active.
  const orderedServers: any[] = (() => {
    if (!order) return displayedServers;
    const byId = new Map<number, any>(displayedServers.map((s: any) => [s.id, s]));
    const out = order.map((id) => byId.get(id)).filter(Boolean);
    // Include any servers not present in `order` (e.g. added mid-drag) at the end.
    for (const s of displayedServers) if (!order.includes(s.id)) out.push(s);
    return out;
  })();

  const draggedServer = dragId != null ? displayedServers.find((s: any) => s.id === dragId) : null;

  // Dragging a folder (by its grip) onto another folder or a step of the
  // path. Folders keep their order, so there's no reordering here; a folder
  // can't go into itself or its own subfolders, nor where it already is.
  const [folderDragId, setFolderDragId] = useState<number | null>(null);
  const folderCloneRef = useRef<HTMLDivElement | null>(null);
  const onMoveFolderRef = useRef<any>(onMoveFolder);
  onMoveFolderRef.current = onMoveFolder;
  const canMoveFolders = !!onMoveFolder && !isSearching;
  const beginFolderDrag = (e: any, id: number) => {
    if (!canMoveFolders) return;
    e.preventDefault();
    e.stopPropagation();
    const card = (e.currentTarget as HTMLElement).closest('[data-drop-folder]') as HTMLElement | null;
    const r = card?.getBoundingClientRect();
    grabOffsetRef.current = r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: 20, y: 32 };
    cardSizeRef.current = r ? { w: r.width, h: r.height } : { w: 240, h: 64 };
    pointerRef.current = { x: e.clientX, y: e.clientY };
    draggedRef.current = false;
    setFolderDragId(id);
  };
  useEffect(() => {
    if (folderDragId === null) return;
    const inside = tree.subtreeOf(folderDragId);
    const from = tree.parentOf(folderDragId);
    const allowed = (t: DropTarget | null) =>
      t !== null && (t === "root" ? from !== null : !inside.has(t) && t !== from);
    document.body.style.userSelect = 'none';
    const move = (e: PointerEvent) => {
      draggedRef.current = true;
      pointerRef.current = { x: e.clientX, y: e.clientY };
      const el = folderCloneRef.current;
      if (el) el.style.transform = `translate(${e.clientX - grabOffsetRef.current.x}px, ${e.clientY - grabOffsetRef.current.y}px) rotate(1.5deg) scale(1.03)`;
      const t = targetAt(e.clientX, e.clientY);
      setTarget(allowed(t) ? t : null);
    };
    const finish = () => {
      document.body.style.userSelect = '';
      const t = dropTargetRef.current;
      setTarget(null);
      if (t !== null) {
        Promise.resolve(onMoveFolderRef.current?.(folderDragId, t === "root" ? null : t)).catch(() => {});
      }
      setFolderDragId(null);
      setTimeout(() => { draggedRef.current = false; }, 0);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      document.body.style.userSelect = '';
    };
  }, [folderDragId]);
  const draggedFolder = folderDragId != null ? folders?.find((f: any) => f.id === folderDragId) : null;

  // Back and forward walk the folders opened here, the way a browser walks
  // pages. Opening a folder from the sidebar counts as a step too.
  const [hist, setHist] = useState<{ stack: (number | null)[]; i: number }>(() => ({ stack: [activeFolderId], i: 0 }));
  useEffect(() => {
    setHist((h) => (h.stack[h.i] === activeFolderId ? h : { stack: [...h.stack.slice(0, h.i + 1), activeFolderId], i: h.i + 1 }));
  }, [activeFolderId]);
  const go = (delta: number) => {
    const i = hist.i + delta;
    if (i < 0 || i >= hist.stack.length) return;
    setHist({ ...hist, i });
    setActiveFolderId(hist.stack[i]);
  };
  const goRef = useRef(go);
  goRef.current = go;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if ((e.target as HTMLElement)?.closest?.("input, textarea, select, [contenteditable]")) return;
      if (e.key === "[") { e.preventDefault(); goRef.current(-1); }
      if (e.key === "]") { e.preventDefault(); goRef.current(1); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const statusOf = (s: any): ServerStatus | null => serverStatus[s.id] ?? null;
  const counts = displayedServers.reduce((c: Record<string, number>, s: any) => {
    const st = statusOf(s);
    if (st) c[st] = (c[st] ?? 0) + 1;
    return c;
  }, {});
  const summary = isSearching
    ? (displayedServers.length === 0 ? "No servers match" : plural(displayedServers.length, "match", "matches"))
    : [
        displayedFolders.length > 0 ? plural(displayedFolders.length, "folder", "folders") : null,
        displayedServers.length > 0 || displayedFolders.length === 0 ? plural(displayedServers.length, "server", "servers") : null,
        counts.connected ? `${counts.connected} connected` : null,
        counts.connecting ? `${counts.connecting} connecting` : null,
        counts.failed ? `${counts.failed} disconnected` : null,
      ].filter(Boolean).join(", ");
  const title = isSearching ? "Search" : currentFolder?.name ?? "All servers";

  const statusPill = (st: ServerStatus) => (
    <span className={`pill ${STATUS[st].tone}`}>
      <span aria-hidden className={`w-1.5 h-1.5 rounded-full ${STATUS[st].dot}`} />
      {STATUS[st].label}
    </span>
  );

  const deleteServer = async (s: any) => {
    setMenuFor(null);
    if (await confirm({ title: "Delete server?", message: `“${s.name}” will be removed from this profile.`, destructive: true })) {
      onRemoveServer(s.id);
    }
  };

  // Hidden until the card is hovered or holds the focus, on a device that
  // can hover; always shown on touch.
  const reveal = (pinned: boolean) => pinned
    ? ""
    : "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:translate-y-[3px] [@media(hover:hover)]:group-hover:opacity-100 [@media(hover:hover)]:group-hover:translate-y-0 [@media(hover:hover)]:group-focus-within:opacity-100 [@media(hover:hover)]:group-focus-within:translate-y-0";

  const actions = (s: any, compact = false) => {
    const open = menuFor === s.id;
    return (
      <div className={`flex items-center justify-end gap-1.5 transition duration-150 ${reveal(open)}`} onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => onOpenServer(s)} className="btn btn-primary btn-sm">Connect</button>
        <button type="button" onClick={() => onEditServer(s)} aria-label={`Edit ${s.name}`} title="Edit" className="btn btn-sm px-1.5">
          <Pencil size={13} aria-hidden />
        </button>
        {(onCloneServer || onRemoveServer) && (
          <div data-card-menu className="relative">
            <button
              type="button"
              onClick={() => setMenuFor(open ? null : s.id)}
              aria-label={`More for ${s.name}`}
              aria-haspopup="menu"
              aria-expanded={open}
              className="btn btn-sm px-1.5"
            >
              <MoreHorizontal size={13} aria-hidden />
            </button>
            {open && (
              <div role="menu" className={`absolute right-0 z-30 min-w-[150px] p-1 rounded-lg bg-elevated shadow-pop ${compact ? "bottom-full mb-1" : "top-full mt-1"}`}>
                {onCloneServer && (
                  <button type="button" role="menuitem" onClick={() => { setMenuFor(null); onCloneServer(s.id); }} className="w-full flex items-center gap-2 h-7 px-2 rounded-md text-left text-white hover:bg-white/[0.09]">
                    <Copy size={13} aria-hidden className="text-zinc-400" /> Duplicate
                  </button>
                )}
                {onRemoveServer && (
                  <button type="button" role="menuitem" onClick={() => deleteServer(s)} className="w-full flex items-center gap-2 h-7 px-2 rounded-md text-left text-danger hover:bg-danger/10">
                    <Trash2 size={13} aria-hidden /> Delete
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const grip = (s: any, className: string) => canReorder ? (
    // Pointer only, so not a Tab stop: from the keyboard it would do nothing.
    <button
      type="button"
      tabIndex={-1}
      aria-hidden
      onPointerDown={(e) => beginDrag(e, s.id)}
      onClick={(e) => e.stopPropagation()}
      title={onMoveServer ? "Drag to reorder, or onto a folder" : "Drag to reorder"}
      className={`p-0.5 rounded text-zinc-500 hover:text-white cursor-grab active:cursor-grabbing transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100 ${className}`}
      style={{ touchAction: "none" }}
    >
      <GripVertical size={14} />
    </button>
  ) : null;

  const iconTile = (s: any, size = 36) => {
    const P = protocolOf(s);
    return (
      <span
        aria-hidden
        className="shrink-0 rounded-[9px] flex items-center justify-center bg-white/[0.06] text-zinc-400"
        style={{ width: size, height: size, color: s.color || undefined }}
      >
        <P.icon size={Math.round(size * 0.47)} />
      </span>
    );
  };

  // Plain keyed elements, not nested components, so React keeps the same DOM
  // node across renders: that's what lets the FLIP effect animate real
  // positions. The card being dragged stays as a dashed placeholder; the
  // floating clone (portal, below) is what the pointer carries.
  const renderCard = (s: any) => {
    if (dragId === s.id) {
      return <div key={`server-${s.id}`} data-sid={s.id} aria-hidden className="min-h-[136px] rounded-[10px] border-2 border-dashed border-primary/40 bg-primary/[0.05]" />;
    }
    const st = statusOf(s);
    const since = sinceLabel(lastConnected[s.id]);
    const tunnels = tunnelCount(s);
    return (
      <article
        key={`server-${s.id}`}
        data-sid={s.id}
        aria-label={s.name}
        onClick={() => { if (!draggedRef.current) onOpenServer(s); }}
        className="group tile tile-hover p-4 cursor-pointer"
      >
        {grip(s, "absolute left-0.5 top-[25px]")}
        <div className="flex items-start gap-3">
          {iconTile(s)}
          <div className="flex-1 min-w-0">
            <h3 className="text-[14px] leading-5 font-semibold text-white">
              {/* A button so the keyboard can open it too: its click bubbles to the card. */}
              <button type="button" className="block max-w-full truncate text-left rounded-sm">{s.name}</button>
            </h3>
            <div className="mt-px font-mono text-[12px] text-zinc-400 truncate">{addressOf(s)}</div>
          </div>
          {st && statusPill(st)}
        </div>
        <div className="flex flex-wrap gap-1.5 mt-3.5">
          <span className="chip">{protocolOf(s).label}</span>
          {s.jump_host_id != null && <span className="chip">Via jump host</span>}
          {tunnels > 0 && <span className="chip">{plural(tunnels, "tunnel", "tunnels")}</span>}
          {s.autostart && <span className="chip">Opens at start</span>}
        </div>
        <div className="relative flex items-center mt-3.5 h-6">
          <span className={`text-[12px] text-zinc-500 transition-opacity hidden [@media(hover:hover)]:inline ${menuFor === s.id ? "opacity-0" : "group-hover:opacity-0 group-focus-within:opacity-0"}`}>
            {since ? `Last connected ${since.charAt(0).toLowerCase()}${since.slice(1)}` : "Not connected from this device yet"}
          </span>
          <div className="absolute right-0 top-0">{actions(s)}</div>
        </div>
      </article>
    );
  };

  const renderRow = (s: any, i: number) => {
    if (dragId === s.id) {
      return (
        <tr key={`server-${s.id}`} data-sid={s.id} aria-hidden>
          <td colSpan={6} className="p-0"><div className="h-11 border-2 border-dashed border-primary/40 bg-primary/[0.05]" /></td>
        </tr>
      );
    }
    const st = statusOf(s);
    const P = protocolOf(s);
    return (
      <tr
        key={`server-${s.id}`}
        data-sid={s.id}
        onClick={() => { if (!draggedRef.current) onOpenServer(s); }}
        className={`group h-11 cursor-pointer hover:bg-white/5 focus-within:bg-white/5 ${i > 0 ? "border-t border-white/[0.075]" : ""}`}
      >
        <td className="pl-4 pr-3 relative">
          {grip(s, "absolute left-0 top-1/2 -translate-y-1/2")}
          <span className="flex items-center gap-2.5 min-w-0 font-medium text-white">
            <span aria-hidden className="w-2 h-2 shrink-0 rounded-full" style={{ background: s.color || "rgb(var(--subtle))" }} />
            <button type="button" className="truncate text-left rounded">{s.name}</button>
          </span>
        </td>
        <td className="hidden sm:table-cell px-3 font-mono text-[12px] text-zinc-400 truncate">{addressOf(s)}</td>
        <td className="hidden md:table-cell px-3 text-zinc-400">
          <span className="flex items-center gap-1.5"><P.icon size={13} aria-hidden />{P.label}</span>
        </td>
        <td className="hidden lg:table-cell px-3 text-zinc-400 truncate">{sinceLabel(lastConnected[s.id]) ?? "—"}</td>
        <td className="px-3">
          {st
            ? <span className={`flex items-center gap-1.5 ${STATUS[st].tone.split(" ").pop()}`}><span aria-hidden className={`w-1.5 h-1.5 rounded-full ${STATUS[st].dot}`} />{STATUS[st].label}</span>
            : <span className="text-zinc-500">Idle</span>}
        </td>
        <td className="pr-3">{actions(s, true)}</td>
      </tr>
    );
  };

  // Folders: compact tiles above the servers. Open one with a click, drop a
  // server or folder on it to move it in, rename or delete it in place.
  const folderTile = (f: any) => {
    const serverCount = servers?.filter((s: any) => tree.serverFolder(s) === f.id).length || 0;
    const folderCount = tree.childrenOf(f.id).length;
    const isRenaming = renaming?.id === f.id;
    const isTarget = dropTarget === f.id;
    const contents = [
      folderCount > 0 ? plural(folderCount, "folder", "folders") : null,
      plural(serverCount, "server", "servers"),
    ].filter(Boolean).join(", ");
    return (
      <div
        key={`folder-${f.id}`}
        data-drop-folder={f.id}
        onClick={() => { if (!isRenaming && !draggedRef.current) setActiveFolderId(f.id); }}
        className={`group tile flex items-center gap-3 h-14 pl-3 pr-2 cursor-pointer ${
          isTarget ? "bg-primary/10 shadow-[0_0_0_1.5px_rgb(var(--primary))]" : "tile-hover"
        } ${folderDragId === f.id ? "opacity-40" : ""}`}
      >
        {canMoveFolders && !isRenaming && (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            onPointerDown={(e) => beginFolderDrag(e, f.id)}
            onClick={(e) => e.stopPropagation()}
            title="Drag into another folder"
            className="absolute left-0 top-1/2 -translate-y-1/2 p-0.5 rounded text-zinc-500 hover:text-white cursor-grab active:cursor-grabbing transition-opacity [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100"
            style={{ touchAction: "none" }}
          >
            <GripVertical size={14} />
          </button>
        )}
        <span aria-hidden className="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center bg-white/[0.06]" style={{ color: f.color || undefined }}>
          <Folder size={16} className={f.color ? "" : "text-zinc-400"} />
        </span>
        <div className="flex-1 min-w-0">
          {isRenaming ? (
            <input
              autoFocus
              aria-label="Folder name"
              value={renaming!.draft}
              onChange={(e) => setRenaming({ id: f.id, draft: e.target.value })}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                if (e.key === "Escape") { e.preventDefault(); setRenaming(null); }
              }}
              className="field h-7"
            />
          ) : (
            <>
              <h3 className="font-medium text-white leading-[18px]">
                <button type="button" className="block max-w-full truncate text-left rounded-sm">{f.name}</button>
              </h3>
              <span className="block text-[12px] text-zinc-500 truncate">{contents}</span>
            </>
          )}
        </div>
        {isRenaming ? (
          <div className="flex items-center shrink-0" onClick={(e) => e.stopPropagation()}>
            <button type="button" onClick={commitRename} aria-label="Save name" className="icon-btn text-success"><Check size={14} /></button>
            <button type="button" onClick={() => setRenaming(null)} aria-label="Cancel" className="icon-btn"><X size={14} /></button>
          </div>
        ) : (
          <div className={`flex items-center shrink-0 transition ${reveal(false)}`} onClick={(e) => e.stopPropagation()}>
            {onRenameFolder && (
              <button type="button" onClick={() => setRenaming({ id: f.id, draft: f.name || "" })} aria-label={`Rename ${f.name}`} title="Rename" className="icon-btn">
                <Pencil size={13} />
              </button>
            )}
            {onRemoveFolder && (
              <button
                type="button"
                onClick={async () => {
                  // Everything below goes too: say how much.
                  const inside = tree.subtreeOf(f.id);
                  const subfolders = inside.size - 1;
                  const allServers = servers?.filter((s: any) => inside.has(tree.serverFolder(s) as number)).length || 0;
                  const what = [
                    subfolders > 0 ? plural(subfolders, "folder", "folders") : null,
                    plural(allServers, "server", "servers"),
                  ].filter(Boolean).join(" and ");
                  const message = subfolders > 0
                    ? `“${f.name}” and everything inside it (${what}) will be removed.`
                    : `“${f.name}” and every server inside it (${what}) will be removed.`;
                  if (await confirm({ title: "Delete folder?", message, destructive: true })) onRemoveFolder(f.id);
                }}
                aria-label={`Delete ${f.name}`}
                title="Delete"
                className="icon-btn hover:text-danger"
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const banner = (icon: React.ReactNode, text: React.ReactNode, onReview: () => void) => (
    <div role="status" className="flex items-center gap-3 rounded-lg bg-warning/[0.13] px-3 py-2 text-[12.5px] text-white">
      <span className="text-warning shrink-0">{icon}</span>
      <span className="flex-1 min-w-0">{text}</span>
      <button type="button" onClick={onReview} className="btn btn-sm shrink-0">Review</button>
    </div>
  );

  const isEmpty = servers?.length === 0 && folders?.length === 0;
  const showFolders = displayedFolders.length > 0 || (!isSearching && newFolder !== null);
  const path = activeFolderId !== null && !isSearching ? tree.pathOf(activeFolderId) : [];

  return (
    <div className="flex-1 flex flex-col h-full min-h-0 bg-surface">
      <header className="h-[52px] shrink-0 flex items-center gap-2 pl-2.5 pr-3 border-b border-white/[0.075]">
        <div className="flex gap-0.5">
          <button type="button" onClick={() => go(-1)} disabled={hist.i === 0} aria-label="Back" title="Back (⌘[)" className="icon-btn">
            <ArrowLeft size={16} aria-hidden />
          </button>
          <button type="button" onClick={() => go(1)} disabled={hist.i >= hist.stack.length - 1} aria-label="Forward" title="Forward (⌘])" className="icon-btn">
            <ArrowRight size={16} aria-hidden />
          </button>
        </div>
        {/* Each step above the open folder opens it, and takes a server or
            folder dropped on it. */}
        <nav aria-label="Location" className="flex items-center gap-0.5 flex-1 min-w-0 overflow-hidden">
          {[{ id: "root", name: "Servers" }, ...path].map((step: any, i: number, all: any[]) => {
            const last = i === all.length - 1;
            const target: DropTarget = step.id === "root" ? "root" : step.id;
            return (
              <span key={String(step.id)} className={`flex items-center gap-0.5 ${last ? "min-w-0" : "shrink-0"}`}>
                {i > 0 && <ChevronRight size={13} aria-hidden className="text-zinc-500 shrink-0" />}
                {last ? (
                  <span aria-current="page" className="h-6 px-1.5 flex items-center rounded-[5px] font-semibold text-white truncate">{step.name}</span>
                ) : (
                  <button
                    type="button"
                    data-drop-folder={target}
                    onClick={() => setActiveFolderId(step.id === "root" ? null : step.id)}
                    className={`h-6 px-1.5 rounded-[5px] max-w-[12rem] truncate transition-colors ${
                      dropTarget === target ? "bg-primary/15 text-primary shadow-[0_0_0_1.5px_rgb(var(--primary))]" : "text-zinc-400 hover:bg-white/5 hover:text-white"
                    }`}
                  >
                    {step.name}
                  </button>
                )}
              </span>
            );
          })}
        </nav>
        {!isEmpty && (
          <div className="flex items-center gap-2 shrink-0">
            <div role="group" aria-label="Layout" className="seg">
              <button type="button" onClick={() => setView("grid")} aria-pressed={view === "grid"} aria-label="Grid" title="Grid" className="seg-item">
                <LayoutGrid size={14} aria-hidden />
              </button>
              <button type="button" onClick={() => setView("list")} aria-pressed={view === "list"} aria-label="List" title="List" className="seg-item">
                <List size={14} aria-hidden />
              </button>
            </div>
            {onCreateFolder && (
              <button type="button" onClick={() => setNewFolder((v) => v ?? "")} aria-label="New folder" title="New folder" className="icon-btn">
                <FolderPlus size={16} aria-hidden />
              </button>
            )}
            <button type="button" onClick={() => onAddClick(activeFolderId)} aria-label="New server" className="btn">
              <Plus size={14} aria-hidden /><span className="hidden sm:inline">New server</span>
            </button>
            {onQuickConnect && (
              <button type="button" onClick={onQuickConnect} aria-label="Quick connect" title="Connect to a host that isn't saved" className="btn btn-primary">
                <Zap size={14} aria-hidden /><span className="hidden sm:inline">Quick connect</span>
              </button>
            )}
          </div>
        )}
      </header>

      {reviewOpen && onAllowHeld && <HeldReview servers={servers || []} onAllow={onAllowHeld} onClose={closeReview} />}
      {deletionsOpen && onResolveDeletions && <HeldDeletions items={heldDeletions || []} onResolve={onResolveDeletions} onClose={closeDeletions} />}

      {isEmpty ? (
        <ServersEmpty onNewServer={() => onAddClick(null)} onQuickConnect={onQuickConnect} onImport={(req: ImportRequest) => onImport?.(req)} />
      ) : (
        <div className={`flex-1 overflow-y-auto custom-scrollbar ${isMobile ? "px-4 pt-5 pb-8" : "px-8 pt-7 pb-10"}`}>
          {(heldCount > 0 && onAllowHeld) || (deletionCount > 0 && onResolveDeletions) || (keyChange && onAcceptKey) ? (
            <div className="flex flex-col gap-2 mb-5">
              {heldCount > 0 && onAllowHeld && banner(
                <ShieldAlert size={15} />,
                heldCount === 1
                  ? "A change from someone you share this profile with is waiting for your OK."
                  : `${heldCount} changes from people you share this profile with are waiting for your OK.`,
                () => setReviewOpen(true),
              )}
              {deletionCount > 0 && onResolveDeletions && banner(
                <Trash2 size={15} />,
                <>{deletionCount === 1 ? "An item was" : `${deletionCount} items were`} deleted by someone you share this profile with. {deletionCount === 1 ? "It stays" : "They stay"} here until you decide.</>,
                () => setDeletionsOpen(true),
              )}
              {keyChange && onAcceptKey && banner(
                <KeyRound size={15} />,
                "This shared profile's key has changed. Your changes aren't uploaded until you accept the new key.",
                reviewKey,
              )}
            </div>
          ) : null}

          <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
            <div className="min-w-0">
              <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.01em] text-white truncate">{title}</h1>
              <p className="mt-0.5 text-zinc-400">{summary}</p>
            </div>
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <label className="relative block flex-1 sm:w-[220px] sm:flex-none">
                <Search size={14} aria-hidden className="absolute left-[9px] top-1/2 -translate-y-1/2 text-zinc-500" />
                <input
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Filter by name or host"
                  aria-label="Filter servers"
                  className="field pl-7"
                />
              </label>
              <label className="btn btn-ghost relative pr-2 hover:bg-white/[0.09]">
                <ArrowUpDown size={13} aria-hidden />
                <span className="hidden sm:inline">Sort: {SORT_LABELS[sort].toLowerCase()}</span>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortMode)}
                  aria-label="Sort servers"
                  className="absolute inset-0 opacity-0 cursor-pointer"
                >
                  {(Object.keys(SORT_LABELS) as SortMode[]).map((k) => <option key={k} value={k}>{SORT_LABELS[k]}</option>)}
                </select>
              </label>
            </div>
          </div>

          {showFolders && (
            <section aria-label="Folders" className="mb-6">
              <div className={`grid gap-3 ${isMobile ? "grid-cols-1" : "grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"}`}>
                {/* Plain JSX, not a nested component, so typing keeps focus. */}
                {!isSearching && newFolder !== null && (
                  <div className="tile flex items-center gap-3 h-14 pl-3 pr-2 shadow-[0_0_0_1px_rgb(var(--primary))]">
                    <span aria-hidden className="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center bg-primary/[0.12] text-primary">
                      <FolderPlus size={16} />
                    </span>
                    <input
                      autoFocus
                      aria-label="New folder name"
                      placeholder="Folder name"
                      value={newFolder}
                      onChange={(e) => setNewFolder(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") { e.preventDefault(); commitNewFolder(); }
                        if (e.key === "Escape") { e.preventDefault(); setNewFolder(null); }
                      }}
                      className="field flex-1 min-w-0"
                    />
                    <button type="button" onClick={commitNewFolder} disabled={!newFolder.trim()} aria-label="Create folder" className="icon-btn text-success"><Check size={14} /></button>
                    <button type="button" onClick={() => setNewFolder(null)} aria-label="Cancel new folder" className="icon-btn"><X size={14} /></button>
                  </div>
                )}
                {displayedFolders.map(folderTile)}
              </div>
            </section>
          )}

          {displayedServers.length > 0 && (view === "grid" ? (
            <div ref={gridRef} className={`grid gap-4 ${isMobile ? "grid-cols-1" : "md:grid-cols-2 xl:grid-cols-3 min-[1800px]:grid-cols-4"}`}>
              {orderedServers.map(renderCard)}
            </div>
          ) : (
            <div className="rounded-[10px] bg-panel shadow-[0_0_0_0.5px_var(--border)]">
              <table className="w-full table-fixed border-collapse">
                <caption className="sr-only">Servers in {title}</caption>
                <colgroup>
                  <col className="w-[34%] sm:w-[24%]" />
                  <col className="hidden sm:table-column sm:w-[26%]" />
                  <col className="hidden md:table-column md:w-[10%]" />
                  <col className="hidden lg:table-column lg:w-[14%]" />
                  <col className="w-[30%] sm:w-[13%]" />
                  <col className="w-[36%] sm:w-[170px]" />
                </colgroup>
                <thead>
                  <tr className="h-8 text-left text-[11.5px] font-semibold text-zinc-500 border-b border-white/[0.075]">
                    <th scope="col" className="pl-4 pr-3 font-semibold">Name</th>
                    <th scope="col" className="hidden sm:table-cell px-3 font-semibold">Address</th>
                    <th scope="col" className="hidden md:table-cell px-3 font-semibold">Protocol</th>
                    <th scope="col" className="hidden lg:table-cell px-3 font-semibold">Last connected</th>
                    <th scope="col" className="px-3 font-semibold">Status</th>
                    <th scope="col" className="pr-3"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody ref={gridRef as any}>
                  {orderedServers.map(renderRow)}
                </tbody>
              </table>
            </div>
          ))}

          {!isSearching && displayedServers.length === 0 && displayedFolders.length === 0 && newFolder === null && (
            <div className="py-12 text-center text-zinc-500">
              <p>Nothing in this folder yet.</p>
              <button type="button" onClick={() => onAddClick(activeFolderId)} className="btn mt-3">
                <Plus size={14} aria-hidden /> New server here
              </button>
            </div>
          )}

          {canReorder && displayedServers.length > 1 && !isMobile && (
            <p className="flex items-center gap-2 mt-7 text-[12px] text-zinc-500">
              <GripVertical size={13} aria-hidden />
              Drag a server by its handle to reorder it, or onto a folder or a step of the path to move it.
            </p>
          )}
        </div>
      )}

      {/* The copy the pointer carries while the list reflows underneath.
          pointer-events:none so it never gets in the way of elementFromPoint. */}
      {draggedServer && createPortal(
        <div
          ref={cloneRef}
          className="fixed left-0 top-0 z-[9999] pointer-events-none will-change-transform"
          style={{
            width: cardSizeRef.current.w,
            transform: `translate(${pointerRef.current.x - grabOffsetRef.current.x}px, ${pointerRef.current.y - grabOffsetRef.current.y}px) rotate(1.5deg) scale(1.03)`,
          }}
        >
          <div className="tile flex items-center gap-3 p-3 bg-elevated shadow-[0_0_0_1px_rgb(var(--primary)),var(--shadow-pop)]">
            {iconTile(draggedServer, 32)}
            <div className="min-w-0 flex-1">
              <div className="font-semibold text-white truncate">{draggedServer.name}</div>
              <div className="font-mono text-[12px] text-zinc-400 truncate">{addressOf(draggedServer)}</div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {draggedFolder && createPortal(
        <div
          ref={folderCloneRef}
          className="fixed left-0 top-0 z-[9999] pointer-events-none will-change-transform"
          style={{
            width: cardSizeRef.current.w,
            transform: `translate(${pointerRef.current.x - grabOffsetRef.current.x}px, ${pointerRef.current.y - grabOffsetRef.current.y}px) rotate(1.5deg) scale(1.03)`,
          }}
        >
          <div className="tile flex items-center gap-3 h-14 pl-3 pr-2 bg-elevated shadow-[0_0_0_1px_rgb(var(--primary)),var(--shadow-pop)]">
            <span aria-hidden className="w-8 h-8 shrink-0 rounded-lg flex items-center justify-center bg-white/[0.06]" style={{ color: draggedFolder.color || undefined }}>
              <Folder size={16} className={draggedFolder.color ? "" : "text-zinc-400"} />
            </span>
            <span className="font-medium text-white truncate">{draggedFolder.name}</span>
          </div>
        </div>,
        document.body
      )}
    </div>
  );
};
