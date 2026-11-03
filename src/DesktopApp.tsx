import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import {
  Plus, X, RefreshCw, Terminal, Trash2,
  ArrowLeftRight, Shield, Cpu, TerminalSquare, List, Edit2,
  StickyNote, Search, Square, Copy, ChevronLeft, MoreVertical, Radio,
  ChevronDown, Columns, LayoutGrid, Pin, PinOff, Server,
  Monitor, Folder, Zap, Download, PanelRight, Activity, KeyRound, Library,
  Settings, ScrollText, Lock, Sun, Moon, ChevronRightSquare, LockKeyhole, Upload,
} from "lucide-react";
import { useBroadcast } from "./ui/broadcast";

import ProfileSelectPage from "./components/ProfileSelectPage";
import logoUrl from "./assets/logo.png";
import PasswordField from "./components/PasswordField";
import QuickConnectModal, { QuickAuth } from "./components/QuickConnectModal";
import { useConfirm } from "./ui/confirm";
import { useSlideOverFocus } from "./ui/slideOverFocus";
import { RenameInput } from "./ui/renameInput";
import { forgetServerBookmarks } from "./util/sftpBookmarks";
import { useIsNarrow } from "./hooks/useViewport";
import { IS_ANDROID } from "./util/platform";
import { FONT_FAMILY_KEY, FONT_SIZE_KEY, readFontFamily, readFontSize } from "./util/terminalFont";
import { SCROLLBACK_KEY, readScrollback } from "./util/terminalScrollback";
import {
  BOLD_BRIGHT_KEY, CUSTOM_THEME_KEY, MIN_CONTRAST_KEY, THEME_KEY,
  readBoldBright, readCustomScheme, readMinContrast, readThemeId, schemeToWindowsTerminalJson,
} from "./util/terminalTheme";
import { USE_LOCAL_SHELL_KEY, readUseLocalShell } from "./util/terminalShell";
import { USE_SSH_AGENT_KEY, readUseSshAgent } from "./util/sshAgent";
import { USE_SSH_CONFIG_KEY, readUseSshConfig } from "./util/sshConfig";
import { DEFAULT_RDP_OPTIONS, readRdpOptions, writeRdpOptions } from "./util/rdpOptions";
import { DEFAULT_VNC_OPTIONS, readVncOptions, writeVncOptions } from "./util/vncOptions";
import { Sidebar } from "./components/Sidebar";
import { NodeGrid, type ServerStatus } from "./components/NodeGrid";
import type { ImportRequest } from "./components/ServersEmpty";
import { readLastConnected, recordConnected } from "./util/lastConnected";
import { folderTree } from "./util/folderTree";
import { CommandScope, describeScope, parseCommandScope, scopeMatches, scopeToJson, serverScopeIds } from "./util/commandScope";
import CommandScopePicker from "./components/CommandScopePicker";
import type { HeldDeletion } from "./components/HeldDeletions";
import ServerEditor from "./components/ServerEditor";
import TerminalView from "./components/TerminalView";
import SettingsPanel from "./components/SettingsPanel";
import ProfilePanel from "./components/ProfilePanel";
import { SessionView, SESSION_VIEWS, MOD_LABEL, isSessionShortcut, type SessionRequest } from "./components/SessionView";
import { CommandPalette, type PaletteItem } from "./components/CommandPalette";
import RdpSessionView from "./components/RdpSessionView";
import TelnetSessionView from "./components/TelnetSessionView";
import VncSessionView from "./components/VncSessionView";
import MonitoringPanel from "./components/MonitoringPanel";
import LoginsVault from "./components/LoginsVault";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { parseObjectList } from "./util/serverJson";
import { readAccent, readAppearance, useAppearance } from "./util/appearance";

const appWindow = getCurrentWindow();

// Sessions can be either DB-backed (saved node, `serverId > 0`) or quick
// connect (one-shot, `serverId === 0` and `quickAuth` populated). SessionView
// forwards `quickAuth` to `initiate_connection` which uses it instead of
// looking up the DB row.
// `serverUuid` is the saved server's sync id, which keys this device's own
// per-server settings (the Shell button, see util/shellSync.ts).
type Session = { id: string; serverId: number; serverName: string; serverUuid?: string | null; protocol?: "ssh" | "rdp" | "telnet" | "vnc"; mirrors?: string; runOnConnect?: string; runOnConnectHeld?: boolean; quickAuth?: QuickAuth | null };

function DesktopApp() {
  const [loading, setLoading] = useState(true);
  const [isUnlocked, setIsUnlocked] = useState(false);
  // Set by Lock: the unlock screen then waits for a click before asking for
  // Windows Hello, instead of asking the moment it opens as it does at start.
  const [lockedByUser, setLockedByUser] = useState(false);
  // Multi-exec broadcast state lives in a shared provider (see App.tsx) so
  // TerminalView instances across every tab can read `enabled` + `targets`
  // without prop-drilling. The pill in the tab strip is the toggle + picker.
  const broadcast = useBroadcast();
  const [broadcastMenuOpen, setBroadcastMenuOpen] = useState(false);
  // `activeProfile` is the name the user picked + unlocked. Stays null
  // until ProfileSelectPage's onUnlocked fires, at which point the app
  // flips straight into the main view — no intermediate state.
  const [activeProfile, setActiveProfile] = useState<string | null>(null);
  // Per-entity cloud sync of the OPEN profile (the new Last-Write-Wins model).
  // `cloudSyncing` gates the sidebar button; `lastSyncLabel` feeds its tooltip.
  const [cloudSyncing, setCloudSyncing] = useState(false);
  const [lastSyncLabel, setLastSyncLabel] = useState<string | null>(null);
  const [activeView, setActiveView] = useState<string>("nodes");
  const [sessions, setSessions] = useState<Session[]>([]);
  // Tracks the live status of each open session ('connecting' | 'connected'
  // | 'failed' | 'disconnected', or 'idle' for an RDP tab on Android that
  // has nothing to connect yet). Updated via the callback every SessionView
  // fires on its own status change — single source of truth for the dot
  // colour on each tab. Cleared when a session is closed.
  const [sessionStatuses, setSessionStatuses] = useState<Record<string, string>>({});
  // Broadcast is live with two or more targets: the banner shows and every
  // keystroke goes to each of them.
  const broadcastLive = broadcast.enabled && broadcast.targetSessionIds.size >= 2;
  // ⌘⇧B (Ctrl+Shift+B elsewhere): start broadcasting, to every open session
  // when fewer than two are picked, or stop.
  const toggleBroadcastRef = useRef<() => void>(() => {});
  toggleBroadcastRef.current = () => {
    if (broadcastLive) { broadcast.disable(); return; }
    if (sessions.length < 2) return;
    if (broadcast.targetSessionIds.size < 2) broadcast.selectAll(sessions.map((s) => s.id));
    broadcast.enable();
  };
  useEffect(() => {
    const mac = /Mac/i.test(navigator.platform || navigator.userAgent);
    const onKey = (e: KeyboardEvent) => {
      const mods = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!mods || !e.shiftKey || e.altKey || e.code !== "KeyB" || e.repeat) return;
      e.preventDefault();
      toggleBroadcastRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  // Right-click menu pinned to a session tab. Closed by any click outside or
  // by choosing one of the menu items.
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  // Names given to session tabs ("Rename tab" in that menu, or a
  // double-click), by session id, so two tabs of one server can differ.
  // Shown wherever the tab's name is; the server's own name stays its
  // identity (logs, prompts, tools). Dropped when the session closes and on
  // lock: session ids come from each profile's server ids, so another
  // profile would reuse them.
  const [tabNames, setTabNames] = useState<Record<string, string>>({});
  // The tab whose menu shows the name editor; gone with the menu.
  const [tabRename, setTabRename] = useState<string | null>(null);
  useEffect(() => { if (!tabMenu) setTabRename(null); }, [tabMenu]);
  const tabLabel = (s: Session) => tabNames[s.id] ?? s.serverName;
  const clearTabName = (sid: string) => setTabNames(prev => { const { [sid]: _, ...rest } = prev; return rest; });
  // Sessions merged into the current session-view canvas. When a session
  // tab is being viewed and this set is non-empty, its SessionView renders
  // side-by-side with each merged partner instead of full-width. Used by
  // the "Merge with…" context action on session tabs so users don't need
  // a separate Compare page to see two servers together.
  const [mergedSessionIds, setMergedSessionIds] = useState<string[]>([]);
  // "Wall" pinboard — a permanent tab at the end of the session strip
  // that hosts a user-controlled grid of individual terminals. Each
  // pin is a (sessionId, terminalId) pair; the tile mounts its OWN
  // TerminalView with `attachOnly=true`, hitching onto the same PTY
  // as the primary xterm in the session tab. That means the session
  // still owns the PTY lifecycle (open on tab creation, close on tab
  // close) and the Wall tile is a live mirror — it receives every
  // byte the PTY writes and can also send input into it. Trade-off:
  // scrollback in the Wall tile only accumulates from the moment of
  // pin (the primary xterm holds the full pre-pin history), and the
  // two xterms may fight briefly over resize_terminal on view switch,
  // which reflows correctly once one settles.
  type WallItem = { id: string; sessionId: string; terminalId: string };
  const [wallItems, setWallItems] = useState<WallItem[]>([]);
  // User-controlled grid density. Higher = smaller tiles, tighter row
  // packing. Clamped at 1..6 which covers phone-portrait (1) through
  // wide-monitor (6) comfortably; anything past 6 makes xterm columns
  // useless.
  const [wallCols, setWallCols] = useState<number>(2);
  // Rows on screen at once (#174): 0 = as many as the tiles need, each at
  // least WALL_MIN_ROW tall; a number = that many rows fill the screen, and
  // tiles past columns × rows scroll.
  const [wallRows, setWallRows] = useState<number>(0);
  // The grid area's height, so each row gets an explicit one. A flexible
  // row grew with the terminal in it, which fits itself to the row: a row
  // that had filled the screen kept doing so, and the Wall scrolled.
  const wallAreaRef = useRef<HTMLDivElement | null>(null);
  const [wallAreaH, setWallAreaH] = useState(0);
  const [wallPickerOpen, setWallPickerOpen] = useState(false);
  // Per-session terminals + active terminal id, bubbled up from each
  // SessionView via onTerminalsChange. Sourced here so the Wall picker
  // and pin/unpin helpers can enumerate terminals without duplicating
  // SessionView's state.
  type SessionTerm = { id: string; title: string; container?: { name: string; useSudo: boolean } };
  const [sessionTerminals, setSessionTerminals] = useState<Record<string, SessionTerm[]>>({});
  const [sessionActiveTerm, setSessionActiveTerm] = useState<Record<string, string>>({});
  const handleTerminalsChange = useCallback((sid: string, terms: SessionTerm[], activeTermId: string) => {
    setSessionTerminals(prev => {
      const cur = prev[sid];
      if (cur && cur.length === terms.length && cur.every((t, i) => t.id === terms[i].id && t.title === terms[i].title)) {
        return prev;
      }
      return { ...prev, [sid]: terms };
    });
    setSessionActiveTerm(prev => (prev[sid] === activeTermId ? prev : { ...prev, [sid]: activeTermId }));
  }, []);
  const wallHasTerminal = (terminalId: string) => wallItems.some(i => i.terminalId === terminalId);
  const pinTerminalToWall = (sid: string, terminalId: string) => {
    if (wallHasTerminal(terminalId)) return;
    setWallItems(prev => [...prev, { id: `wall-${terminalId}`, sessionId: sid, terminalId }]);
  };
  const unpinTerminalFromWall = (terminalId: string) => {
    setWallItems(prev => prev.filter(i => i.terminalId !== terminalId));
  };
  const unpinSessionFromWall = (sid: string) => {
    setWallItems(prev => prev.filter(i => i.sessionId !== sid));
  };
  useEffect(() => {
    const el = wallAreaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWallAreaH(el.clientHeight));
    ro.observe(el);
    setWallAreaH(el.clientHeight);
    return () => ro.disconnect();
  }, [activeView]);
  // The grid's padding and gaps (p-1.5, gap-1.5), and the smallest row:
  // as many rows as needed don't go below 220 px (more scroll), a chosen
  // number of rows not below 120 px.
  const WALL_SPACE = 6;
  const wallRowHeight = (() => {
    const rows = wallRows || Math.max(1, Math.ceil(wallItems.length / wallCols));
    if (!wallAreaH) return "minmax(220px, 1fr)";
    const h = Math.floor((wallAreaH - 2 * WALL_SPACE - (rows - 1) * WALL_SPACE) / rows);
    return `${Math.max(wallRows ? 120 : 220, h)}px`;
  })();
  // Mobile-only session picker toggle. Horizontally-scrolling tabs eat
  // the whole title row on a 400 px phone; replacing them with a compact
  // dropdown gives the tab strip predictable width and matches iOS/
  // Android convention of "current context on top, tap to switch".
  const [mobileSessionPickerOpen, setMobileSessionPickerOpen] = useState(false);
  // Each saved server's live state, from its open session: what the server
  // cards and rows show. A server with no session has no entry.
  const serverStatus = useMemo(() => {
    const out: Record<number, ServerStatus> = {};
    for (const s of sessions) {
      if (!s.serverId) continue;
      const st = sessionStatuses[s.id] ?? "connecting";
      out[s.serverId] = st === "connected" ? "connected" : st === "connecting" ? "connecting" : "failed";
    }
    return out;
  }, [sessions, sessionStatuses]);
  const [lastConnected, setLastConnected] = useState(readLastConnected);
  // The import the servers home asked for; ServerEditor opens its import
  // dialog with it.
  const [importRequest, setImportRequest] = useState<(ImportRequest & { n: number }) | null>(null);
  const handleSessionStatus = useCallback((sessionId: string, status: string) => {
    setSessionStatuses((prev) => (prev[sessionId] === status ? prev : { ...prev, [sessionId]: status }));
  }, []);

  // Sessions whose connect is waiting on the user (host-key, 2FA or login
  // prompt). A background tab's prompt is hidden along with the tab, so the
  // tab strip marks it instead.
  const [promptSessions, setPromptSessions] = useState<Set<string>>(() => new Set());
  const handlePromptChange = useCallback((sessionId: string, waiting: boolean) => {
    setPromptSessions((prev) => {
      if (prev.has(sessionId) === waiting) return prev;
      const next = new Set(prev);
      if (waiting) next.add(sessionId);
      else next.delete(sessionId);
      return next;
    });
  }, []);

  // Maximize state mirrored from the OS window so the title-bar button can
  // swap its icon (single square = maximize, overlapping squares = restore)
  // and so the double-click drag-region handler always knows the correct
  // direction to toggle. Tauri's onResized event fires for every maximize /
  // restore / OS-driven snap, so it's the authoritative signal.
  const [isMaximized, setIsMaximized] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    appWindow.isMaximized().then(setIsMaximized).catch(() => {});
    appWindow.onResized(() => {
      appWindow.isMaximized().then(setIsMaximized).catch(() => {});
    }).then((fn) => { unlisten = fn; }).catch(() => {});
    return () => { if (unlisten) unlisten(); };
  }, []);
  const toggleMaximize = useCallback(() => {
    appWindow.toggleMaximize().catch(console.error);
  }, []);

  // App version for the title bar, pulled from Tauri (tauri.conf.json) rather
  // than hardcoded so it can never drift from the real build. Shown faded next
  // to the brand name; stays empty (renders nothing) if the call ever fails.
  const [appVersion, setAppVersion] = useState<string>("");
  useEffect(() => {
    getVersion().then(setAppVersion).catch(() => {});
  }, []);

  // Persist the user's current folder across NodeGrid unmount/remount cycles.
  // NodeGrid is conditionally rendered (`activeView === "nodes" && ...`), so
  // its local state used to vanish the moment the user opened a session tab
  // — and they'd come back to the root folder view instead of the folder
  // they were browsing. Lifting the state here keeps the position sticky
  // for the whole profile session.
  const [activeFolderId, setActiveFolderId] = useState<number | null>(null);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [isQuickConnectOpen, setIsQuickConnectOpen] = useState(false);
  // The ⌘K palette, and what it last asked of a session (SessionView).
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [monitorAlerts, setMonitorAlerts] = useState(0);
  const [sessionRequest, setSessionRequest] = useState<(SessionRequest & { sid: string }) | null>(null);
  const [servers, setServers] = useState<any[]>([]);
  const [credentials, setCredentials] = useState<any[]>([]);
  const [sshKeys, setSshKeys] = useState<any[]>([]);
  const [folders, setFolders] = useState<any[]>([]);
  const [commands, setCommands] = useState<any[]>([]);
  const [logs, setLogs] = useState<{ msg: string, type: string, time: string }[]>([]);
  const [isCommandPanelOpen, setIsCommandPanelOpen] = useState(false);
  // `scope`: which servers it's for (util/commandScope); null for all of them.
  const [editCommandData, setEditCommandData] = useState<{ id: number | null, title: string, content: string, scope: CommandScope | null }>({ id: null, title: "", content: "", scope: null });

  const [notes, setNotes] = useState<any[]>([]);
  const [isNotePanelOpen, setIsNotePanelOpen] = useState(false);
  const [editNoteData, setEditNoteData] = useState<{ id: number | null, title: string, body: string }>({ id: null, title: "", body: "" });
  // Shared query across Library sub-tabs. Persisting the string across a
  // Commands↔Notes switch lets the user narrow both lists with the same
  // typing — filter is applied against whichever array is active.
  const [libraryQuery, setLibraryQuery] = useState("");
  const [libraryTab, setLibraryTab] = useState<"commands" | "notes">("commands");

  const [isCredPanelOpen, setIsCredPanelOpen] = useState(false);
  const [editCredData, setEditCredData] = useState<any>({ id: null, name: "", auth_type: "password", username: "", password: "", key_id: null });
  
  const [isKeyPanelOpen, setIsKeyPanelOpen] = useState(false);
  const [editKeyData, setEditKeyData] = useState<any>({ id: null, name: "", public_key: "", private_key: "", passphrase: "" });
  const [formError, setFormError] = useState("");
  const commandPanelRef = useSlideOverFocus(isCommandPanelOpen);
  const notePanelRef = useSlideOverFocus(isNotePanelOpen);
  const credPanelRef = useSlideOverFocus(isCredPanelOpen);
  const keyPanelRef = useSlideOverFocus(isKeyPanelOpen);
  // A panel or modal over the app: everything behind it goes inert, so Tab
  // can't walk into a server list or a terminal under the backdrop.
  const overlayOpen = paletteOpen || isPanelOpen || isQuickConnectOpen || isCommandPanelOpen || isNotePanelOpen || isCredPanelOpen || isKeyPanelOpen;

  const defaultNode = {
    id: null as number | null,
    // "ssh", "rdp" (issue #3: it opens in the system's RDP app), "telnet"
    // (#179: it opens in a terminal, over telnet) or "vnc" (its screen in the tab).
    protocol: "ssh" as "ssh" | "rdp" | "telnet" | "vnc",
    // An RDP server's window and sharing on this device (util/rdpOptions).
    rdpOptions: { ...DEFAULT_RDP_OPTIONS },
    // A VNC server's speed and quality on this device (util/vncOptions).
    vncOptions: { ...DEFAULT_VNC_OPTIONS },
    name: "", host: "", port: 22, username: "", password: "",
    // "custom_pass" picked as default because most users adding a new
    // server have a password in hand; the vault option is mainly useful
    // *after* they've saved a few credentials and want to reuse one.
    authType: "custom_pass", credentialId: "", folderId: "", keyId: "",
    proxyType: "none", proxyHost: "", proxyPort: 1080,
    tunnels: [] as { local: string, remote: string, type: string, name?: string, stopped?: boolean }[],
    autostart: false,
    mirrors: [] as { local: string, remote: string, soft_delete: boolean, excludes: string[], conflict_resolution: string }[],
    color: null as string | null,
    // Free-form per-node description / runbook text. Lives on the server row
    // in the encrypted vault. Empty string by default — the textarea in the
    // panel renders a placeholder when blank.
    notes: "" as string,
    // Commands auto-typed into the FIRST terminal on the INITIAL connect only
    // (never on reconnect or extra shells). Newline-separated. Empty = off.
    runOnConnect: "" as string,
    // ProxyJump: id (as a string, like credentialId/folderId) of another node
    // to bounce through. Empty = connect directly. parseInt'd to a number (or
    // null) at save time.
    jumpHostId: "" as string,
    // Read-only attribution shown in the edit panel: who last edited this node
    // (email, when set) + the HLC stamp of that edit. Null on a new node.
    editedBy: null as string | null,
    updatedAt: null as string | null,
    // True only after the user typed into the password field on this form
    // instance. If still false at save time, the backend uses
    // `preserve_password` to keep the existing DB column. Without this
    // flag a transient `reveal_server_password` failure would silently
    // wipe the stored secret.
    password_dirty: false,
  };

  // Live width-based "narrow viewport" flag. Replaces a one-shot UA check
  // that couldn't see a desktop window being shrunk by the user — the new
  // hook updates on every resize so layout swaps follow the actual width.
  const isMobile = useIsNarrow();

  const [newNode, setNewNode] = useState(defaultNode);
  const [appSettings, setAppSettings] = useState({
    // '' = the theme's own accent. See util/appearance.
    primaryColor: readAccent(),
    appearance: readAppearance(),
    terminalFontSize: readFontSize(),
    // '' = the built-in cross-platform monospace stack (see util/terminalFont).
    terminalFontFamily: readFontFamily(),
    // Lines each terminal keeps above the screen. See util/terminalScrollback.
    terminalScrollback: readScrollback(),
    // Colours (util/terminalTheme): a scheme's id, the user's own scheme as
    // Windows Terminal JSON ("" for none), bold in bright colours, and
    // "keep text readable".
    terminalTheme: readThemeId(),
    terminalCustomScheme: (() => { const s = readCustomScheme(); return s ? schemeToWindowsTerminalJson(s) : ""; })(),
    terminalBoldBright: readBoldBright(),
    terminalMinContrast: readMinContrast(),
    // Off by default: terminals start the remote account's own shell, same
    // as before this setting existed. See util/terminalShell.
    useLocalShell: readUseLocalShell(),
    // On by default: logins may use keys from an ssh-agent on this computer.
    // See util/sshAgent.
    useSshAgent: readUseSshAgent(),
    // On by default: connections use what ~/.ssh/config says about a host.
    // See util/sshConfig.
    useSshConfig: readUseSshConfig(),
    // Auto-sync defaults ON. Per-device (localStorage), like the other prefs.
    autoSync: localStorage.getItem('submarine-auto-sync') !== 'off',
    // Background pull cadence in minutes (min 1). Only gates the periodic
    // "pull collaborators' changes" timer — your own edits still push ~6s after
    // you stop typing regardless of this.
    syncIntervalMin: Math.max(1, parseInt(localStorage.getItem('submarine-sync-interval-min') || '5', 10) || 5),
  });

  useAppearance(appSettings.appearance, appSettings.primaryColor);

  useEffect(() => {
    localStorage.setItem(FONT_SIZE_KEY, appSettings.terminalFontSize.toString());
    localStorage.setItem(FONT_FAMILY_KEY, appSettings.terminalFontFamily);
    localStorage.setItem(SCROLLBACK_KEY, String(appSettings.terminalScrollback));
    localStorage.setItem(THEME_KEY, appSettings.terminalTheme);
    if (appSettings.terminalCustomScheme) localStorage.setItem(CUSTOM_THEME_KEY, appSettings.terminalCustomScheme);
    else localStorage.removeItem(CUSTOM_THEME_KEY);
    localStorage.setItem(BOLD_BRIGHT_KEY, appSettings.terminalBoldBright ? 'on' : 'off');
    localStorage.setItem(MIN_CONTRAST_KEY, appSettings.terminalMinContrast ? 'on' : 'off');
    localStorage.setItem(USE_LOCAL_SHELL_KEY, appSettings.useLocalShell ? 'on' : 'off');
    localStorage.setItem(USE_SSH_AGENT_KEY, appSettings.useSshAgent ? 'on' : 'off');
    localStorage.setItem(USE_SSH_CONFIG_KEY, appSettings.useSshConfig ? 'on' : 'off');
    invoke("set_use_ssh_config", { enabled: appSettings.useSshConfig }).catch(() => {});
    localStorage.setItem('submarine-auto-sync', appSettings.autoSync ? 'on' : 'off');
    localStorage.setItem('submarine-sync-interval-min', String(appSettings.syncIntervalMin));
    // Tell already-mounted terminals to re-fit with the new font size / face.
    // Without this dispatch the listener in TerminalView is dead code and
    // users have to close+reopen every terminal to see a size change.
    window.dispatchEvent(new CustomEvent('submarine-settings-changed'));
  }, [appSettings]);

  useEffect(() => {
    // Nothing to set up before the first screen:
    //  - The window's size and position are restored natively by the
    //    window-state plugin. The page never resizes the window.
    //  - `isMobile` is driven by `useIsNarrow()` (live viewport hook).
    //  - The profile picker comes first, so no vault is probed here;
    //    `dbExists` is set inside `handleProfileSelected` when the user picks
    //    a profile.
    setLoading(false);
  }, []);

  // Stable per-session close handler. Allocated once per (sess.id) pair so
  // SessionView's memo comparison stays cheap and the prop reference doesn't
  // change just because some other session re-rendered. The closure reads
  // setters which are themselves stable via useState.
  const closeHandlersRef = useRef<Map<string, () => void>>(new Map());
  const getCloseHandler = useCallback((sessId: string) => {
    let h = closeHandlersRef.current.get(sessId);
    if (!h) {
      h = () => {
        setSessions(prev => prev.filter(s => s.id !== sessId));
        setSessionStatuses(prev => { const { [sessId]: _, ...rest } = prev; return rest; });
        clearTabName(sessId);
        setActiveView(prev => (prev === sessId ? "nodes" : prev));
        // Purge the closing session from broadcast state so a stale id doesn't
        // linger in the target set (would let a user re-enable broadcast and
        // silently exclude a phantom target from the count).
        broadcast.removeSession(sessId);
        // If the closing session was merged as a side pane in another
        // session's canvas, drop it — otherwise the tile would render
        // an empty <SessionView>. Collapse the whole split when it
        // falls below the 2-pane minimum.
        setMergedSessionIds(prev => {
          const next = prev.filter(id => id !== sessId);
          return next.length < 2 ? [] : next;
        });
        // Purge the closing session from the Wall pinboard too — a stale
        // tile with no backing SessionView would render blank.
        setWallItems(prev => prev.filter(i => i.sessionId !== sessId));
        closeHandlersRef.current.delete(sessId);
      };
      closeHandlersRef.current.set(sessId, h);
    }
    return h;
  }, [broadcast]);

  // Stable identity matters: SessionView memoises on prop equality, so a
  // fresh `addLog` reference on every DesktopApp render would force every
  // session subtree to re-render when one session's status flips. Same
  // reasoning as `handleSessionStatus` above.
  const addLog = useCallback((msg: string, type = "info") => {
    // Each entry gets a stable monotonically-increasing id so React can
    // reconcile rows correctly when the list is rendered reversed. Using
    // `key={index}` on a reverse-then-map list (the previous approach)
    // re-keys every row on every push and busts list reconciliation.
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setLogs(prev => [...prev.slice(-99), { id, msg, type, time: new Date().toLocaleTimeString() }]);
  }, []);

  // A sync that deleted rows (deleted on another device, or by whoever sent
  // the server's answer) says so, and where the profile as it was is kept.
  const logRemoved = useCallback((report: { removed?: number; backup?: string | null }) => {
    const n = report.removed ?? 0;
    if (n <= 0) return;
    addLog(
      `Sync removed ${n} item${n === 1 ? "" : "s"} from this profile (deleted elsewhere).` +
        (report.backup ? ` The profile as it was is kept next to its file as ${report.backup}.` : ""),
      "info",
    );
  }, [addLog]);

  // Wrapped in useCallback because these are handed to memoised children
  // (SessionView, MirrorsPanel, etc.). Without stable identity every parent
  // render hands a fresh reference and defeats the child's memo gate.
  const refreshServers = useCallback(async () => {
    try { setServers((await invoke("get_servers")) as any[]); }
    catch (e) { addLog(`SYNC_SERVERS: ${e}`, "error"); }
  }, [addLog]);
  // A session allowed something held for this device's OK (on-connect
  // commands): the servers' `held` lists have changed.
  useEffect(() => {
    const onHeldChanged = () => { refreshServers(); };
    window.addEventListener("submarine-held-changed", onHeldChanged);
    return () => window.removeEventListener("submarine-held-changed", onHeldChanged);
  }, [refreshServers]);
  // Allow what this device holds back for a server (see the review dialog in
  // the server list), then show the list as it now is.
  const allowHeld = useCallback(async (serverId: number, items: string[]) => {
    try {
      await invoke("allow_held", { serverId, items });
      addLog(items.length ? `Allowed ${items.length} held change${items.length === 1 ? "" : "s"}.` : "Allowed the held changes.", "success");
    } catch (e) {
      addLog(`ALLOW_FAILED: ${e}`, "error");
    }
    await refreshServers();
  }, [addLog, refreshServers]);
  const refreshCredentials = useCallback(async () => {
    try { setCredentials((await invoke("get_credentials")) as any[]); }
    catch (e) { addLog(`SYNC_CREDENTIALS: ${e}`, "error"); }
  }, [addLog]);
  const refreshSshKeys = useCallback(async () => {
    try { setSshKeys((await invoke("get_ssh_keys")) as any[]); }
    catch (e) { addLog(`SYNC_SSH_KEYS: ${e}`, "error"); }
  }, [addLog]);
  const refreshFolders = async () => {
    try { setFolders((await invoke("get_folders")) as any[]); }
    catch (e) { addLog(`SYNC_FOLDERS: ${e}`, "error"); }
  };
  const refreshCommands = async () => {
    try { setCommands((await invoke("get_commands")) as any[]); }
    catch (e) { addLog(`SYNC_COMMANDS: ${e}`, "error"); }
  };
  const refreshNotes = async () => {
    try { setNotes((await invoke("get_notes")) as any[]); }
    catch (e) { addLog(`SYNC_NOTES: ${e}`, "error"); }
  };
  const refreshAll = async () => {
    await Promise.all([
      refreshServers(),
      refreshCredentials(),
      refreshSshKeys(),
      refreshFolders(),
      refreshCommands(),
      refreshNotes(),
    ]);
  };

  // What a shared profile waits on the user for: a new key, as a fingerprint
  // (until it's accepted a sync only pulls, see note_share_key), and
  // deletions someone else's sync would have made here (see HeldDeletions).
  const [shareKeyChange, setShareKeyChange] = useState<string | null>(null);
  const [heldDeletions, setHeldDeletions] = useState<HeldDeletion[]>([]);
  const refreshSharedState = useCallback(async () => {
    try {
      const s = await invoke<{ current: string | null; pending: string | null }>("share_key_state");
      setShareKeyChange(s.pending);
    } catch {
      setShareKeyChange(null);
    }
    try {
      setHeldDeletions(await invoke<HeldDeletion[]>("held_deletions_list"));
    } catch {
      setHeldDeletions([]);
    }
  }, []);

  // Per-entity cloud sync of the currently-open profile. Pushes every locally
  // changed record and merges back the server's view (Last-Write-Wins by HLC),
  // without the server ever decrypting anything. A guard prevents overlapping
  // runs; on success we reload all local lists so a pulled change shows at once.
  const handleCloudSync = useCallback(async () => {
    setCloudSyncing(true);
    try {
      const report = await invoke<{ pushed: number; pulled: number; key_change: boolean; removed?: number; backup?: string | null }>("sync_now");
      await refreshAll();
      refreshSharedState();
      setLastSyncLabel(`Last synced ${new Date().toLocaleTimeString()}`);
      addLog(`Cloud sync complete — pushed ${report.pushed}, pulled ${report.pulled}.`, "success");
      logRemoved(report);
      if (report.key_change) {
        addLog("This shared profile's key has changed. Your changes aren't uploaded until you accept the new key (Servers → Review).", "info");
      }
    } catch (e) {
      const msg = String(e);
      if (/NO_TOKEN|invalid_token|Missing auth|401/i.test(msg)) {
        addLog("Cloud sync: not signed in. Open the Cloud panel from the profile picker and sign in first.", "error");
      } else if (/NO_PROFILE_OPEN|DB_NOT_OPEN|NO_KEY|NO_HLC/i.test(msg)) {
        addLog("Cloud sync: no profile open — unlock a profile first.", "error");
      } else {
        addLog(`Cloud sync failed: ${msg}`, "error");
      }
    } finally {
      setCloudSyncing(false);
    }
    // refreshAll closes over stable setters; addLog is memoised. Intentionally
    // excluded to keep this handler identity stable across renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addLog, logRemoved]);

  // ---- Auto-sync (hybrid: after-edit debounce + window focus + interval) ----
  //
  // A quiet counterpart to handleCloudSync: it never toasts. Cloud sync is a
  // background convenience, so a transient network blip or a not-signed-in state
  // must not spew errors while the user is doing something else. Overlap is
  // guarded by a ref (React state is too laggy for timer/event callbacks that
  // fire between renders). Only the OUTCOME that matters — a pull that changed
  // local data — refreshes the UI.
  const autoSyncBusy = useRef(false);
  const isUnlockedRef = useRef(isUnlocked);
  useEffect(() => { isUnlockedRef.current = isUnlocked; }, [isUnlocked]);
  // What a shared profile still waits on from an earlier session shows on unlock.
  useEffect(() => {
    if (isUnlocked) refreshSharedState();
    else { setShareKeyChange(null); setHeldDeletions([]); }
  }, [isUnlocked, refreshSharedState]);
  // The user compared the new key's fingerprint with the owner's: use it, and
  // sync, which uploads again.
  const acceptShareKey = useCallback(async () => {
    try {
      await invoke("accept_share_key");
      addLog("This shared profile now uses its new key.", "success");
    } catch (e) {
      addLog(`Couldn't switch to the new key: ${e}`, "error");
    }
    await handleCloudSync();
  }, [addLog, handleCloudSync]);
  // Mirror cloudSyncing into a ref so quietSync can see a manual sync in flight
  // WITHOUT depending on the state — otherwise every sync would toggle
  // cloudSyncing, change quietSync's identity, and tear down + restart the
  // interval effect, resetting the periodic timer so it might never fire.
  const cloudSyncingRef = useRef(cloudSyncing);
  useEffect(() => { cloudSyncingRef.current = cloudSyncing; }, [cloudSyncing]);

  // When the last background sync actually ran. The focus trigger reads this so
  // it can't out-pace the cadence the user configured — see the interval effect.
  const lastSyncAt = useRef(0);
  // refreshAll is redefined every render, so quietSync (which is deliberately
  // identity-stable) would otherwise capture the very first one forever and
  // repopulate the lists through stale handlers after a pull.
  const refreshAllRef = useRef(refreshAll);
  refreshAllRef.current = refreshAll;

  const quietSync = useCallback(async () => {
    if (autoSyncBusy.current || cloudSyncingRef.current) return;
    if (!isUnlockedRef.current) return;
    autoSyncBusy.current = true;
    setCloudSyncing(true);
    try {
      const report = await invoke<{ pushed: number; pulled: number; key_change: boolean; removed?: number; backup?: string | null }>("sync_now");
      if (report.pulled > 0) await refreshAllRef.current();
      refreshSharedState();
      setLastSyncLabel(`Last synced ${new Date().toLocaleTimeString()}`);
      logRemoved(report);
    } catch {
      // Silent by design — not signed in, offline, or a viewer with nothing to
      // push. The manual Sync-now button is where errors surface loudly.
    } finally {
      // Stamped even on failure: a server that's down shouldn't turn every
      // window focus into a fresh retry storm.
      lastSyncAt.current = Date.now();
      autoSyncBusy.current = false;
      setCloudSyncing(false);
    }
    // All refs/setters are stable — quietSync keeps a fixed identity so the
    // interval effect isn't rebuilt on every sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The user's call on deletions held in a shared profile (HeldDeletions):
  // kept rows go out with the sync that follows, which brings them back for
  // everyone (a viewer's stay on this device).
  const resolveHeldDeletions = useCallback(async (deleteThem: boolean) => {
    try {
      const n = await invoke<number>("resolve_held_deletions", { deleteThem });
      const s = n === 1 ? "" : "s";
      addLog(deleteThem ? `Deleted ${n} item${s} here too.` : `Kept ${n} item${s}.`, "success");
    } catch (e) {
      addLog(`HELD_DELETIONS: ${e}`, "error");
    }
    await refreshAllRef.current();
    await refreshSharedState();
    if (!deleteThem) await handleCloudSync();
  }, [addLog, handleCloudSync, refreshSharedState]);

  // After-edit push, debounced so a burst of edits collapses into one sync a few
  // seconds after the user stops. Mutation handlers call this.
  const bumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bumpSync = useCallback(() => {
    if (!appSettings.autoSync) return;
    if (bumpTimer.current) clearTimeout(bumpTimer.current);
    bumpTimer.current = setTimeout(() => { quietSync(); }, 6000);
  }, [appSettings.autoSync, quietSync]);

  // A password typed into a connect prompt with "Save password" ticked was
  // saved once its login worked: the servers changed, and the change syncs.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let gone = false;
    listen("server-password-saved", () => {
      refreshServers();
      bumpSync();
    }).then((fn) => { if (gone) fn(); else unlisten = fn; });
    return () => { gone = true; if (unlisten) unlisten(); };
  }, [refreshServers, bumpSync]);

  // Turning auto-sync off has to cancel a push that's already armed. The check
  // above only runs when the timer is SCHEDULED, so editing something and then
  // switching auto-sync off within the six-second window still fired the sync —
  // which is precisely the moment someone reaching for that switch (metered
  // connection, about to go offline) most wants it not to.
  useEffect(() => {
    if (appSettings.autoSync) return;
    if (bumpTimer.current) {
      clearTimeout(bumpTimer.current);
      bumpTimer.current = null;
    }
  }, [appSettings.autoSync]);

  // Interval (pulls collaborators' changes on shared profiles) + on-focus fresh
  // pull. Both are no-ops until a profile is unlocked and auto-sync is enabled.
  useEffect(() => {
    if (!isUnlocked || !appSettings.autoSync) return;
    const INTERVAL_MS = Math.max(1, appSettings.syncIntervalMin || 5) * 60 * 1000;
    // Pull once shortly after unlock so the app opens on fresh data (a delay so
    // the unlock's own refresh + autostart settle first).
    const initial = setTimeout(() => { quietSync(); }, 4000);
    const id = setInterval(() => { quietSync(); }, INTERVAL_MS);
    let focusTimer: ReturnType<typeof setTimeout> | null = null;
    // Coming back to the window is a good moment to be fresh, but it used to be
    // an UNCONDITIONAL sync — and on a desktop app you alt-tab back constantly,
    // so this fired far more often than the interval ever did. The cadence the
    // user picked was effectively decoration: set it to 30 minutes and you'd
    // still sync every time you switched windows. Now focus only pulls when the
    // interval is already due, so the setting means what it says.
    const onFocus = () => {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - lastSyncAt.current < INTERVAL_MS) return;
      if (focusTimer) clearTimeout(focusTimer);
      focusTimer = setTimeout(() => { quietSync(); }, 1500);
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      clearTimeout(initial);
      clearInterval(id);
      if (focusTimer) clearTimeout(focusTimer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [isUnlocked, appSettings.autoSync, appSettings.syncIntervalMin, quietSync]);

  const removeServer = async (id: number) => {
    try {
      await invoke("delete_server", { id });
      if (activeProfile) forgetServerBookmarks(activeProfile, id);
      refreshServers();
      bumpSync();
      addLog("Server removed.", "info");
    } catch (e) { addLog(`DELETE_EXCEPTION: ${e}`, "error"); }
  };

  const removeFolder = async (id: number) => {
    // delete_folder takes its subfolders and every server in them along; note
    // which servers go, for the same per-server cleanup removeServer does.
    const tree = folderTree(folders);
    const inside = tree.subtreeOf(id);
    const gone: number[] = (servers || []).filter((s: any) => inside.has(tree.serverFolder(s) as number)).map((s: any) => s.id);
    try {
      await invoke("delete_folder", { id });
      if (activeProfile) gone.forEach((sid) => forgetServerBookmarks(activeProfile, sid));
      await Promise.all([refreshFolders(), refreshServers()]);
      bumpSync();
      addLog("Folder removed.", "info");
    } catch (e) { addLog(`DELETE_EXCEPTION: ${e}`, "error"); }
  };

  const createFolder = async (name: string, parentId: number | null = null) => {
    try {
      await invoke("add_folder", { name, parentId });
      await refreshFolders();
      bumpSync();
      addLog(`Folder "${name}" created.`, "success");
    } catch (e) {
      addLog(`FOLDER_ERROR: ${e}`, "error");
      throw e; // NodeGrid keeps the name input open for a retry
    }
  };

  // Drag and drop on the Servers page: a server into a folder, a folder into
  // another (null: the top level).
  const moveServerToFolder = async (id: number, folderId: number | null) => {
    try {
      await invoke("move_server_to_folder", { id, folderId });
      await refreshServers();
      bumpSync();
      const where = folderId === null ? "the top level" : `"${folders.find((f: any) => f.id === folderId)?.name ?? "folder"}"`;
      addLog(`Server moved to ${where}.`, "info");
    } catch (e) {
      addLog(`MOVE_ERROR: ${e}`, "error");
      throw e;
    }
  };
  const moveFolder = async (id: number, parentId: number | null) => {
    try {
      await invoke("move_folder", { id, parentId });
      await refreshFolders();
      bumpSync();
      const where = parentId === null ? "the top level" : `"${folders.find((f: any) => f.id === parentId)?.name ?? "folder"}"`;
      addLog(`Folder moved to ${where}.`, "info");
    } catch (e) {
      addLog(`MOVE_ERROR: ${e}`, "error");
      throw e;
    }
  };

  const renameFolder = async (id: number, name: string) => {
    try {
      await invoke("rename_folder", { id, name });
      await refreshFolders();
      bumpSync();
      addLog(`Folder renamed to "${name}".`, "info");
    } catch (e) {
      addLog(`RENAME_EXCEPTION: ${e}`, "error");
      throw e; // bubble up so NodeGrid can keep the input open if the user wants to retry
    }
  };

  // ProfileSelectPage handles the entire profile pick + password + create
  // flow on a single screen. By the time it fires `onUnlocked`, the
  // backend has both selected the profile AND decrypted the DB — we just
  // flip the UI and refresh data.
  const handleProfileUnlocked = async (name: string) => {
    setActiveProfile(name);
    setIsUnlocked(true);
    addLog(`Profile "${name}" unlocked.`, "success");
    refreshAll();
    // Attribute future edits to the signed-in cloud account so shared/multi-
    // device profiles show "last edited by <email>". Best-effort; unattributed
    // when not signed in.
    invoke<{ signed_in: boolean; email: string | null }>("cloud_status")
      .then((s) => invoke("set_editor_label", { label: s.signed_in && s.email ? s.email : "" }))
      .catch(() => {});
    // Autostart sweep: load servers directly (refreshAll is also doing this
    // in parallel, but its state update is async and we can't read `servers`
    // back here without a stale-closure race), pick the ones flagged
    // autostart, and stage them all into the sessions tab strip in one
    // setSessions call. The user lands focused on the first autostart node;
    // each new SessionView component then kicks off its own connect on mount.
    try {
      const list = await invoke<any[]>("get_servers");
      // Autostart someone else switched on in a shared profile waits for
      // this device's OK (Servers → Review) instead of connecting by itself.
      const isHeld = (s: any) => (s.held || []).includes("autostart");
      const waiting = list.filter((s) => s.autostart && isHeld(s));
      if (waiting.length > 0) {
        addLog(`Autostart: ${waiting.map((s) => s.name).join(", ")} waiting for your OK (Servers → Review).`, "info");
      }
      // Only SSH servers start by themselves (an RDP server would open an app).
      const toStart = list.filter((s) => s.autostart && !isHeld(s) && (s.protocol ?? "ssh") === "ssh");
      if (toStart.length === 0) return;
      const newSessions = toStart.map((s) => ({
        id: `session-${s.id}`,
        serverId: s.id,
        serverName: s.name,
        mirrors: s.mirrors,
        serverUuid: s.uuid ?? null,
      }));
      setSessions((prev: any[]) => {
        const seen = new Set(prev.map((p) => p.id));
        const fresh = newSessions.filter((n) => !seen.has(n.id));
        return [...prev, ...fresh];
      });
      setActiveView(newSessions[0].id);
      addLog(`Autostart: opened ${newSessions.length} node${newSessions.length === 1 ? "" : "s"}.`, "info");
    } catch (e) {
      addLog(`AUTOSTART_LOAD_FAILED: ${e}`, "error");
    }
  };

  const confirm = useConfirm();

  // Window-close guard. Keep `sessions` mirrored into a ref so the close
  // handler (which is registered ONCE inside useEffect, capturing snapshot
  // state) always sees the latest array — without this we'd race against
  // the user opening/closing tabs and either over- or under-confirm.
  const sessionsRef = useRef(sessions);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);

  // Intercept BOTH the in-app X button (which calls appWindow.close()) AND
  // OS-level closes (Alt+F4, taskbar context-menu close, system shutdown).
  // Both paths fire `onCloseRequested`. Showing a confirm when at least one
  // SSH session is connected prevents the most painful misclick: closing
  // the window mid-deploy / mid-edit and losing the terminal scrollback +
  // any in-flight SFTP transfers in one go. `appWindow.destroy()` bypasses
  // the close-requested hook so confirming actually exits — calling
  // `close()` again here would loop us straight back into the same prompt.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    appWindow.onCloseRequested(async (event) => {
      const n = sessionsRef.current.length;
      if (n === 0) return; // nothing to lose — let the close proceed
      event.preventDefault();
      const ok = await confirm({
        title: "Close Submarine?",
        message: `${n} session${n === 1 ? "" : "s"} ${n === 1 ? "is" : "are"} still connected. Closing now disconnects ${n === 1 ? "it" : "them all"} and aborts any in-flight transfers.`,
        okLabel: "Close anyway",
        cancelLabel: "Stay",
        destructive: true,
      });
      if (ok) {
        await appWindow.destroy();
      }
    }).then((fn) => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, [confirm]);

  // Lock the current profile and return to the unlock screen. Confirms first
  // when there are open sessions because they will be torn down: an
  // accidental click on the lock icon shouldn't kill the user's terminal work.
  const handleLogout = async () => {
    if (sessions.length > 0) {
      const ok = await confirm({
        title: "Lock Submarine?",
        message: `You have ${sessions.length} open session${sessions.length === 1 ? "" : "s"}. Locking disconnects ${sessions.length === 1 ? "it" : "them all"}.`,
        okLabel: "Lock",
        cancelLabel: "Stay",
        destructive: true,
      });
      if (!ok) return;
      // Best-effort: tell the backend to clean up each session. We don't
      // bail if one fails — `close_profile` will drop the DB anyway, and
      // the OS will eventually reap the sockets.
      for (const s of sessions) {
        try { await invoke("disconnect_session", { sessionId: s.id }); }
        catch (e) { console.error("disconnect on logout failed:", e); }
      }
    }
    try { await invoke("close_profile"); }
    catch (e) { addLog(`LOGOUT_EXCEPTION: ${e}`, "error"); }

    // Reset all client state so the picker starts fresh — no stale
    // servers/credentials/sessions leaking across profile contexts.
    setIsUnlocked(false);
    setLockedByUser(true);
    setActiveProfile(null);
    setSessions([]);
    setTabNames({});
    setActiveView("nodes");
    setServers([]); setCredentials([]); setSshKeys([]); setFolders([]); setCommands([]);
    addLog("Profile locked.", "info");
  };

  const openServer = (server: any) => {
    const sessionId = `session-${server.id}`;
    setLastConnected((prev) => recordConnected(prev, server.id));
    const existing = sessions.find(s => s.id === sessionId);
    if (!existing) {
      setSessions([...sessions, {
        id: sessionId,
        serverId: server.id,
        serverName: server.name,
        protocol: ["rdp", "telnet", "vnc"].includes(server.protocol) ? server.protocol : "ssh",
        // Pass the raw mirrors JSON through to SessionView so the
        // MirrorsPanel can pre-populate "Saved on this node" without
        // another round-trip to the backend.
        mirrors: server.mirrors,
        serverUuid: server.uuid ?? null,
        // Commands to auto-run once on the first terminal (see SessionView).
        runOnConnect: server.run_on_connect || "",
        // Set or changed by someone this profile is shared with, not allowed
        // here yet: SessionView asks before typing them.
        runOnConnectHeld: (server.held || []).includes("run_on_connect"),
      }]);
    }

    setActiveView(sessionId);
  };

  // Spawn a session from inline Quick Connect auth AND leave behind a reusable
  // node in the root directory so the target can be reconnected later without
  // re-typing credentials. The connection itself still rides `quickAuth`
  // (serverId = 0 sentinel = "look at quickAuth, not the DB") so it works
  // exactly as before even if the save fails; the persisted node is a
  // best-effort side effect the backend dedups by (host, port, username).
  const openQuickConnect = (auth: QuickAuth) => {
    const sessionId = `session-quick-${Date.now()}`;
    // No `user@` when the username is left blank (asked at connect, #54).
    const displayName = auth.username
      ? `${auth.username}@${auth.host}:${auth.port}`
      : `${auth.host}:${auth.port}`;
    setSessions((prev: Session[]) => [...prev, {
      id: sessionId,
      serverId: 0,
      serverName: displayName,
      quickAuth: auth,
    }]);
    setActiveView(sessionId);
    setIsQuickConnectOpen(false);
    addLog(`Quick connect → ${displayName}`, "info");
    // Persist a root-level profile for reuse. Best-effort: a failure here must
    // never block the live connection the user just asked for.
    invoke("save_quick_connect_node", { auth })
      .then(() => { refreshServers(); bumpSync(); addLog(`Saved node → ${displayName}`, "success"); })
      .catch((e) => addLog(`QUICK_NODE_SAVE_FAILED: ${e}`, "error"));
  };

  const handleEditNode = async (server: any) => {
    // Servers come back from get_servers with `has_password` (boolean) but
    // no plaintext. Reveal the secret only when the user opens the edit
    // sheet — that way the password never sits in renderer memory during
    // the normal grid/sidebar lifetime.
    let revealedPassword = "";
    if (server.has_password) {
      try {
        const v = await invoke<string | null>("reveal_server_password", { id: server.id });
        revealedPassword = v || "";
      } catch (e) {
        addLog(`REVEAL_PASSWORD_FAILED: ${e}`, "error");
      }
    }
    setNewNode({
      id: server.id,
      protocol: ["rdp", "telnet", "vnc"].includes(server.protocol) ? server.protocol : "ssh",
      rdpOptions: readRdpOptions(server.uuid),
      vncOptions: readVncOptions(server.uuid),
      name: server.name || "",
      host: server.host || "",
      port: server.port || 22,
      username: server.username || "",
      password: revealedPassword,
      authType: server.auth_type || (server.credential_id ? "vault" : "custom_pass"),
      credentialId: server.credential_id?.toString() || "",
      folderId: server.folder_id?.toString() || "",
      keyId: server.key_id?.toString() || "",
      proxyType: server.proxy_type || "none",
      proxyHost: server.proxy_host || "",
      proxyPort: server.proxy_port || 1080,
      tunnels: parseObjectList(server.tunnels),
      autostart: !!server.autostart,
      mirrors: parseObjectList(server.mirrors),
      color: server.color ?? null,
      notes: server.notes || "",
      runOnConnect: server.run_on_connect || "",
      jumpHostId: server.jump_host_id?.toString() || "",
      // Attribution (read-only display): who last edited + the HLC stamp.
      editedBy: server.edited_by ?? null,
      updatedAt: server.updated_at ?? null,
      // Starts clean — only flips true if the user types into the password
      // field. Save handler reads this to decide between `preserve_password`
      // and a real overwrite.
      password_dirty: false,
    });
    setIsPanelOpen(true);
  };

  // ⌘K (Ctrl+Shift+K off the Mac, where Ctrl+K is the shell's) opens the
  // palette, or closes it. Not over another dialog.
  const paletteKeyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  paletteKeyRef.current = (e: KeyboardEvent) => {
    if (!isUnlocked || e.code !== "KeyK" || e.repeat || !isSessionShortcut(e)) return;
    if (!paletteOpen && overlayOpen) return;
    e.preventDefault();
    e.stopPropagation();
    setPaletteOpen((o) => !o);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => paletteKeyRef.current(e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  useEffect(() => { if (!isUnlocked) setPaletteOpen(false); }, [isUnlocked]);

  // ⌘L (Ctrl+Shift+L off the Mac) locks. Not over another dialog.
  const lockKeyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  lockKeyRef.current = (e: KeyboardEvent) => {
    if (!isUnlocked || e.code !== "KeyL" || e.repeat || overlayOpen || !isSessionShortcut(e)) return;
    e.preventDefault();
    e.stopPropagation();
    void handleLogout();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => lockKeyRef.current(e);
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const askSession = (sid: string, req: Omit<SessionRequest, "n">) =>
    setSessionRequest((prev) => ({ ...req, sid, n: (prev?.n ?? 0) + 1 }));

  // Everything the palette offers, built each time it renders (it is only
  // mounted while open). Actions about "this server" follow the session in
  // front.
  const paletteItems = (): PaletteItem[] => {
    const tree = folderTree(folders);
    const folderPath = (id: number | null) => (id == null ? "" : tree.pathOf(id).map((f: any) => f.name).join(" › "));
    const current = activeView.startsWith("session-") ? sessions.find((s) => s.id === activeView) ?? null : null;
    const currentServer = current?.serverId ? servers.find((v: any) => v.id === current.serverId) ?? null : null;
    const currentName = current ? tabLabel(current) : "";
    const items: PaletteItem[] = [];

    for (const s of servers) {
      const protocol = ["rdp", "telnet", "vnc"].includes(s.protocol) ? s.protocol : "ssh";
      const address = `${s.username ? `${s.username}@` : ""}${s.host}${(s.port ?? 22) !== 22 || protocol !== "ssh" ? `:${s.port}` : ""}`;
      const open = sessions.some((x) => x.id === `session-${s.id}`);
      const beside = current && current.id !== `session-${s.id}` && !isMobile;
      items.push({
        id: `server-${s.id}`,
        group: "Servers",
        icon: protocol === "rdp" || protocol === "vnc" ? Monitor : protocol === "telnet" ? TerminalSquare : Server,
        title: s.name || s.host,
        sub: [folderPath(tree.serverFolder(s)), protocol !== "ssh" ? protocol.toUpperCase() : "", address].filter(Boolean).join(", "),
        keywords: `${s.host} ${s.username ?? ""}`,
        color: s.color,
        status: serverStatus[s.id] ?? null,
        verb: open ? "switch to it" : "connect",
        variants: { meta: "to edit", ...(beside ? { alt: `to open beside ${currentName}` } : {}) },
        // Open sessions first, the one in front last of those.
        rank: (open ? (current?.id === `session-${s.id}` ? 5e14 : 1e15) : 0) + (lastConnected[s.id] ?? 0),
        run: (v) => {
          if (v === "meta") { handleEditNode(s); return; }
          const anchor = activeView;
          openServer(s);
          if (v === "alt" && beside) {
            const sid = `session-${s.id}`;
            setMergedSessionIds((prev) => (prev.length === 0 ? [anchor, sid] : prev.includes(sid) ? prev : [...prev, sid]));
          }
        },
      });
    }

    const action = (a: Omit<PaletteItem, "group" | "verb"> & { verb?: string }) =>
      items.push({ group: "Actions", verb: "run it", ...a });

    if (current && (current.protocol ?? "ssh") === "ssh") {
      SESSION_VIEWS.forEach((v, i) => {
        if (v.id === "terminal") return;
        action({
          id: `view-${v.id}`,
          icon: v.Icon,
          title: `Open ${v.label} on ${currentName}`,
          shortcut: `${MOD_LABEL}${i + 1}`,
          rank: v.id === "files" ? 50 : v.id === "tunnels" ? 40 : 10 - i,
          run: () => askSession(current.id, { view: v.id }),
        });
      });
      if (!isMobile) {
        action({ id: "split", icon: Columns, title: "Split terminal", sub: "A new terminal of this server beside this one, or leave the split", shortcut: `${MOD_LABEL}D`, rank: 30, run: () => askSession(current.id, { split: true }) });
        action({ id: "inspector", icon: PanelRight, title: "Toggle inspector", sub: "Show or hide the docked tool", shortcut: `${MOD_LABEL}\\`, rank: 20, run: () => askSession(current.id, { inspector: true }) });
      }
    }
    if (currentServer) {
      action({ id: "edit-current", icon: Edit2, title: `Edit ${currentServer.name}…`, sub: "Connection, keys, proxy, startup", rank: 45, run: () => handleEditNode(currentServer) });
    }
    if (sessions.length >= 2) {
      action({
        id: "broadcast",
        icon: Radio,
        title: broadcastLive ? "Stop broadcasting" : "Start broadcasting",
        sub: broadcastLive ? "Keystrokes go to this session only" : "Type into every open session at once",
        keywords: "broadcast input",
        shortcut: `${MOD_LABEL === "⌘" ? "⌘⇧" : "Ctrl+Shift+"}B`,
        rank: broadcastLive ? 60 : 15,
        run: () => toggleBroadcastRef.current(),
      });
    }
    action({
      id: "new-server", icon: Plus, title: "New server…",
      sub: activeFolderId != null && tree.has(activeFolderId) ? `In ${folderPath(activeFolderId)}` : "Add a server",
      keywords: "add create host", rank: current ? 5 : 48,
      run: () => { setNewNode({ ...defaultNode, folderId: activeFolderId != null ? String(activeFolderId) : "" }); setIsPanelOpen(true); },
    });
    action({ id: "quick-connect", icon: Zap, title: "Quick connect…", sub: "Connect to a host without saving it first", keywords: "ssh host", rank: current ? 4 : 47, run: () => setIsQuickConnectOpen(true) });
    if (!IS_ANDROID) {
      action({ id: "import-ssh", icon: Download, title: "Import from ~/.ssh/config…", sub: "Pick hosts to add as servers", keywords: "import ssh config", run: () => setImportRequest((prev) => ({ source: "ssh", n: (prev?.n ?? 0) + 1 })) });
    }
    const go = (id: string, view: string, icon: PaletteItem["icon"], title: string, sub: string, keywords = "") =>
      action({ id, icon, title, sub, keywords, verb: "open it", rank: 3, run: () => { if (view === "nodes") setActiveFolderId(null); setActiveView(view); } });
    go("go-servers", "nodes", Server, "Servers", "Every server and folder");
    go("go-logins", "vault", KeyRound, "Logins", "Passwords and SSH keys", "vault keys credentials");
    go("go-library", "library", Library, "Library", "Saved commands and notes", "snippets");
    go("go-monitor", "monitor", Activity, "Monitor", "CPU, memory and network for your servers", "stats");
    if (sessions.length >= 1) go("go-wall", "wall", LayoutGrid, "Wall", "Terminals pinned side by side");
    go("go-settings", "settings", Settings, "Settings", "Appearance, terminal, sync", "preferences");
    go("go-logs", "logs", ScrollText, "Activity log", "What the app did, errors included", "logs");
    const appearance = appSettings.appearance;
    ([["light", Sun, "Use light appearance"], ["dark", Moon, "Use dark appearance"], ["system", Monitor, "Match the system appearance"]] as const)
      .filter(([v]) => v !== appearance)
      .forEach(([v, icon, title]) => action({ id: `appearance-${v}`, icon, title, keywords: "theme mode appearance", run: () => setAppSettings((s: any) => ({ ...s, appearance: v })) }));
    action({ id: "lock", icon: Lock, title: "Lock", sub: sessions.length ? "Disconnects every open session" : "Back to the unlock screen", shortcut: `${MOD_LABEL}L`, keywords: "logout lock switch profile", run: handleLogout });

    for (const f of folders) {
      const sub = tree.subtreeOf(f.id);
      const n = servers.filter((s: any) => { const id = tree.serverFolder(s); return id != null && sub.has(id); }).length;
      const parent = tree.pathOf(f.id).slice(0, -1).map((x: any) => x.name).join(" › ");
      items.push({
        id: `folder-${f.id}`,
        group: "Folders",
        icon: Folder,
        title: f.name,
        sub: [parent, `${n} ${n === 1 ? "server" : "servers"}`].filter(Boolean).join(", "),
        color: f.color,
        verb: "open it",
        run: () => { setActiveFolderId(f.id); setActiveView("nodes"); },
      });
    }

    // Saved commands run in the terminal in front: this server's first,
    // then those for every server.
    const term = current && (current.protocol ?? "ssh") === "ssh" ? sessionActiveTerm[current.id] : undefined;
    if (current && term) {
      const ids = currentServer ? serverScopeIds(currentServer, folders) : null;
      for (const c of commands) {
        const scope = parseCommandScope(c.scope);
        const mine = !!scope && !!ids && scopeMatches(scope, ids);
        if (scope && !mine) continue;
        const write = (execute: boolean) => {
          const text = execute ? (/[\r\n]$/.test(c.content) ? c.content : `${c.content}\r`) : c.content;
          invoke("write_terminal_data", { terminalId: term, data: Array.from(new TextEncoder().encode(text)) })
            .catch((e) => addLog(`COMMAND_WRITE_FAILED: ${e}`, "error"));
          askSession(current.id, { view: "terminal" });
        };
        items.push({
          id: `command-${c.id}`,
          group: "Commands",
          icon: ChevronRightSquare,
          title: c.title || c.content,
          sub: c.content.split("\n")[0],
          verb: `run in ${currentName}`,
          variants: { alt: "to type it without running" },
          rank: mine ? 1 : 0,
          run: (v) => write(v !== "alt"),
        });
      }
    }
    return items;
  };

  // Render helper, NOT a component — it is invoked as `{TitleBar()}` below,
  // never as `<TitleBar />`. Rendering it as a JSX element would give it a
  // fresh function identity on every DesktopApp render, so React would treat
  // it as a new component type and fully unmount + remount the whole title-bar
  // subtree (tab strip, pickers, window controls) on every render — throwing
  // away tab-strip scroll position and focus, and re-doing all that DOM work,
  // on every connect/reconnect and tab switch. Calling it inlines its JSX into
  // DesktopApp's own output with no component boundary, so React reconciles in
  // place. It closes over DesktopApp scope and uses no hooks, so a plain call
  // is safe. Do NOT convert this to `<TitleBar />`.
  const TitleBar = () => (
    <div
      data-tauri-drag-region
      onDoubleClick={(e) => {
        // Native double-click-to-maximize on the drag region matches OS
        // expectations on Windows/macOS/KDE. Tauri's drag region itself
        // doesn't dispatch this for us, so we wire it explicitly. Skip
        // when the click landed on an interactive child (tabs, buttons)
        // since those mark themselves with `no-drag`. Android's window
        // can't be maximized.
        const target = e.target as HTMLElement;
        if (IS_ANDROID || target.closest('.no-drag')) return;
        toggleMaximize();
      }}
      className={`bg-sidebar border-b border-white/[0.075] flex items-center justify-between pl-2 select-none shrink-0 z-50 drag ${isUnlocked && !isMobile ? 'relative h-11' : 'absolute top-0 left-0 right-0 h-10'}`}
    >
      {/* Logo + product name: hidden on phones to give the tab strip the
          whole row. Desktop keeps the original 75 px left padding for
          macOS traffic lights, plus the icon and brand. */}
      <div className={`${isUnlocked && !isMobile ? 'hidden' : 'hidden sm:flex'} items-center gap-2 pr-4 pl-2`} data-tauri-drag-region>
        <img src={logoUrl} alt="" draggable={false} className="h-6 w-auto max-w-[24px] object-contain select-none" />
        <span className="text-[12px] font-bold text-white tracking-tight">Submarine</span>
        {appVersion && (
          <span data-tauri-drag-region className="text-[11px] text-zinc-500/60 tracking-tight tabular-nums">v{appVersion}</span>
        )}
      </div>

      {/* Mobile session picker — replaces the horizontal tab strip on
          narrow viewports so a phone doesn't spend its whole title row
          on 3-character truncated tabs. A single pill shows the current
          session (or a "Servers" placeholder when nothing is open); tap
          opens a dropdown listing every session with status + close +
          merge affordances. Desktop still gets the full scrolling tab
          strip below. */}
      {isMobile && sessions.length > 0 && (
        <div className="flex-1 flex items-end justify-start pb-1 no-drag pl-2 pr-1 min-w-0">
          <div className="relative w-full">
            <button
              type="button"
              onClick={() => setMobileSessionPickerOpen(v => !v)}
              className={`w-full h-7 px-3 rounded-full flex items-center gap-2 border transition-all ${
                activeView.startsWith('session-') || activeView === 'wall'
                  ? 'bg-primary/15 text-primary border-primary/40 shadow-inner'
                  : 'bg-white/[0.06] text-zinc-300 border-white/10'
              }`}
              aria-haspopup="listbox"
              aria-expanded={mobileSessionPickerOpen}
            >
              {(() => {
                const isWall = activeView === 'wall';
                const cur = sessions.find(s => s.id === activeView);
                const st = cur ? (sessionStatuses[cur.id] ?? 'connecting') : null;
                const dotTone =
                  cur && promptSessions.has(cur.id) ? 'bg-primary animate-pulse' :
                  st === 'connected'    ? 'bg-emerald-400' :
                  st === 'connecting'   ? 'bg-amber-400 animate-pulse' :
                  st === 'failed'       ? 'bg-rose-500' :
                  st === 'disconnected' ? 'bg-rose-500' :
                                          'bg-zinc-500';
                return (
                  <>
                    {isWall
                      ? <LayoutGrid size={12} className="shrink-0 text-primary" />
                      : (cur && <span className={`w-2 h-2 rounded-full shrink-0 ${dotTone}`} />)}
                    <span className="truncate flex-1 text-left text-[11px] font-bold">
                      {isWall
                        ? `Wall${wallItems.length > 0 ? ` · ${wallItems.length} pinned` : ''}`
                        : cur ? tabLabel(cur) : `${sessions.length} open session${sessions.length === 1 ? '' : 's'}`}
                    </span>
                    {mergedSessionIds.length > 0 && (
                      <span className="shrink-0 h-4 px-1 rounded-full bg-primary/25 text-primary text-[9px] font-bold flex items-center gap-0.5">
                        <Columns size={8} /> +{mergedSessionIds.length}
                      </span>
                    )}
                    <ChevronDown size={12} className={`shrink-0 transition-transform ${mobileSessionPickerOpen ? 'rotate-180' : ''}`} />
                  </>
                );
              })()}
            </button>
            {mobileSessionPickerOpen && (
              <>
                <div className="fixed inset-0 z-[60]" onClick={() => setMobileSessionPickerOpen(false)} />
                <div
                  role="listbox"
                  className="absolute z-[70] top-8 left-0 right-0 bg-elevated border border-white/10 rounded-xl shadow-2xl p-1.5 max-h-[60vh] overflow-y-auto custom-scrollbar"
                >
                  {sessions.map(s => {
                    const st = sessionStatuses[s.id] ?? 'connecting';
                    const dot =
                      promptSessions.has(s.id) ? 'bg-primary animate-pulse' :
                      st === 'connected'    ? 'bg-emerald-400' :
                      st === 'connecting'   ? 'bg-amber-400 animate-pulse' :
                      st === 'idle'         ? 'bg-zinc-500' :
                      'bg-rose-500';
                    const isActive = activeView === s.id;
                    const isMerged = mergedSessionIds.includes(s.id);
                    return (
                      <div key={s.id} className="flex items-center gap-1">
                        <button
                          role="option"
                          aria-selected={isActive}
                          onClick={() => { setActiveView(s.id); setMobileSessionPickerOpen(false); }}
                          className={`flex-1 flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-all ${
                            isActive
                              ? 'bg-primary/15 text-primary'
                              : isMerged
                                ? 'bg-primary/[0.05] text-primary/80'
                                : 'text-zinc-200 hover:bg-white/[0.06]'
                          }`}
                        >
                          <span className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
                          <span className="text-[12px] font-semibold truncate flex-1">{tabLabel(s)}</span>
                          {isMerged && !isActive && (
                            <span className="text-[11px] font-medium text-primary/70">In split</span>
                          )}
                        </button>
                        {/* Merge/unmerge toggle — mobile equivalent of
                            the desktop tab context menu. Only offered
                            when the current view is another session AND
                            this row isn't the one on screen. */}
                        {activeView.startsWith('session-') && activeView !== s.id && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              if (isMerged) {
                                const next = mergedSessionIds.filter(id => id !== s.id);
                                // Below 2 members is a single view, not a split.
                                setMergedSessionIds(next.length < 2 ? [] : next);
                              } else {
                                // Fresh split: seed with the anchor so it
                                // holds visual position 0.
                                if (mergedSessionIds.length === 0) setMergedSessionIds([activeView, s.id]);
                                else setMergedSessionIds(prev => [...prev, s.id]);
                              }
                            }}
                            title={isMerged ? 'Remove from split view' : 'Split with current view'}
                            className={`h-8 w-8 shrink-0 rounded-lg flex items-center justify-center border transition-all ${
                              isMerged
                                ? 'bg-primary/15 text-primary border-primary/40'
                                : 'text-zinc-400 border-white/10 hover:bg-white/[0.06]'
                            }`}
                          >
                            <Columns size={13} />
                          </button>
                        )}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            const sid = s.id;
                            invoke('disconnect_session', { sessionId: sid }).catch(() => {});
                            setSessions(prev => prev.filter(x => x.id !== sid));
                            setSessionStatuses(prev => { const { [sid]: _, ...rest } = prev; return rest; });
                            clearTabName(sid);
                            broadcast.removeSession(sid);
                            setMergedSessionIds(prev => {
                              const next = prev.filter(id => id !== sid);
                              return next.length < 2 ? [] : next;
                            });
                            unpinSessionFromWall(sid);
                            setActiveView(prev => (prev === sid ? 'nodes' : prev));
                          }}
                          title="Close session"
                          className="h-8 w-8 shrink-0 rounded-lg flex items-center justify-center text-zinc-400 hover:text-red-400 hover:bg-white/[0.06] transition-all"
                        >
                          <X size={13} />
                        </button>
                      </div>
                    );
                  })}
                  {/* Wall entry — mobile equivalent of the desktop Wall
                      tab. Same pinboard, same state; just a different
                      entry point since the horizontal tab strip is
                      replaced by this dropdown on phone. */}
                  <div className="border-t border-white/5 my-1" />
                  <button
                    onClick={() => {
                      setMergedSessionIds([]);
                      setActiveView('wall');
                      setMobileSessionPickerOpen(false);
                    }}
                    className={`w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left transition-all ${
                      activeView === 'wall'
                        ? 'bg-primary/15 text-primary'
                        : 'text-zinc-200 hover:bg-white/[0.06]'
                    }`}
                  >
                    <LayoutGrid size={13} className="shrink-0" />
                    <span className="text-[12px] font-semibold flex-1">Wall</span>
                    {wallItems.length > 0 && (
                      <span className="text-[11px] font-medium text-primary/80">
                        {wallItems.length} pinned
                      </span>
                    )}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Tab strip is a drag region; tabs themselves opt out via no-drag so
          clicking a tab selects it instead of dragging the window. On phone
          the horizontal scroll is replaced by the dropdown above; the
          strip below is hidden on mobile. */}
      <div
        data-tauri-drag-region
        className={`${isMobile ? 'hidden' : 'flex'} flex-1 gap-1 overflow-x-auto no-scrollbar h-full items-center`}
        onWheel={(e) => { e.currentTarget.scrollLeft += e.deltaY; }}
      >
        {sessions.map(s => {
          const st = sessionStatuses[s.id] ?? "connecting";
          // Dot palette: green = connected, amber = connecting, red = failed
          // or disconnected. The pulse animation only runs while connecting
          // so a steady-state tab doesn't draw the eye every half second.
          // A prompt waiting on the user (host key, 2FA, login) outranks the
          // status: the dot pulses in the accent colour until it's answered.
          const waiting = promptSessions.has(s.id);
          const dotTone =
            waiting               ? "bg-primary animate-pulse" :
            st === "connected"    ? "bg-emerald-400" :
            st === "connecting"   ? "bg-amber-400 animate-pulse" :
            st === "failed"       ? "bg-rose-500" :
            st === "disconnected" ? "bg-rose-500" :
                                    "bg-zinc-500";
          const dotTitle =
            waiting               ? "Waiting for you — open this tab to answer" :
            st === "connected"    ? "Connected" :
            st === "connecting"   ? "Connecting…" :
            st === "failed"       ? "Connection failed" :
            st === "disconnected" ? "Disconnected" :
                                    st;
          // Broadcast indicator: small orange dot next to the status dot when
          // this session is in the target set AND broadcast is armed. Kept
          // separate from the status dot so the user can still tell "is it
          // connected?" and "is it broadcasting?" at a glance.
          const isBroadcastTarget = broadcast.enabled && broadcast.targetSessionIds.has(s.id);
          const isMergedTab = mergedSessionIds.includes(s.id);
          return (
            <div
              key={s.id}
              onClick={(e) => {
                // Ctrl/⌘-click toggles this tab in the split beside the
                // currently-active session view — a quick keyboard-free
                // way to tile two servers together without going through
                // the right-click menu.
                if ((e.ctrlKey || e.metaKey) && activeView.startsWith('session-') && activeView !== s.id) {
                  setMergedSessionIds(prev => {
                    // Fresh split: seed with the anchor first so it holds
                    // position 0 for the rest of the split's lifetime.
                    if (prev.length === 0) return [activeView, s.id];
                    if (prev.includes(s.id)) {
                      const next = prev.filter(id => id !== s.id);
                      return next.length < 2 ? [] : next;
                    }
                    return [...prev, s.id];
                  });
                  return;
                }
                // Plain click on a tab that isn't part of the current
                // split exits the split — the user is asking for a
                // single-tab view of s.id, not "tile s.id next to the
                // sessions I had merged".
                if (!mergedSessionIds.includes(s.id)) setMergedSessionIds([]);
                setActiveView(s.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                setTabMenu({ x: e.clientX, y: e.clientY, sessionId: s.id });
              }}
              // A double-click opens the tab's menu with its name editor.
              onDoubleClick={(e) => {
                setTabMenu({ x: e.clientX, y: e.clientY, sessionId: s.id });
                setTabRename(s.id);
              }}
              // No max-width / no truncate: the user explicitly wants full
              // node names visible even when many sessions are open. The tab
              // row itself is horizontally scrollable (overflow-x-auto +
              // wheel-to-horizontal scroll above), so wider tabs just mean
              // more scrolling — they never hide the name behind an ellipsis.
              // `whitespace-nowrap` keeps long names on a single line; without
              // it a tab with a 30-char hostname would wrap into a two-line
              // pill and break the row's height.
              title={isMergedTab ? `${tabLabel(s)} · split beside current view (Ctrl-click to unpair)` : tabLabel(s)}
              className={`group no-drag flex items-center h-[30px] pl-3 pr-1.5 rounded-[7px] cursor-pointer transition-colors duration-100 shrink-0 ${
                activeView === s.id
                  ? 'bg-surface text-white shadow-[0_0_0_0.5px_var(--border-strong),var(--shadow-control)]'
                  : isMergedTab
                    ? 'bg-primary/[0.08] text-white hover:bg-primary/[0.12]'
                    : 'text-zinc-400 hover:bg-white/5 hover:text-white'
              } ${isBroadcastTarget ? 'ring-1 ring-warning' : ''}`}
            >
              <span
                title={dotTitle}
                className={`w-1.5 h-1.5 rounded-full mr-2 shrink-0 ${dotTone}`}
                aria-label={dotTitle}
              />
              {isBroadcastTarget && (
                <span
                  title="Broadcast target"
                  aria-label="Broadcast target"
                  className="w-1.5 h-1.5 rounded-full mr-1.5 shrink-0 bg-warning"
                />
              )}
              {isMergedTab && (
                <Columns size={9} className="text-primary/70 mr-1 shrink-0" />
              )}
              {/* Node name display. Was 10 px + uppercase on desktop — that
                  combination gave the smallest, hardest-to-read name in the
                  whole title bar even though it's the ID users need most.
                  Bumping to 12 px and dropping the uppercase transform gives
                  the same tab pill roughly 30% more legible characters per
                  pixel (uppercase is wider per glyph) without changing the
                  strip height, which stays h-7. */}
              {/* A button so the keyboard reaches the tab: its click bubbles
                  to the tab's own handler (and a menu key opens its menu). */}
              <button
                type="button"
                aria-current={activeView === s.id ? "page" : undefined}
                className="text-[12.5px] font-medium whitespace-nowrap rounded outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
              >
                {tabLabel(s)}
              </button>
              {/* Mobile-only actions trigger. On phone we surface the same
                  tabMenu (Reconnect / Disconnect / Close) here since there
                  is no right-click on touch — a single kebab is a cleaner
                  affordance than a naked X plus a hidden long-press menu.
                  The X below is desktop-only so we don't stack both. */}
              <button
                type="button"
                aria-label="Session actions"
                className="sm:hidden ml-1 h-5 w-5 flex items-center justify-center rounded hover:bg-white/5 shrink-0 text-zinc-400"
                onClick={(e) => {
                  e.stopPropagation();
                  const rect = e.currentTarget.getBoundingClientRect();
                  setTabMenu({ x: rect.left, y: rect.bottom, sessionId: s.id });
                }}
              >
                <MoreVertical size={13} />
              </button>
              {/* Desktop-only inline close. Hidden until hover (or keyboard
                  focus) so the tab reads clean at rest; sizing (w-5 h-5,
                  12 px icon) matches the terminal-tab close inside
                  SessionView so both tab strips look like siblings. */}
              <button
                type="button"
                aria-label="Close session"
                className={`hidden sm:flex ml-1.5 h-[18px] w-[18px] items-center justify-center rounded hover:bg-white/[0.09] shrink-0 group-hover:opacity-100 focus-visible:opacity-100 text-zinc-500 hover:text-white transition-opacity ${activeView === s.id ? 'opacity-100' : 'opacity-0'}`}
                onClick={async (e) => {
                  e.stopPropagation();
                  // Only confirm when there's an actual live connection to
                  // drop — connecting/failed/disconnected close instantly.
                  // Status source of truth is the same sessionStatuses map
                  // that drives the coloured dot above.
                  if (sessionStatuses[s.id] === "connected") {
                    const ok = await confirm({
                      title: "Close this session?",
                      message: "The SSH connection will be dropped.",
                      okLabel: "Close",
                      destructive: true,
                    });
                    if (!ok) return;
                  }
                  setSessions(prev => prev.filter(sess => sess.id !== s.id));
                  setSessionStatuses(prev => {
                    const { [s.id]: _, ...rest } = prev;
                    return rest;
                  });
                  broadcast.removeSession(s.id);
                  unpinSessionFromWall(s.id);
                  setActiveView(prev => (prev === s.id ? "nodes" : prev));
                }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      {/* Wall trigger — moved OUT of the scrollable tab strip and next
          to the Broadcast pill so both multi-session affordances live
          in the same "utility cluster" at the right edge of the title
          bar. Icon-only on every viewport (mobile inherits from
          Broadcast's compact pattern), badge for pin count so state is
          legible without text. Visible whenever there's at least one
          open session — the Wall itself only becomes useful with pins
          but the button is the discoverability entry point. */}
      {sessions.length >= 1 && (
        <div className="relative no-drag shrink-0 mx-1">
          <button
            type="button"
            onClick={() => {
              // Plain click on Wall exits any active session-split —
              // split-view and Wall are two different multi-view modes
              // and switching between them shouldn't leave stale
              // merged state behind.
              setMergedSessionIds([]);
              setActiveView("wall");
            }}
            title={wallItems.length > 0
              ? `Wall · ${wallItems.length} pinned terminal${wallItems.length === 1 ? '' : 's'}`
              : "Wall — pinboard for terminals across servers"}
            aria-label="Wall pinboard"
            className={`relative flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
              activeView === "wall"
                ? "bg-primary/15 text-primary"
                : "text-zinc-400 hover:bg-white/[0.09] hover:text-white"
            }`}
          >
            <LayoutGrid size={15} />
            {wallItems.length > 0 && (
              <span
                className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full bg-primary text-[9px] font-bold text-black flex items-center justify-center leading-none"
                aria-hidden="true"
              >
                {wallItems.length}
              </span>
            )}
          </button>
        </div>
      )}
      {/* Broadcast trigger — session-scoped multi-exec. Lives OUTSIDE the
          scrollable tab strip so it stays anchored at the right edge no
          matter how many tabs are open. Compact icon-only button (no
          "Broadcast" text) to reclaim titlebar space; the dropdown reveals
          the full checkbox picker. When armed, a small orange count badge
          hangs off the corner so the state is legible at a glance without
          words. Hidden until there are 2+ sessions since a single session
          has no one to broadcast to. */}
      {sessions.length >= 2 && (
        <div className="relative no-drag shrink-0 mx-1">
          <button
            type="button"
            onClick={() => setBroadcastMenuOpen(v => !v)}
            title={broadcast.enabled
              ? `Broadcasting to ${broadcast.targetSessionIds.size} session${broadcast.targetSessionIds.size === 1 ? "" : "s"}`
              : "Broadcast input to multiple sessions"}
            aria-label="Broadcast input"
            className={`relative flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
              broadcast.enabled
                ? "bg-warning/15 text-warning"
                : "text-zinc-400 hover:bg-white/[0.09] hover:text-white"
            }`}
          >
            <Radio size={15} />
            {broadcast.enabled && broadcast.targetSessionIds.size > 0 && (
              <span
                className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full bg-orange-500 text-[9px] font-bold text-black flex items-center justify-center leading-none"
                aria-hidden="true"
              >
                {broadcast.targetSessionIds.size}
              </span>
            )}
          </button>
          {broadcastMenuOpen && (
            <>
              <div
                className="fixed inset-0 z-[60]"
                onClick={() => setBroadcastMenuOpen(false)}
              />
              <div className="absolute z-[70] top-full mt-1 right-0 w-[280px] bg-elevated border border-white/10 rounded-lg shadow-2xl p-2 text-[11px]">
                <div className="flex items-center justify-between mb-2 px-1">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input
                      type="checkbox"
                      className="accent-orange-400"
                      checked={broadcast.enabled}
                      onChange={broadcast.toggleEnabled}
                    />
                    <span className="text-[12px] font-semibold text-white">
                      Broadcast input
                    </span>
                  </label>
                  <button
                    onClick={() => setBroadcastMenuOpen(false)}
                    className="text-zinc-500 hover:text-white p-0.5"
                    aria-label="Close"
                  >
                    <X size={12} />
                  </button>
                </div>
                <div className="flex items-center gap-1.5 px-1 pb-2 border-b border-white/5">
                  <button
                    onClick={() => broadcast.selectAll(sessions.map(s => s.id))}
                    className="btn btn-sm"
                  >
                    All
                  </button>
                  <button
                    onClick={() => broadcast.selectNone()}
                    className="btn btn-sm"
                  >
                    None
                  </button>
                  <div className="flex-1" />
                  <span className={`text-[11.5px] font-medium ${
                    broadcast.enabled && broadcast.targetSessionIds.size >= 2
                      ? "text-orange-300"
                      : "text-zinc-500"
                  }`}>
                    {broadcast.enabled
                      ? (broadcast.targetSessionIds.size >= 2
                          ? `Live in ${broadcast.targetSessionIds.size}`
                          : "Pick two or more")
                      : "Off"}
                  </span>
                </div>
                <div className="max-h-[240px] overflow-y-auto custom-scrollbar mt-2 space-y-0.5">
                  {sessions.map(s => {
                    const checked = broadcast.targetSessionIds.has(s.id);
                    const st = sessionStatuses[s.id] ?? "connecting";
                    return (
                      <label
                        key={s.id}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer ${
                          checked ? "bg-orange-500/10" : "hover:bg-white/[0.04]"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="accent-orange-400 shrink-0"
                          checked={checked}
                          onChange={() => broadcast.toggleTarget(s.id)}
                        />
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                          st === "connected" ? "bg-emerald-400" :
                          st === "connecting" ? "bg-amber-400" :
                          "bg-rose-500"
                        }`} />
                        <span className="truncate text-[11px] font-medium text-zinc-200 flex-1">
                          {tabLabel(s)}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            </>
          )}
        </div>
      )}
      {/* Window controls: desktop only, at any window width (the window has
          no frame of its own, so a narrow one still needs them). Android has
          its own gesture nav / system back button, and the WebView window has
          no minimise or maximise affordance to surface — so the phone never
          shows the cluster, not even turned sideways, when it is as wide as a
          desktop window. */}
      {!IS_ANDROID && (
        <div className="flex items-center h-full gap-1 no-drag">
          <button
            onClick={() => appWindow.minimize()}
            title="Minimize"
            className="w-10 h-full flex items-center justify-center hover:bg-white/5 transition-colors"
          ><div className="w-3.5 h-[1.5px] bg-zinc-600" /></button>
          <button
            onClick={toggleMaximize}
            title={isMaximized ? "Restore" : "Maximize"}
            className="w-10 h-full flex items-center justify-center hover:bg-white/5 transition-colors group"
          >
            {isMaximized
              ? <Copy size={12} className="text-zinc-600 group-hover:text-zinc-300 scale-x-[-1]" />
              : <Square size={11} className="text-zinc-600 group-hover:text-zinc-300" />}
          </button>
          <button title="Close" onClick={() => appWindow.close()} className="w-10 h-full flex items-center justify-center hover:bg-red-500 group transition-all"><X size={14} className="text-zinc-500 group-hover:text-snow" /></button>
        </div>
      )}
      {tabMenu && (() => {
        const targetId = tabMenu.sessionId;
        // Build the "Split view with" picker: every OTHER open session is
        // a candidate. When the target tab is the active view, ticked
        // entries are the current mergedSessionIds. When the target is
        // a different tab, we haven't switched to it yet — ticking a row
        // both switches focus to the target AND initializes the merged
        // set with the picked partner(s), so users don't need a "click
        // to focus, right-click to split" two-step.
        const targetIsActive = activeView === targetId;
        const currentMerges = targetIsActive ? mergedSessionIds : [];
        const others = sessions.filter(s => s.id !== targetId);
        return (
        <>
          <div className="fixed inset-0 z-[60]" onClick={() => { setTabMenu(null); setTabRename(null); }} onContextMenu={(e) => { e.preventDefault(); setTabMenu(null); setTabRename(null); }} />
          <div
            className="fixed z-[70] bg-elevated border border-white/10 rounded-md shadow-2xl py-1 min-w-[240px] text-[11px] no-drag"
            style={{ left: Math.min(tabMenu.x, window.innerWidth - 260), top: Math.min(tabMenu.y, window.innerHeight - 380) }}
          >
            {/* The tab's name. The editor opens inside this menu: Enter
                keeps the name (an empty one goes back to the server's),
                Esc goes back to the menu. */}
            {tabRename === targetId ? (
              <RenameInput
                initialValue={tabNames[targetId] ?? sessions.find(s => s.id === targetId)?.serverName ?? ""}
                placeholder="Tab name (empty: the server's)"
                onCommit={(v) => {
                  const name = v.trim();
                  if (name) setTabNames(prev => ({ ...prev, [targetId]: name }));
                  else clearTabName(targetId);
                  setTabRename(null);
                  setTabMenu(null);
                }}
                onCancel={() => setTabRename(null)}
              />
            ) : (
              <button
                className="w-full text-left px-3 py-1.5 hover:bg-primary/15 hover:text-primary text-zinc-200 flex items-center gap-2"
                onClick={() => setTabRename(targetId)}
              >Rename tab</button>
            )}
            <button
              className="w-full text-left px-3 py-1.5 hover:bg-primary/15 hover:text-primary text-zinc-200 flex items-center gap-2"
              onClick={() => {
                window.dispatchEvent(new CustomEvent(`session-reconnect-${targetId}`));
                setTabMenu(null);
              }}
            >Reconnect</button>
            <button
              className="w-full text-left px-3 py-1.5 hover:bg-white/10 text-zinc-200"
              onClick={() => {
                invoke("disconnect_session", { sessionId: targetId }).catch(console.error);
                setTabMenu(null);
              }}
            >Disconnect</button>

            {/* Pin/Unpin the session's currently-active terminal to
                the Wall — one-click convenience so users don't have to
                open the picker + tick a specific terminal for the
                common "just pin what I'm looking at" case. The picker
                remains for choosing a specific non-active terminal or
                pinning multiple at once. */}
            {(() => {
              const activeTid = sessionActiveTerm[targetId];
              const activeTermPinned = activeTid ? wallHasTerminal(activeTid) : false;
              const anyPinned = wallItems.some(i => i.sessionId === targetId);
              return (
                <>
                  {activeTid && (
                    <button
                      className="w-full text-left px-3 py-1.5 hover:bg-primary/15 hover:text-primary text-zinc-200 flex items-center gap-2"
                      onClick={() => {
                        if (activeTermPinned) unpinTerminalFromWall(activeTid);
                        else pinTerminalToWall(targetId, activeTid);
                        setTabMenu(null);
                      }}
                    >
                      {activeTermPinned
                        ? (<><PinOff size={12} className="text-zinc-500" /> Unpin active terminal</>)
                        : (<><Pin size={12} className="text-zinc-500" /> Pin active terminal to Wall</>)}
                    </button>
                  )}
                  {anyPinned && (
                    <button
                      className="w-full text-left px-3 py-1.5 hover:bg-rose-500/10 hover:text-rose-300 text-zinc-400 flex items-center gap-2 text-[10.5px]"
                      onClick={() => { unpinSessionFromWall(targetId); setTabMenu(null); }}
                    >
                      <PinOff size={11} /> Unpin ALL from this session
                    </button>
                  )}
                </>
              );
            })()}

            {/* Split view picker — the user's requested UX. Right-click
                any tab, tick which OTHER tabs you want tiled beside it.
                The right-clicked tab becomes the focused pane; ticked
                rows become side panes. Ticking auto-applies so there's
                no "Apply" button to hunt. Hidden entirely when there's
                only one open session (nothing to pair with). */}
            {others.length > 0 && (
              <>
                <div className="border-t border-white/5 my-1" />
                <div className="px-3 pt-1 pb-1.5 flex items-center justify-between">
                  <span className="text-[11px] font-semibold text-zinc-500">
                    Split view with
                  </span>
                  {targetIsActive && currentMerges.length > 0 && (
                    <button
                      onClick={() => { setMergedSessionIds([]); setTabMenu(null); }}
                      className="text-[11px] font-medium text-zinc-500 hover:text-white"
                    >
                      Clear
                    </button>
                  )}
                </div>
                <div className="max-h-[200px] overflow-y-auto custom-scrollbar px-1 pb-1">
                  {others.map(s => {
                    const st = sessionStatuses[s.id] ?? "connecting";
                    const checked = currentMerges.includes(s.id);
                    return (
                      <label
                        key={s.id}
                        className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer ${
                          checked ? "bg-primary/10" : "hover:bg-white/[0.04]"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="accent-primary shrink-0"
                          checked={checked}
                          onChange={() => {
                            // Ticking: switch focus to the right-clicked
                            // tab (if not already) and add the picked
                            // partner. Unticking: drop the partner from
                            // the split — and collapse the split entirely
                            // when it would fall below the 2-pane minimum.
                            if (checked) {
                              const next = mergedSessionIds.filter(id => id !== s.id);
                              setMergedSessionIds(next.length < 2 ? [] : next);
                            } else {
                              if (!targetIsActive) {
                                setActiveView(targetId);
                                setMergedSessionIds([targetId, s.id]);
                              } else if (mergedSessionIds.length === 0) {
                                setMergedSessionIds([targetId, s.id]);
                              } else {
                                setMergedSessionIds(prev => prev.includes(s.id) ? prev : [...prev, s.id]);
                              }
                            }
                          }}
                        />
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                          st === "connected" ? "bg-emerald-400" :
                          st === "connecting" ? "bg-amber-400" :
                          "bg-rose-500"
                        }`} />
                        <span className="truncate text-[11px] font-medium text-zinc-200 flex-1">
                          {tabLabel(s)}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </>
            )}

            <div className="border-t border-white/5 my-1" />
            <button
              className="w-full text-left px-3 py-1.5 hover:bg-rose-500/15 hover:text-rose-300 text-zinc-200"
              onClick={() => {
                const sid = targetId;
                invoke("disconnect_session", { sessionId: sid }).catch(() => {});
                setSessions(prev => prev.filter(sess => sess.id !== sid));
                setSessionStatuses(prev => { const { [sid]: _, ...rest } = prev; return rest; });
                clearTabName(sid);
                broadcast.removeSession(sid);
                setMergedSessionIds(prev => {
                  const next = prev.filter(id => id !== sid);
                  return next.length < 2 ? [] : next;
                });
                unpinSessionFromWall(sid);
                setActiveView(prev => (prev === sid ? "nodes" : prev));
                setTabMenu(null);
              }}
            >Close tab</button>
          </div>
        </>
        );
      })()}
    </div>
  );

  // h-full (not h-screen) so the layout tracks --vv-h from main.tsx —
  // when the Android soft keyboard opens the visualViewport shrinks and the
  // whole flex chain cascades above the keyboard instead of anchoring to
  // the un-shrunken layout viewport.
  if (loading) return <div className="h-full bg-black flex items-center justify-center font-mono text-xs text-primary animate-pulse">Loading…</div>;

  return (
    <div className="h-full w-full bg-surface flex flex-col overflow-hidden text-zinc-200 select-none">
      {/* Unlocked on desktop, the title bar sits beside the sidebar instead. */}
      {(!isUnlocked || isMobile) && TitleBar()}
      {!isUnlocked ? (
        <ProfileSelectPage onUnlocked={handleProfileUnlocked} afterLock={lockedByUser} />
      ) : (
        // Layout swap: on desktop the sidebar is a left rail (row).
        // On mobile we flip to flex-col-reverse so the sidebar component
        // renders at the bottom while staying first in DOM order — keyboard
        // tab-order stays intuitive and <main> grabs the full screen width
        // (terminal gains the ~50px the vertical rail used to eat).
        <div inert={overlayOpen ? "" : undefined} className={`flex-1 flex ${isMobile ? 'flex-col-reverse pt-10' : ''} overflow-hidden`}>
          <Sidebar
            activeTab={isMobile && activeView.startsWith('session-') ? 'nodes' : activeView}
            setActiveTab={setActiveView}
            isMobile={isMobile}
            onLogout={handleLogout}
            profileName={activeProfile}
            syncing={cloudSyncing}
            logoUrl={logoUrl}
            servers={servers}
            folders={folders}
            activeFolderId={activeFolderId}
            onOpenFolder={(id: number | null) => { setActiveFolderId(id); setActiveView('nodes'); }}
            onAddServer={() => {
              setNewNode({ ...defaultNode, folderId: activeFolderId != null ? String(activeFolderId) : "" });
              setIsPanelOpen(true);
            }}
            onSearch={() => setPaletteOpen(true)}
            searchShortcut={`${MOD_LABEL}K`}
            lockShortcut={`${MOD_LABEL}L`}
            loginCount={credentials.length + sshKeys.length}
            libraryCount={commands.length + notes.length}
            monitorAlerts={monitorAlerts}
            wallCount={sessions.length >= 1 ? wallItems.length : undefined}
          />

          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          {!isMobile && TitleBar()}
          {broadcastLive && (
            <div role="status" className="shrink-0 min-h-9 px-3 py-1.5 flex items-center gap-2 flex-wrap bg-warning/10 border-b border-warning/30 text-[12.5px]">
              <Radio size={14} className="text-warning shrink-0" aria-hidden="true" />
              <span className="font-semibold text-warning">
                Broadcasting keystrokes to {broadcast.targetSessionIds.size} sessions
              </span>
              {sessions.filter((s) => broadcast.targetSessionIds.has(s.id)).map((s) => (
                <span key={s.id} className="chip">
                  <span
                    className="w-2 h-2 rounded-full shrink-0 bg-zinc-500"
                    style={servers.find((v: any) => v.id === s.serverId)?.color ? { background: servers.find((v: any) => v.id === s.serverId)?.color } : undefined}
                    aria-hidden="true"
                  />
                  {tabLabel(s)}
                </span>
              ))}
              <span className="hidden lg:inline ml-auto text-zinc-400">Everything you type goes to every listed session</span>
              <button type="button" className="btn btn-sm ml-auto lg:ml-2" onClick={broadcast.disable}>
                Stop <kbd className="text-[11px] text-zinc-500 font-medium">{/Mac/i.test(navigator.platform || navigator.userAgent) ? "⌘⇧B" : "Ctrl+Shift+B"}</kbd>
              </button>
            </div>
          )}
          <main className="flex-1 flex flex-col min-w-0 min-h-0 bg-transparent relative">
            {activeView === "nodes" && (
              <NodeGrid
                servers={servers}
                folders={folders}
                activeFolderId={activeFolderId}
                onActiveFolderChange={setActiveFolderId}
                onOpenServer={openServer}
                onEditServer={handleEditNode}
                onAddClick={(folderId?: number | null) => {
                  // When invoked from inside a folder header, seed the new
                  // node's folderId so the user doesn't have to re-pick the
                  // folder they just clicked into. Bare invocation (from the
                  // root grid's "Add server" card) stays at the empty default.
                  setNewNode({
                    ...defaultNode,
                    folderId: folderId != null ? String(folderId) : "",
                  });
                  setIsPanelOpen(true);
                }}
                onQuickConnect={() => setIsQuickConnectOpen(true)}
                onAllowHeld={allowHeld}
                keyChange={shareKeyChange}
                onAcceptKey={acceptShareKey}
                heldDeletions={heldDeletions}
                onResolveDeletions={resolveHeldDeletions}
                serverStatus={serverStatus}
                lastConnected={lastConnected}
                onImport={(req: ImportRequest) => setImportRequest((prev) => ({ ...req, n: (prev?.n ?? 0) + 1 }))}
                onRemoveServer={removeServer}
                onRemoveFolder={removeFolder}
                onRenameFolder={renameFolder}
                onCreateFolder={createFolder}
                onMoveServer={moveServerToFolder}
                onMoveFolder={moveFolder}
                onCloneServer={async (id: number) => {
                  try { await invoke("clone_server", { id }); refreshServers(); bumpSync(); addLog("Node cloned.", "success"); }
                  catch (e) { addLog(`CLONE_ERROR: ${e}`, "error"); }
                }}
                onReorderServers={async (ids: number[]) => {
                  // Rethrow on failure so NodeGrid drops its optimistic order
                  // override and reverts to the real (unchanged) arrangement.
                  try { await invoke("reorder_servers", { ids }); await refreshServers(); bumpSync(); }
                  catch (e) { addLog(`REORDER_ERROR: ${e}`, "error"); throw e; }
                }}
                isMobile={isMobile}
              />
            )}

            {activeView === "profile" && (
              <ProfilePanel
                onSync={handleCloudSync}
                syncing={cloudSyncing}
                lastSyncLabel={lastSyncLabel}
                autoSync={appSettings.autoSync}
                syncIntervalMin={appSettings.syncIntervalMin}
                onSetInterval={(m: number) => setAppSettings((s: any) => ({ ...s, syncIntervalMin: m }))}
                onToggleAutoSync={() => setAppSettings((s: any) => ({ ...s, autoSync: !s.autoSync }))}
              />
            )}

            {activeView === "settings" && (
              <SettingsPanel
                settings={appSettings}
                setSettings={setAppSettings}
                servers={servers}
                isMobile={isMobile}
                onOpenLogs={() => setActiveView("logs")}
              />
            )}

            {activeView === "vault" && (
              <LoginsVault
                credentials={credentials}
                sshKeys={sshKeys}
                servers={servers}
                onNewPassword={() => { setFormError(""); setEditCredData({ id: null, name: "", auth_type: "password", username: "", password: "", key_id: null }); setIsCredPanelOpen(true); }}
                onAddKey={() => { setFormError(""); setEditKeyData({ id: null, name: "", public_key: "", private_key: "", passphrase: "" }); setIsKeyPanelOpen(true); }}
                onEditCredential={async (c) => {
                  // The list carries only `has_password`: fetch the secret for the sheet.
                  let pw = "";
                  if (c.has_password) {
                    try { pw = (await invoke<string | null>("reveal_credential_password", { id: c.id })) || ""; }
                    catch (e) { addLog(`REVEAL_CRED_FAILED: ${e}`, "error"); }
                  }
                  setFormError("");
                  setEditCredData({ ...c, password: pw });
                  setIsCredPanelOpen(true);
                }}
                onEditKey={async (k) => {
                  let secrets: { private_key?: string | null; passphrase?: string | null } = {};
                  if (k.has_private_key || k.has_passphrase) {
                    try { secrets = await invoke<any>("reveal_ssh_key", { id: k.id }); }
                    catch (e) { addLog(`REVEAL_KEY_FAILED: ${e}`, "error"); }
                  }
                  setFormError("");
                  setEditKeyData({ ...k, private_key: secrets.private_key || "", passphrase: secrets.passphrase || "" });
                  setIsKeyPanelOpen(true);
                }}
                onOpenServer={openServer}
                onChanged={(what) => { (what === "keys" ? refreshSshKeys() : refreshCredentials()); bumpSync(); }}
                addLog={addLog}
              />
            )}

            {/* Sessions live in an absolute layer that overlays the rest of
                `main` — that way each session's xterm stays mounted at its
                real measured size across tab switches, but doesn't take any
                layout space when the user navigates to notes / settings /
                etc. The previous `display:none` toggle caused a 0×0 →
                real-size reflow on every switch and corrupted the prompt
                with stacked fragments like `[root@local[root@local`. */}
            {(() => {
              // When the current view is a session and mergedSessionIds has
              // entries, tile the focused session and its merged partners
              // side-by-side inside the same canvas — the user's "put two
              // main tabs together as panes" request. Hidden sessions stay
              // mounted (absolute-positioned, opacity 0) so scrollback and
              // PTY state survive; visible ones are explicitly positioned
              // via left/width so the tile widths match the visible count
              // without triggering a display-mode flip that could reset
              // xterm layout.
              const viewIsSession = activeView.startsWith("session-") && sessions.some(s => s.id === activeView);
              // mergedSessionIds semantics: when non-empty it lists ALL
              // tiled panes (including the currently focused one) in
              // visual order. Visual order is deliberately independent
              // of activeView so that clicking a tile to focus it does
              // NOT slide the tile to position 0 — the user reported
              // the left pane "jumping to the other server" on focus
              // change and that reorder was the cause.
              const isTiled = viewIsSession
                && mergedSessionIds.length >= 2
                && mergedSessionIds.includes(activeView);
              const visibleIds = isTiled
                ? mergedSessionIds.filter(id => sessions.some(s => s.id === id))
                : (viewIsSession ? [activeView] : []);
              // Sessions stay mounted behind the other views (and behind each
              // other) so their terminals keep running: inert while hidden,
              // or Tab could land in a terminal nobody can see and send what
              // is typed next to its server.
              return (
                <div inert={viewIsSession ? undefined : ""} className={`absolute inset-0 flex flex-col overflow-hidden ${!viewIsSession ? 'opacity-0 pointer-events-none' : ''}`}>
                  <div className="flex-1 relative bg-black/40">
                    {sessions.map(sess => {
                      const idx = visibleIds.indexOf(sess.id);
                      const isVisible = idx >= 0;
                      const isFocused = activeView === sess.id;
                      const style: React.CSSProperties = isVisible
                        ? {
                            position: 'absolute',
                            top: 0,
                            bottom: 0,
                            left: `${(idx * 100) / visibleIds.length}%`,
                            width: `${100 / visibleIds.length}%`,
                          }
                        : {
                            position: 'absolute',
                            inset: 0,
                            opacity: 0,
                            pointerEvents: 'none',
                          };
                      return (
                        <div
                          key={sess.id}
                          style={style}
                          inert={isVisible ? undefined : ""}
                          onMouseDownCapture={() => {
                            // Focus shift ONLY — tile positions live in
                            // mergedSessionIds and must stay stable across
                            // focus changes. Reordering here was the cause
                            // of the reported "left tile jumps to the other
                            // server when I click the right one" bug.
                            if (isTiled && !isFocused && isVisible) {
                              setActiveView(sess.id);
                            }
                          }}
                          // flex flex-col so SessionView's root `flex-1`
                          // actually fills the tile. Without this the tile
                          // has explicit position:absolute + top/bottom
                          // dimensions but SessionView's internal flex
                          // layout collapses to 0 height and the terminal
                          // + tool panels never draw.
                          className={`flex flex-col overflow-hidden ${
                            isVisible && isTiled
                              ? `border ${isFocused ? 'border-primary/40 shadow-[inset_0_0_0_1px_rgba(var(--primary),0.15)]' : 'border-white/[0.05]'}`
                              : ''
                          }`}
                        >
                          {/* Merged (non-focused) tile header. Only the
                              focused pane keeps its full tab strip + tool
                              rail (via SessionView's default chrome);
                              merged panes get a slim 28-px header with
                              server name + a click-to-focus hint + a
                              detach X. Everything below that header is a
                              chromeless SessionView so it renders ONLY
                              the currently-active terminal without
                              stacking a second toolbar next to the
                              focused one. Vertical space wasted per
                              merged tile drops from ~48 px (full chrome)
                              to ~28 px (slim header). */}
                          {isVisible && isTiled && !isFocused && (
                            <div className="h-7 shrink-0 flex items-center gap-2 px-2 border-b border-white/5 bg-panel text-[12px]">
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                (sessionStatuses[sess.id] ?? 'connecting') === 'connected' ? 'bg-emerald-400' :
                                (sessionStatuses[sess.id] ?? 'connecting') === 'connecting' ? 'bg-amber-400' :
                                (sessionStatuses[sess.id] ?? 'connecting') === 'idle' ? 'bg-zinc-500' :
                                'bg-rose-500'
                              }`} />
                              <span className="font-semibold text-white truncate flex-1">
                                {tabLabel(sess)}
                              </span>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  const next = mergedSessionIds.filter(id => id !== sess.id);
                                  // Under 2 members isn't a split any more —
                                  // clear the list so the remaining pane
                                  // reverts to plain full-width single view.
                                  setMergedSessionIds(next.length < 2 ? [] : next);
                                }}
                                title="Remove this pane from the split view"
                                className="h-5 w-5 rounded flex items-center justify-center text-zinc-500 hover:text-red-400 hover:bg-white/[0.05] transition-all"
                              >
                                <X size={11} />
                              </button>
                            </div>
                          )}
                          <ErrorBoundary
                            label={tabLabel(sess)}
                            onReset={() => {
                              setSessions(prev => prev.filter(s => s.id !== sess.id));
                              clearTabName(sess.id);
                              if (activeView === sess.id) setActiveView("nodes");
                            }}
                          >
                            {sess.protocol === "rdp" ? (
                              <RdpSessionView
                                session={sess}
                                displayName={tabLabel(sess)}
                                onClose={getCloseHandler(sess.id)}
                                onStatusChange={handleSessionStatus}
                                isActiveView={isFocused}
                                shown={isVisible && viewIsSession}
                                onPromptChange={handlePromptChange}
                              />
                            ) : sess.protocol === "vnc" ? (
                              <VncSessionView
                                session={sess}
                                displayName={tabLabel(sess)}
                                onClose={getCloseHandler(sess.id)}
                                onStatusChange={handleSessionStatus}
                                isActiveView={isFocused}
                                shown={isVisible && viewIsSession}
                                onPromptChange={handlePromptChange}
                              />
                            ) : sess.protocol === "telnet" ? (
                              <TelnetSessionView
                                session={sess}
                                displayName={tabLabel(sess)}
                                onClose={getCloseHandler(sess.id)}
                                onStatusChange={handleSessionStatus}
                                isActiveView={isFocused}
                                onPromptChange={handlePromptChange}
                              />
                            ) : (
                            <SessionView
                              session={sess}
                              profile={activeProfile}
                              displayName={tabLabel(sess)}
                              onClose={getCloseHandler(sess.id)}
                              addLog={addLog}
                              onStatusChange={handleSessionStatus}
                              onTerminalsChange={handleTerminalsChange}
                              chromeless={isVisible && isTiled && !isFocused}
                              isActiveView={isFocused}
                              onPromptChange={handlePromptChange}
                              request={sessionRequest?.sid === sess.id ? sessionRequest : undefined}
                            />
                            )}
                          </ErrorBoundary>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })()}

            {/* Wall canvas — a grid of individual terminal tiles pinned
                from any session. Independent of the session-split
                canvas above; the two live side-by-side in `main` with
                only one visible at a time. Wall tiles mount their own
                TerminalView in attach-only mode so xterm scrollback +
                PTY ownership stay with the primary xterm in the
                session tab. */}
            {activeView === "wall" && (
              <div className="absolute inset-0 flex flex-col overflow-hidden bg-surface">
                {/* Toolbar: cols and rows selectors + Add + Clear. Rows
                    default to as many as the tiles need; a number fits
                    that many on screen. On a narrow screen the selectors
                    scroll sideways. */}
                <div className="h-10 shrink-0 border-b border-white/5 bg-panel flex items-center gap-2 px-3">
                  <LayoutGrid size={12} className="text-primary/70 shrink-0" />
                  <span className="text-[13px] font-semibold text-white shrink-0">
                    Wall {wallItems.length > 0 && <span className="font-normal text-zinc-500">{wallItems.length}</span>}
                  </span>
                  <div className="flex-1 min-w-0 flex items-center gap-3 ml-2 overflow-x-auto no-scrollbar">
                    <div className="flex items-center gap-1 shrink-0" role="group" aria-label="Columns">
                      <span className="text-[12px] text-zinc-500">Columns</span>
                      <div className="seg">
                      {[1, 2, 3, 4, 5, 6].map(n => (
                        <button
                          key={n}
                          onClick={() => setWallCols(n)}
                          title={`${n} column${n === 1 ? '' : 's'} per row`}
                          aria-pressed={wallCols === n}
                          className="seg-item"
                        >
                          {n}
                        </button>
                      ))}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0" role="group" aria-label="Rows">
                      <span className="text-[12px] text-zinc-500">Rows</span>
                      <div className="seg">
                      {[0, 1, 2, 3, 4].map(n => (
                        <button
                          key={n}
                          onClick={() => setWallRows(n)}
                          title={n === 0 ? 'As many rows as the tiles need' : `${n} row${n === 1 ? '' : 's'} on screen; more tiles scroll`}
                          aria-pressed={wallRows === n}
                          className="seg-item"
                        >
                          {n === 0 ? 'Auto' : n}
                        </button>
                      ))}
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => setWallPickerOpen(v => !v)}
                    title="Pick terminals to pin"
                    className="btn btn-primary"
                  >
                    <Plus size={13} aria-hidden /> Add
                  </button>
                  {wallItems.length > 0 && (
                    <button
                      onClick={() => setWallItems([])}
                      title="Unpin everything (terminals stay open in their sessions)"
                      className="btn"
                    >
                      Clear

                    </button>
                  )}
                </div>

                {/* Grid canvas. Empty state overlaid when nothing is
                    pinned so we don't just show a black rectangle to a
                    first-time visitor. */}
                <div ref={wallAreaRef} className="flex-1 relative bg-black/40 overflow-auto custom-scrollbar">
                  {wallItems.length === 0 ? (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 text-center px-6 pointer-events-none">
                      <LayoutGrid size={40} className="text-zinc-600" />
                      <div className="text-zinc-400 text-[13px] max-w-md leading-relaxed">
                        The Wall is a pinboard for watching multiple <em>terminals</em> at once.<br/>
                        Right-click a session tab or use the <span className="text-primary font-semibold">Add</span> button above to pin any terminal from any server.
                      </div>
                    </div>
                  ) : (
                    <div
                      className="min-h-full grid gap-1.5 p-1.5"
                      style={{
                        gridTemplateColumns: `repeat(${wallCols}, minmax(0, 1fr))`,
                        gridAutoRows: wallRowHeight,
                      }}
                    >
                      {wallItems.map(item => {
                        const sess = sessions.find(s => s.id === item.sessionId);
                        if (!sess) return null;
                        const terms = sessionTerminals[item.sessionId] ?? [];
                        const term = terms.find(t => t.id === item.terminalId);
                        const st = sessionStatuses[item.sessionId] ?? 'connecting';
                        const dotTone =
                          st === 'connected'    ? 'bg-emerald-400' :
                          st === 'connecting'   ? 'bg-amber-400 animate-pulse' :
                                                  'bg-rose-500';
                        return (
                          <div
                            key={item.id}
                            className="flex flex-col overflow-hidden border border-white/10 rounded-md bg-surface shadow-[0_2px_10px_rgba(0,0,0,0.4)] hover:border-primary/30 transition-colors"
                          >
                            {/* Slim tile header — server + terminal
                                title, quick-jump into the session,
                                unpin. Terminal body below owns focus
                                so keystrokes go to xterm directly. */}
                            <div className="h-7 shrink-0 flex items-center gap-2 px-2 border-b border-white/5 bg-panel text-[12px] select-none">
                              <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotTone}`} />
                              <span className="font-semibold text-white truncate">
                                {tabLabel(sess)}
                              </span>
                              <span className="text-zinc-600">·</span>
                              <span className="text-zinc-400 truncate flex-1">
                                {term?.title ?? item.terminalId}
                              </span>
                              <button
                                onClick={() => setActiveView(sess.id)}
                                title="Open this session in its own tab"
                                className="h-5 w-5 rounded flex items-center justify-center text-zinc-500 hover:text-primary hover:bg-white/[0.05] transition-all"
                              >
                                <TerminalSquare size={11} />
                              </button>
                              <button
                                onClick={() => unpinTerminalFromWall(item.terminalId)}
                                title="Unpin from Wall"
                                className="h-5 w-5 rounded flex items-center justify-center text-zinc-500 hover:text-red-400 hover:bg-white/[0.05] transition-all"
                              >
                                <PinOff size={11} />
                              </button>
                            </div>
                            {/* Attach-only TerminalView: hitches onto
                                the same PTY as the session's primary
                                xterm without owning the lifecycle, so
                                closing the Wall or unpinning doesn't
                                drop the session. */}
                            {sessionStatuses[item.sessionId] === 'connected' ? (
                              <div className="flex-1 min-h-0 relative">
                                <TerminalView
                                  sessionId={item.sessionId}
                                  terminalId={item.terminalId}
                                  attachOnly
                                  disabled={false}
                                  isActive={true}
                                  serverId={sess.serverId}
                                  serverName={sess.serverName}
                                />
                              </div>
                            ) : (
                              <div className="flex-1 flex items-center justify-center text-zinc-500 text-[12px]">
                                {st === 'connecting' ? 'Connecting…' : st === 'idle' ? 'Not connected' : st === 'failed' ? "Couldn't connect" : 'Disconnected'}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Wall picker popover — 2-level session → terminal
                    tree so users can precisely pick which shells to
                    pin. Ticking a terminal pins; unticking unpins.
                    Session rows aren't selectable themselves; they
                    only group their terminals visually. */}
                {wallPickerOpen && (
                  <>
                    <div className="fixed inset-0 z-[65]" onClick={() => setWallPickerOpen(false)} />
                    <div className="absolute top-12 right-3 z-[66] w-80 max-h-[70vh] bg-elevated border border-white/10 rounded-xl shadow-2xl p-2 flex flex-col">
                      <div className="px-2 pb-2 flex items-center justify-between shrink-0">
                        <span className="text-[13px] font-semibold text-white">
                          Pin terminals
                        </span>
                        <button aria-label="Close"
                          onClick={() => setWallPickerOpen(false)}
                          className="h-5 w-5 rounded flex items-center justify-center text-zinc-500 hover:text-white hover:bg-white/[0.05]"
                        >
                          <X size={11} />
                        </button>
                      </div>
                      {sessions.length === 0 ? (
                        <div className="px-2 py-6 text-center text-zinc-500 text-[11px]">
                          No open sessions yet.
                        </div>
                      ) : (
                        <div className="overflow-y-auto custom-scrollbar space-y-1 pr-1">
                          {sessions.map(s => {
                            const terms = sessionTerminals[s.id] ?? [];
                            const st = sessionStatuses[s.id] ?? 'connecting';
                            return (
                              <div key={s.id} className="rounded bg-white/[0.02] border border-white/5">
                                <div className="flex items-center gap-2 px-2 py-1.5 border-b border-white/5">
                                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                    st === 'connected' ? 'bg-emerald-400' :
                                    st === 'connecting' ? 'bg-amber-400' :
                                    'bg-rose-500'
                                  }`} />
                                  <span className="text-[11px] font-bold text-zinc-200 truncate flex-1">
                                    {tabLabel(s)}
                                  </span>
                                  <span className="text-[11.5px] text-zinc-500">
                                    {terms.length} terminal{terms.length === 1 ? '' : 's'}
                                  </span>
                                </div>
                                {terms.length === 0 ? (
                                  <div className="px-3 py-2 text-[10px] text-zinc-500 italic">
                                    Session not yet ready.
                                  </div>
                                ) : (
                                  <div className="p-1 space-y-0.5">
                                    {terms.map(t => {
                                      const checked = wallHasTerminal(t.id);
                                      return (
                                        <label
                                          key={t.id}
                                          className={`flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer ${
                                            checked ? 'bg-primary/10' : 'hover:bg-white/[0.04]'
                                          }`}
                                        >
                                          <input
                                            type="checkbox"
                                            className="accent-primary shrink-0"
                                            checked={checked}
                                            onChange={() => {
                                              if (checked) unpinTerminalFromWall(t.id);
                                              else pinTerminalToWall(s.id, t.id);
                                            }}
                                          />
                                          <TerminalSquare size={11} className="text-zinc-500 shrink-0" />
                                          <span className="text-[11px] text-zinc-200 truncate flex-1">
                                            {t.title}
                                          </span>
                                        </label>
                                      );
                                    })}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Library = Commands + Notes merged.
                Commands and Notes used to be two distinct rails; both are
                per-profile lists of small text blobs stored inside the
                encrypted vault, and the only real difference is
                "runnable snippet vs freeform text". A single tab with an
                internal segmented control gives us the sidebar slot back
                on narrow viewports and puts both lists under one search
                box. The sub-tab state (`libraryTab`) is kept at the parent
                so it survives navigation elsewhere and back. */}
            {activeView === "library" && (() => {
              const q = libraryQuery.trim().toLowerCase();
              const filteredCommands = q
                ? commands.filter(c =>
                    (c.title || "").toLowerCase().includes(q) ||
                    (c.content || "").toLowerCase().includes(q))
                : commands;
              const filteredNotes = q
                ? notes.filter(n =>
                    (n.title || "").toLowerCase().includes(q) ||
                    (n.body || "").toLowerCase().includes(q))
                : notes;
              const onCommandsTab = libraryTab === "commands";
              const addLabel = onCommandsTab ? "New command" : "New note";
              const openAdd = () => {
                if (onCommandsTab) {
                  setEditCommandData({ id: null, title: "", content: "", scope: null });
                  setIsCommandPanelOpen(true);
                } else {
                  setEditNoteData({ id: null, title: "", body: "" });
                  setIsNotePanelOpen(true);
                }
              };
              return (
                <div className="flex-1 flex flex-col overflow-hidden bg-surface">
                  <header className="h-[52px] shrink-0 flex items-center gap-2 pl-4 pr-3 border-b border-white/[0.075]">
                    <span className="flex-1 min-w-0 h-6 flex items-center font-semibold text-white truncate">Library</span>
                    <label className="relative hidden sm:block">
                      <Search size={14} aria-hidden className="absolute left-[9px] top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
                      <input
                        type="search"
                        value={libraryQuery}
                        onChange={(e) => setLibraryQuery(e.target.value)}
                        placeholder="Filter"
                        aria-label="Filter commands and notes"
                        className="field w-56 pl-7"
                      />
                    </label>
                    <button type="button" onClick={openAdd} aria-label={addLabel} className="btn btn-primary">
                      <Plus size={14} aria-hidden /><span className="hidden md:inline">{addLabel}</span>
                    </button>
                  </header>

                  <div className="flex-1 overflow-y-auto custom-scrollbar px-4 pt-5 pb-8 sm:px-8 sm:pt-7 sm:pb-10">
                    <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
                      <div className="min-w-0">
                        <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.01em] text-white">Library</h1>
                        <p className="mt-0.5 text-zinc-400 flex items-center gap-1.5">
                          <Shield size={13} aria-hidden className="text-zinc-500 shrink-0" />
                          Snippets and notes, encrypted with your master password.
                        </p>
                      </div>
                      <div role="group" aria-label="Show" className="seg">
                        <button type="button" onClick={() => setLibraryTab("commands")} aria-pressed={onCommandsTab} className="seg-item px-2.5">
                          <TerminalSquare size={13} aria-hidden /> Commands
                          <span className="text-zinc-500 tabular-nums">{filteredCommands.length}</span>
                        </button>
                        <button type="button" onClick={() => setLibraryTab("notes")} aria-pressed={!onCommandsTab} className="seg-item px-2.5">
                          <StickyNote size={13} aria-hidden /> Notes
                          <span className="text-zinc-500 tabular-nums">{filteredNotes.length}</span>
                        </button>
                      </div>
                    </div>
                    <label className="relative block mb-4 sm:hidden">
                      <Search size={14} aria-hidden className="absolute left-[9px] top-1/2 -translate-y-1/2 text-zinc-500 pointer-events-none" />
                      <input
                        type="search"
                        value={libraryQuery}
                        onChange={(e) => setLibraryQuery(e.target.value)}
                        placeholder="Filter"
                        aria-label="Filter commands and notes"
                        className="field pl-7"
                      />
                    </label>

                    {(onCommandsTab ? filteredCommands.length : filteredNotes.length) === 0 ? (
                      <div className="min-h-[40vh] flex flex-col items-center justify-center text-center px-4">
                        <span aria-hidden className="w-12 h-12 rounded-xl flex items-center justify-center bg-primary/[0.12] text-primary">
                          {onCommandsTab ? <TerminalSquare size={22} /> : <StickyNote size={22} />}
                        </span>
                        <h2 className="mt-4 text-[17px] font-semibold text-white">
                          {q ? `Nothing matches “${libraryQuery.trim()}”` : onCommandsTab ? "No saved commands yet" : "No notes yet"}
                        </h2>
                        <p className="mt-1 max-w-[380px] text-zinc-400">
                          {q ? "Try another word, or clear the filter."
                            : onCommandsTab ? "Save a command once, then run it from a session's Commands tool or with ⌘K."
                            : "Keep runbooks, addresses and anything else you look up while you work."}
                        </p>
                        {!q && (
                          <button type="button" onClick={openAdd} className="btn btn-primary mt-5">
                            <Plus size={14} aria-hidden /> {addLabel}
                          </button>
                        )}
                      </div>
                    ) : onCommandsTab ? (
                      <ul className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
                        {filteredCommands.map(cmd => {
                          const scope = parseCommandScope(cmd.scope);
                          const edit = () => { setEditCommandData({ id: cmd.id, title: cmd.title, content: cmd.content, scope }); setIsCommandPanelOpen(true); };
                          return (
                            <li key={cmd.id} className="tile tile-hover group flex flex-col p-3.5 min-h-[132px]">
                              <div className="flex items-start gap-2 mb-2">
                                <h3 className="flex-1 min-w-0 font-semibold text-white truncate">
                                  <button type="button" onClick={edit} className="max-w-full truncate text-left after:absolute after:inset-0 after:rounded-[10px]">{cmd.title}</button>
                                </h3>
                                <button type="button" aria-label={`Delete ${cmd.title}`} onClick={async () => {
                                  const ok = await confirm({ title: "Delete command?", message: `“${cmd.title}” will be removed.`, destructive: true });
                                  if (!ok) return;
                                  invoke("delete_command", { id: cmd.id }).then(() => { refreshCommands(); bumpSync(); });
                                }} className="icon-btn z-[1] -mr-1.5 -mt-1 w-6 h-6 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 hover:text-danger"><Trash2 size={13} aria-hidden /></button>
                              </div>
                              <pre className="flex-1 rounded-md bg-terminal px-2.5 py-2 text-[12px] leading-[17px] text-zinc-300 font-mono whitespace-pre-wrap break-all line-clamp-3">{cmd.content}</pre>
                              {scope && (
                                <div className="mt-2 flex items-center gap-1.5 text-[12px] text-zinc-400 min-w-0" data-command-scope>
                                  <Server size={12} aria-hidden className="shrink-0 text-zinc-500" />
                                  <span className="truncate">For {describeScope(scope, servers, folders)}</span>
                                </div>
                              )}
                            </li>
                          );
                        })}
                      </ul>
                    ) : (
                      <ul className="grid gap-3 grid-cols-1 md:grid-cols-2 xl:grid-cols-3">
                        {filteredNotes.map(n => {
                          const title = n.title || "Untitled";
                          return (
                            <li key={n.id} className="tile tile-hover group flex flex-col p-3.5 min-h-[148px]">
                              <div className="flex items-start gap-2 mb-1.5">
                                <h3 className="flex-1 min-w-0 font-semibold text-white truncate">
                                  <button type="button" onClick={() => { setEditNoteData({ id: n.id, title: n.title || "", body: n.body || "" }); setIsNotePanelOpen(true); }}
                                    className="max-w-full truncate text-left after:absolute after:inset-0 after:rounded-[10px]">{title}</button>
                                </h3>
                                <button type="button" aria-label={`Delete ${title}`} onClick={async () => {
                                  const ok = await confirm({ title: "Delete note?", message: `“${title}” will be removed.`, destructive: true });
                                  if (!ok) return;
                                  invoke("delete_note", { id: n.id }).then(() => { refreshNotes(); bumpSync(); });
                                }} className="icon-btn z-[1] -mr-1.5 -mt-1 w-6 h-6 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 focus-visible:opacity-100 hover:text-danger"><Trash2 size={13} aria-hidden /></button>
                              </div>
                              <p className="text-zinc-400 leading-[18px] whitespace-pre-wrap break-words line-clamp-5">{n.body}</p>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* Monitor is mounted permanently and just CSS-hidden when not
                active. Unmounting would tear down the sample/history ring
                buffers, the per-node event listeners, and the 1s tick — so
                switching tabs felt like monitoring "stopped". Keeping it
                mounted preserves the live data; the backend pollers were
                always running, only the UI side was losing state. */}
            <div className={`flex-1 flex flex-col overflow-hidden ${activeView === "monitor" ? "" : "hidden"}`}>
              <MonitoringPanel
                servers={servers}
                refreshServers={refreshServers}
                addLog={addLog}
                onOpenServer={(id: number) => { const s = servers.find((v: any) => v.id === id); if (s) openServer(s); }}
                onAlertCount={setMonitorAlerts}
              />
            </div>

            {/* Compare workspace — pick any subset of open sessions and
                tile their currently-visible terminals in one canvas.
                Uses BroadcastContext.sessionTerminalMap to look up which
                of each session's tabs is the "current" one; a tile just
                re-mounts a TerminalView pointing at that (sessionId,
                terminalId) pair. Since the source SessionView also stays
                mounted, both instances stay in sync via the shared
                `terminal-output-<id>` events — closing a tile doesn't
                tear the terminal down, it just detaches this view.

                Layout: `grid-cols-N` for up to 4 tiles (1/2/2/2), then
                `grid-cols-3` for 5-9, then `grid-cols-4` for 10+. Rows
                fill down; each tile stretches equally so the user
                doesn't have to fiddle with dividers to compare row
                lengths — the whole point of compare mode is uniform
                side-by-side. */}
            {activeView === "logs" && (
              <div className="flex-1 flex flex-col overflow-hidden bg-surface">
                <header className="h-[52px] shrink-0 flex items-center gap-2 pl-2 pr-3 border-b border-white/[0.075]">
                  <button type="button" onClick={() => setActiveView("settings")} aria-label="Back to Settings" title="Back to Settings" className="icon-btn">
                    <ChevronLeft size={16} aria-hidden />
                  </button>
                  <span className="flex-1 min-w-0 h-6 flex items-center font-semibold text-white truncate">Activity</span>
                  <button type="button" disabled={logs.length === 0} onClick={async () => {
                    const ok = await confirm({ title: "Clear activity log?", message: "All entries will be discarded.", okLabel: "Clear", destructive: true });
                    if (!ok) return;
                    setLogs([]);
                  }} className="btn">
                    <Trash2 size={13} aria-hidden /> Clear
                  </button>
                </header>

                <div className="flex-1 overflow-y-auto custom-scrollbar px-2 py-2 sm:px-6 sm:py-4 select-text cursor-text">
                  {logs.length === 0 ? (
                    <div className="h-full flex items-center justify-center text-zinc-500">
                      Nothing yet.
                    </div>
                  ) : (
                    <ol className="font-mono text-[12px] leading-[18px]">
                    {[...logs].reverse().map((log) => (
                      <li
                        key={(log as any).id ?? `${log.time}-${log.msg}`}
                        className="flex flex-col sm:flex-row sm:items-start sm:gap-3 px-2 py-1 rounded-md hover:bg-white/[0.04]"
                      >
                        <div className="flex items-baseline gap-2 sm:gap-3 sm:shrink-0">
                          <span className="text-zinc-500 sm:w-20 shrink-0 tabular-nums">{log.time}</span>
                          <span className={`sm:w-16 shrink-0 font-sans text-[11.5px] font-medium ${log.type === 'error' ? 'text-danger' : log.type === 'success' ? 'text-success' : log.type === 'warn' ? 'text-warning' : 'text-zinc-400'}`}>
                            {log.type === 'error' ? 'Error' : log.type === 'success' ? 'Done' : log.type === 'warn' ? 'Warning' : 'Info'}
                          </span>
                        </div>
                        <span className="text-zinc-200 break-all sm:flex-1">{log.msg}</span>
                      </li>
                    ))}
                    </ol>
                  )}
                </div>
              </div>
            )}

          </main>
          </div>
        </div>
      )}

      <ServerEditor
        isOpen={isPanelOpen} onClose={() => { setIsPanelOpen(false); setFormError(""); }}
        newNode={newNode} setNewNode={setNewNode}
        isEditMode={!!newNode.id}
        importRequest={importRequest}
        onSave={async () => {
          if (!newNode.name || !newNode.host) {
            setFormError("Name and Host are required.");
            addLog("Name and Host are required.", "error");
            return;
          }
          if (newNode.authType === "vault" && !newNode.credentialId) {
            setFormError("Please pick a saved login.");
            addLog("Please pick a saved login.", "error");
            return;
          }
          if ((newNode.protocol ?? "ssh") === "ssh" && newNode.authType === "custom_key" && !newNode.keyId) {
            setFormError("Please pick an SSH key.");
            addLog("Please pick an SSH key.", "error");
            return;
          }
          try {
            // Identity fields are only meaningful for inline (custom_*) modes;
            // in vault mode the credential owns username/password/key and we
            // send nulls so the DB row matches reality. The backend's
            // `normalize_server_identity` enforces this again on the server
            // side as a belt-and-suspenders guarantee.
            const isInline = newNode.authType === "custom_pass" || newNode.authType === "custom_key";
            // An RDP (issue #3), telnet (#179) or VNC server has a host,
            // port, login (its own or a saved one) and maybe an SSH server to
            // go through; nothing that runs over SSH (forwards, mirrors,
            // autostart, a proxy, a key). Its saved password is kept: an RDP
            // server's for the built-in client and Remote Desktop Connection, a
            // telnet server's for the terminal's password button, a VNC
            // server's for its login.
            const isRdp = newNode.protocol === "rdp";
            const isTelnet = newNode.protocol === "telnet";
            const isVnc = newNode.protocol === "vnc";
            const payload = isRdp || isTelnet || isVnc ? {
              name: newNode.name,
              host: newNode.host,
              port: newNode.port,
              username: isInline && !isVnc ? (newNode.username?.trim() || null) : null,
              password: newNode.authType === "custom_pass" ? (newNode.password || null) : null,
              credentialId: (newNode.authType === "vault" && newNode.credentialId) ? parseInt(newNode.credentialId) : null,
              folderId: newNode.folderId ? parseInt(newNode.folderId) : null,
              proxyType: "none",
              proxyHost: "",
              proxyPort: 1080,
              tunnels: [],
              authType: newNode.authType === "vault" ? "vault" : "custom_pass",
              keyId: null,
              autostart: false,
              mirrors: [],
              color: newNode.color ?? null,
              preservePassword: !!newNode.id && !newNode.password_dirty,
            } : {
              name: newNode.name,
              host: newNode.host,
              port: newNode.port,
              // A blank username stays blank: the connection asks for it
              // ("Login as", issue #54).
              username: isInline ? (newNode.username?.trim() || null) : null,
              password: newNode.authType === "custom_pass" ? (newNode.password || null) : null,
              credentialId: (newNode.authType === "vault" && newNode.credentialId) ? parseInt(newNode.credentialId) : null,
              folderId: newNode.folderId ? parseInt(newNode.folderId) : null,
              proxyType: newNode.proxyType || "none",
              proxyHost: newNode.proxyHost || "",
              proxyPort: newNode.proxyPort || 1080,
              // A forward's name is kept trimmed and a blank one not at all,
              // as the Ports panel keeps it; "stopped" only when it is.
              tunnels: (newNode.tunnels || []).map(({ name, stopped, ...t }: any) => ({
                ...t,
                ...(typeof name === "string" && name.trim() ? { name: name.trim() } : {}),
                ...(stopped ? { stopped: true } : {}),
              })),
              authType: newNode.authType,
              keyId: newNode.authType === "custom_key" && newNode.keyId ? parseInt(newNode.keyId) : null,
              autostart: !!newNode.autostart,
              mirrors: newNode.mirrors || [],
              color: newNode.color ?? null,
              // Edit-mode + untouched password field = ask the backend to
              // keep the existing column. Otherwise the bind below sends
              // whatever's in the field (including empty / null) which
              // would overwrite the DB value.
              preservePassword: !!newNode.id && !newNode.password_dirty,
            };
            const action = newNode.id
              ? invoke<void>("edit_server", { id: newNode.id, ...payload }).then(() => newNode.id!)
              : invoke<number>("add_server", payload);

            const savedId = await action;
            // Notes live on the server row but go through their own command
            // (set_server_notes) so we don't have to thread a long-text field
            // through every add/edit_server signature. Empty string is valid
            // — clears any previous note.
            try {
              await invoke("set_server_notes", { id: savedId, notes: newNode.notes || "" });
            } catch (e) {
              addLog(`SAVE_NOTES_FAILED: ${e}`, "error");
            }
            // Same separate-write pattern for the on-connect commands.
            try {
              await invoke("set_server_run_on_connect", { id: savedId, value: newNode.runOnConnect || "" });
            } catch (e) {
              addLog(`SAVE_RUN_ON_CONNECT_FAILED: ${e}`, "error");
            }
            // ProxyJump target — same separate-write pattern. Empty string
            // means "no jump host" → store NULL.
            try {
              await invoke("set_server_jump_host", { id: savedId, value: newNode.jumpHostId ? parseInt(newNode.jumpHostId) : null });
            } catch (e) {
              addLog(`SAVE_JUMP_HOST_FAILED: ${e}`, "error");
            }
            // SSH, RDP, telnet or VNC: the same separate-write pattern.
            try {
              await invoke("set_server_protocol", { id: savedId, value: isRdp ? "rdp" : isTelnet ? "telnet" : isVnc ? "vnc" : null });
            } catch (e) {
              addLog(`SAVE_PROTOCOL_FAILED: ${e}`, "error");
            }
            // An RDP server's options are this device's own, kept by its sync
            // id (a new server has one once it's saved).
            if (isRdp) {
              try {
                const uuid = (await invoke<any[]>("get_servers")).find((s) => s.id === savedId)?.uuid;
                if (uuid) writeRdpOptions(uuid, newNode.rdpOptions || DEFAULT_RDP_OPTIONS);
              } catch (e) {
                addLog(`SAVE_RDP_OPTIONS_FAILED: ${e}`, "error");
              }
            }
            // A VNC server's speed and quality: the same, this device's own.
            if (isVnc) {
              try {
                const uuid = (await invoke<any[]>("get_servers")).find((s) => s.id === savedId)?.uuid;
                if (uuid) writeVncOptions(uuid, newNode.vncOptions || DEFAULT_VNC_OPTIONS);
              } catch (e) {
                addLog(`SAVE_VNC_OPTIONS_FAILED: ${e}`, "error");
              }
            }
            setIsPanelOpen(false);
            setFormError("");
            refreshServers();
            bumpSync();
            // If we just edited a node whose session is live, re-apply its saved
            // forwarding rules now so a changed/added tunnel comes up without a
            // manual reconnect. The backend cleared the stale tunnel cache when
            // the rules changed, so this re-seeds from the freshly-saved DB rules
            // (idempotent + a no-op when nothing forwarding-related changed).
            if (newNode.id && sessionStatuses[`session-${savedId}`] === "connected") {
              invoke("restart_session_tunnels", { sessionId: `session-${savedId}`, serverId: savedId }).catch(() => {});
            }
            addLog(`Node ${newNode.id ? 'updated' : 'added'} successfully.`, "success");
          } catch (e) {
            setFormError(`Failed to save: ${e}`);
            addLog(`SAVE_ERROR: ${e}`, "error");
          }
        }}
        formError={formError}
        credentials={credentials} sshKeys={sshKeys} refreshSshKeys={refreshSshKeys} folders={folders} refreshFolders={refreshFolders}
        refreshServers={refreshServers}
        servers={servers}
        isMobile={isMobile}
      />

      {paletteOpen && isUnlocked && (
        <CommandPalette
          items={paletteItems()}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      <QuickConnectModal
        isOpen={isQuickConnectOpen}
        onClose={() => setIsQuickConnectOpen(false)}
        onConnect={openQuickConnect}
      />


      {/* The slide-overs stay mounted while closed (to slide out): inert
          then, so Tab can't reach their fields. */}
      <div inert={isCommandPanelOpen ? undefined : ""} className={`fixed inset-0 z-50 transition-all duration-500 flex justify-end ${isCommandPanelOpen ? 'bg-scrim backdrop-blur-sm' : 'opacity-0 pointer-events-none'}`} onClick={() => setIsCommandPanelOpen(false)}>
        <div ref={commandPanelRef} tabIndex={-1} className={`w-full max-w-[400px] bg-surface border-l border-white/[0.075] shadow-sheet transition-all duration-500 h-full flex flex-col outline-none ${isCommandPanelOpen ? 'translate-x-0' : 'translate-x-full'}`} onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center h-[52px] px-4 border-b border-white/[0.075] shrink-0">
            <h2 className="text-[15px] font-semibold text-white flex items-center gap-2">
              <TerminalSquare size={16} aria-hidden className="text-primary" />
              {editCommandData.id ? "Edit command" : "New command"}
            </h2>
            <button aria-label="Close" onClick={() => { setIsCommandPanelOpen(false); setFormError(""); }} className="icon-btn">
              <X size={16} />
            </button>
          </div>
          <div className="p-4 sm:p-5 flex-1 overflow-y-auto custom-scrollbar space-y-4">
            {formError && <div role="alert" className="rounded-lg bg-danger/[0.12] px-3 py-2 text-[12.5px] text-white">{formError}</div>}
            <div className="space-y-1.5">
              <label htmlFor="cmd-title" className="text-[12px] text-zinc-400">Title</label>
              <input id="cmd-title" type="text" className="field h-8" placeholder="e.g. Update packages" value={editCommandData.title} onChange={e => setEditCommandData({ ...editCommandData, title: e.target.value })} />
            </div>
            <div className="space-y-1.5 flex flex-col h-64">
              <label htmlFor="cmd-content" className="text-[12px] text-zinc-400">Command</label>
              <textarea id="cmd-content" spellCheck={false} className="field h-auto flex-1 py-2 font-mono text-[12.5px] leading-[18px] custom-scrollbar resize-none" placeholder="sudo apt update && sudo apt upgrade -y" value={editCommandData.content} onChange={e => setEditCommandData({ ...editCommandData, content: e.target.value })} />
            </div>
            {/* Remounted per command opened, so it starts from that command's choice. */}
            <CommandScopePicker
              key={`${isCommandPanelOpen}-${editCommandData.id ?? "new"}`}
              scope={editCommandData.scope}
              onChange={(scope) => setEditCommandData((d) => ({ ...d, scope }))}
              servers={servers}
              folders={folders}
            />
          </div>
          <div className="p-4 border-t border-white/[0.075] shrink-0">
            <button 
              onClick={async () => {
                if (!editCommandData.title.trim() || !editCommandData.content.trim()) {
                  setFormError("Give the command a title and the command itself.");
                  return;
                }
                const scope = editCommandData.scope;
                if (scope && !scope.servers.length && !scope.folders.length) {
                  setFormError("Tick at least one server or folder, or choose All servers.");
                  return;
                }
                try {
                  if (editCommandData.id) {
                    await invoke("edit_command", { id: editCommandData.id, title: editCommandData.title, content: editCommandData.content });
                    await invoke("set_command_scope", { id: editCommandData.id, scope: scopeToJson(scope) });
                  } else {
                    await invoke("add_command", { title: editCommandData.title, content: editCommandData.content, scope: scopeToJson(scope) });
                  }
                  setFormError("");
                  setIsCommandPanelOpen(false);
                  refreshCommands();
                  bumpSync();
                  addLog("Command saved.", "success");
                } catch (e) {
                  setFormError(`Failed to save command: ${e}`);
                  addLog(`COMMAND_SAVE_ERROR: ${e}`, "error");
                }
              }} 
              className="btn btn-primary w-full h-8"
            >
              Save
            </button>
          </div>
        </div>
      </div>

      <div inert={isNotePanelOpen ? undefined : ""} className={`fixed inset-0 z-50 transition-all duration-500 flex justify-end ${isNotePanelOpen ? 'bg-scrim backdrop-blur-sm' : 'opacity-0 pointer-events-none'}`} onClick={() => setIsNotePanelOpen(false)}>
        <div ref={notePanelRef} tabIndex={-1} className={`w-full max-w-[480px] bg-surface border-l border-white/[0.075] shadow-sheet transition-all duration-500 h-full flex flex-col outline-none ${isNotePanelOpen ? 'translate-x-0' : 'translate-x-full'}`} onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center h-[52px] px-4 border-b border-white/[0.075] shrink-0">
            <h2 className="text-[15px] font-semibold text-white flex items-center gap-2">
              <StickyNote size={16} aria-hidden className="text-primary" />
              {editNoteData.id ? "Edit note" : "New note"}
            </h2>
            <button aria-label="Close" onClick={() => { setIsNotePanelOpen(false); setFormError(""); }} className="icon-btn">
              <X size={16} />
            </button>
          </div>
          <div className="p-4 sm:p-5 flex-1 overflow-y-auto custom-scrollbar space-y-4 flex flex-col">
            {formError && <div role="alert" className="rounded-lg bg-danger/[0.12] px-3 py-2 text-[12.5px] text-white">{formError}</div>}
            <div className="space-y-1.5">
              <label htmlFor="note-title" className="text-[12px] text-zinc-400">Title</label>
              <input id="note-title" type="text" className="field h-8" placeholder="e.g. Where the backups live" value={editNoteData.title} onChange={e => setEditNoteData({ ...editNoteData, title: e.target.value })} />
            </div>
            <div className="space-y-1.5 flex-1 flex flex-col min-h-[240px]">
              <label htmlFor="note-body" className="text-[12px] text-zinc-400">Note</label>
              <textarea id="note-body" className="field h-auto flex-1 py-2 leading-[19px] custom-scrollbar resize-none" placeholder="Paths, addresses, steps you'd otherwise look up again…" value={editNoteData.body} onChange={e => setEditNoteData({ ...editNoteData, body: e.target.value })} />
            </div>
          </div>
          <div className="p-4 border-t border-white/[0.075] shrink-0">
            <button
              onClick={async () => {
                if (!editNoteData.title.trim() && !editNoteData.body.trim()) {
                  setFormError("Add a title or some content first.");
                  return;
                }
                try {
                  const action = editNoteData.id
                    ? invoke("edit_note", { id: editNoteData.id, title: editNoteData.title, body: editNoteData.body })
                    : invoke("add_note", { title: editNoteData.title, body: editNoteData.body });
                  await action;
                  setIsNotePanelOpen(false);
                  refreshNotes();
                  bumpSync();
                  addLog("Note saved.", "success");
                } catch (e) {
                  setFormError(`Failed to save note: ${e}`);
                  addLog(`NOTE_SAVE_ERROR: ${e}`, "error");
                }
              }}
              className="btn btn-primary w-full h-8"
            >
              Save
            </button>
          </div>
        </div>
      </div>

      <div inert={isCredPanelOpen ? undefined : ""} className={`fixed inset-0 z-50 transition-all duration-500 flex justify-end ${isCredPanelOpen ? 'bg-scrim backdrop-blur-sm' : 'opacity-0 pointer-events-none'}`} onClick={() => setIsCredPanelOpen(false)}>
        <div ref={credPanelRef} tabIndex={-1} className={`w-full max-w-[400px] bg-surface border-l border-white/[0.075] shadow-sheet transition-all duration-500 h-full flex flex-col outline-none ${isCredPanelOpen ? 'translate-x-0' : 'translate-x-full'}`} onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center h-[52px] px-4 border-b border-white/[0.075] shrink-0">
            <h2 className="text-[15px] font-semibold text-white flex items-center gap-2">
              <LockKeyhole size={16} aria-hidden className="text-primary" />
              {editCredData.id ? "Edit login" : "New password"}
            </h2>
            <button aria-label="Close" onClick={() => { setIsCredPanelOpen(false); setFormError(""); }} className="icon-btn">
              <X size={16} />
            </button>
          </div>
          <div className="p-4 sm:p-5 flex-1 overflow-y-auto space-y-4">
            {formError && <div role="alert" className="rounded-lg bg-danger/[0.12] px-3 py-2 text-[12.5px] text-white">{formError}</div>}
            <div className="space-y-1.5">
              <label className="text-[12px] text-zinc-400">Name</label>
              <input type="text" className="field h-8" placeholder="e.g. Work server" value={editCredData.name} onChange={e => setEditCredData({ ...editCredData, name: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[12px] text-zinc-400">Username</label>
              <input type="text" className="field h-8" placeholder="Ask when connecting" value={editCredData.username} onChange={e => setEditCredData({ ...editCredData, username: e.target.value })} />
            </div>
            <div className="space-y-4 pt-2">
              <div className="flex justify-between items-center">
                <label className="text-[12px] text-zinc-400">Sign in with</label>
                <select
                  className="field h-7 w-auto text-[12px]"
                  value={editCredData.auth_type || "password"}
                  onChange={e => setEditCredData({ ...editCredData, auth_type: e.target.value })}
                >
                  <option value="password">Password</option>
                  <option value="key">SSH key</option>
                </select>
              </div>
            </div>
            {editCredData.auth_type === "key" ? (
              <div className="space-y-1.5 animate-in fade-in">
                <label className="text-[12px] text-zinc-400">Pick a key</label>
                <select
                  className="field h-8"
                  value={editCredData.key_id?.toString() || ""}
                  onChange={e => setEditCredData({ ...editCredData, key_id: e.target.value ? parseInt(e.target.value) : null })}
                >
                  <option value="">Pick a key</option>
                  {sshKeys?.map((k: any) => (
                    <option key={k.id} value={k.id.toString()}>{k.name}</option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="space-y-1.5 animate-in fade-in">
                <label className="text-[12px] text-zinc-400">Password</label>
                <PasswordField
                  value={editCredData.password || ""}
                  onChange={(v) => setEditCredData({ ...editCredData, password: v })}
                  className="field h-8"
                />
                <p className="text-[11.5px] leading-[15px] text-zinc-500">Leave empty to be asked when connecting.</p>
              </div>
            )}
          </div>
          <div className="p-4 border-t border-white/[0.075] shrink-0">
            <button 
              onClick={async () => {
                if (!editCredData.name) {
                  setFormError("Give the login a name.");
                  return;
                }
                if (editCredData.auth_type === "key" && !editCredData.key_id) {
                  setFormError("Pick the SSH key this login signs in with.");
                  return;
                }
                try {
                  const payload = {
                    name: editCredData.name,
                    authType: editCredData.auth_type || "password",
                    // Blank = asked when connecting (issue #54).
                    username: editCredData.username?.trim() ?? "",
                    password: editCredData.auth_type === "key" ? null : (editCredData.password || null),
                    keyId: editCredData.auth_type === "key" ? (editCredData.key_id ? parseInt(editCredData.key_id.toString()) : null) : null
                  };
                  const action = editCredData.id 
                    ? invoke("edit_credential", { id: editCredData.id, ...payload })
                    : invoke("add_credential", payload);
                  await action;
                  setIsCredPanelOpen(false);
                  refreshCredentials();
                  bumpSync();
                  addLog(`Saved ${editCredData.name}.`, "success");
                } catch (e) {
                  setFormError(`Couldn't save the login: ${e}`);
                  addLog(`CRED_SAVE_ERROR: ${e}`, "error");
                }
              }} 
              className="btn btn-primary w-full h-8"
            >
              Save
            </button>
          </div>
        </div>
      </div>

      <div inert={isKeyPanelOpen ? undefined : ""} className={`fixed inset-0 z-50 transition-all duration-500 flex justify-end ${isKeyPanelOpen ? 'bg-scrim backdrop-blur-sm' : 'opacity-0 pointer-events-none'}`} onClick={() => setIsKeyPanelOpen(false)}>
        <div ref={keyPanelRef} tabIndex={-1} className={`w-full max-w-[450px] bg-surface border-l border-white/[0.075] shadow-sheet transition-all duration-500 h-full flex flex-col outline-none ${isKeyPanelOpen ? 'translate-x-0' : 'translate-x-full'}`} onClick={(e) => e.stopPropagation()}>
          <div className="flex justify-between items-center h-[52px] px-4 border-b border-white/[0.075] shrink-0">
            <h2 className="text-[15px] font-semibold text-white flex items-center gap-2">
              <KeyRound size={16} aria-hidden className="text-primary" />
              {editKeyData.id ? "Edit SSH key" : "Add SSH key"}
            </h2>
            <button aria-label="Close" onClick={() => { setIsKeyPanelOpen(false); setFormError(""); }} className="icon-btn">
              <X size={16} />
            </button>
          </div>
          <div className="p-4 sm:p-5 flex-1 overflow-y-auto space-y-4">
            {formError && <div role="alert" className="rounded-lg bg-danger/[0.12] px-3 py-2 text-[12.5px] text-white">{formError}</div>}
            {/* Reading the key out of ~/.ssh beats making the user cat it in a
                terminal and paste two multi-line blobs. Fields are filled in
                rather than saved outright — the name is a guess from the
                filename, and a passphrase-protected key still needs its
                passphrase, so the user reviews before saving. */}
            <button
              type="button"
              onClick={async () => {
                setFormError("");
                try {
                  const path = await invoke<string | null>("pick_ssh_key_file");
                  if (!path) return;
                  const loaded = await invoke<{
                    suggested_name: string;
                    private_key: string;
                    public_key: string;
                    encrypted: boolean;
                  }>("read_ssh_key_file", { path });
                  setEditKeyData({
                    ...editKeyData,
                    name: editKeyData.name || loaded.suggested_name,
                    public_key: loaded.public_key,
                    private_key: loaded.private_key,
                  });
                  addLog(
                    loaded.encrypted
                      ? "Key loaded — it's passphrase-protected. Fill in the passphrase below, or leave it empty to be asked when connecting."
                      : "Key loaded from file.",
                    loaded.encrypted ? "info" : "success",
                  );
                } catch (e) {
                  setFormError(`Couldn't read that key file: ${e}`);
                  addLog(`KEY_FILE_READ_ERROR: ${e}`, "error");
                }
              }}
              className="btn w-full h-8"
            >
              <Upload size={13} aria-hidden />
              Load from a key file
            </button>
            <div className="space-y-1.5">
              <label className="text-[12px] text-zinc-400">Name</label>
              <input type="text" className="field h-8" placeholder="e.g. My laptop key" value={editKeyData.name} onChange={e => setEditKeyData({ ...editKeyData, name: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[12px] text-zinc-400">Public key</label>
              <textarea className="field h-24 py-2 font-mono text-[12px] leading-[18px] resize-none custom-scrollbar" placeholder="ssh-ed25519 ..." value={editKeyData.public_key} onChange={e => setEditKeyData({ ...editKeyData, public_key: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[12px] text-zinc-400">Private key</label>
              <textarea className="field h-32 py-2 font-mono text-[12px] leading-[18px] resize-none custom-scrollbar" placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" value={editKeyData.private_key} onChange={e => setEditKeyData({ ...editKeyData, private_key: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <label className="text-[12px] text-zinc-400">Passphrase (if any)</label>
              <PasswordField
                value={editKeyData.passphrase || ""}
                onChange={(v) => setEditKeyData({ ...editKeyData, passphrase: v })}
                className="field h-8"
              />
              <p className="text-[11.5px] leading-[15px] text-zinc-500">For an encrypted key, leave empty to be asked when connecting.</p>
            </div>
          </div>
          <div className="p-4 border-t border-white/[0.075] shrink-0">
            <button 
              onClick={async () => {
                if (!editKeyData.name || !editKeyData.private_key) {
                  setFormError("A key needs a name and its private key.");
                  return;
                }
                try {
                  const payload = {
                    name: editKeyData.name,
                    publicKey: editKeyData.public_key,
                    privateKey: editKeyData.private_key,
                    passphrase: editKeyData.passphrase || null
                  };
                  const action = editKeyData.id 
                    ? invoke("edit_ssh_key", { id: editKeyData.id, ...payload })
                    : invoke("add_ssh_key", payload);
                  await action;
                  setIsKeyPanelOpen(false);
                  refreshSshKeys();
                  bumpSync();
                  addLog(`Saved ${editKeyData.name}.`, "success");
                } catch (e) {
                  setFormError(`Couldn't save the key: ${e}`);
                  addLog(`KEY_SAVE_ERROR: ${e}`, "error");
                }
              }} 
              className="btn btn-primary w-full h-8"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default DesktopApp;