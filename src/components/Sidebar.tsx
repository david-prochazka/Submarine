import { useEffect, useMemo, useRef, useState } from "react";
import {
  Server, KeyRound, Library, Activity, Settings, Lock, UserCircle, Folder, FolderOpen,
  ChevronRight, Plus, LayoutGrid, PanelLeftClose, PanelLeftOpen, RefreshCw, Search,
} from "lucide-react";
import { folderTree } from "../util/folderTree";
import { favoriteKey } from "../util/favorites";
import { HAS_LIGHTS, LIGHTS_INSET } from "./WindowControls";

const COLLAPSED_KEY = "submarine-sidebar-collapsed";

const readCollapsed = () => {
  try { return localStorage.getItem(COLLAPSED_KEY) === "on"; } catch { return false; }
};

const itemBase =
  "w-full flex items-center gap-2 h-7 px-2 rounded-md text-[13px] text-left transition-colors duration-100";
const itemTone = (active: boolean) =>
  active ? "bg-primary/15 text-white" : "text-white hover:bg-white/5";
const iconTone = (active: boolean) => (active ? "text-primary" : "text-zinc-400");

const Count = ({ n }: { n: number }) =>
  n > 0 ? <span className="text-[11px] text-zinc-500 tabular-nums px-0.5">{n}</span> : null;

const alertLabel = (label: string, n: number) => (n > 0 ? `${label}, ${n === 1 ? "1 alert" : `${n} alerts`}` : label);

const STATUS_DOT: Record<string, string> = { connected: "bg-emerald-400", connecting: "bg-amber-400 animate-pulse", failed: "bg-rose-500" };
const STATUS_LABEL: Record<string, string> = { connected: "Connected", connecting: "Connecting", failed: "Disconnected" };

// A count on an icon, for the rail and the phone dock.
const AlertDot = ({ n }: { n: number }) => (
  <span aria-hidden className="absolute -top-1 -right-1.5 min-w-[15px] h-[15px] px-1 rounded-full bg-danger text-snow text-[9.5px] font-semibold leading-[15px] text-center tabular-nums">
    {n > 9 ? "9+" : n}
  </span>
);

const SectionTitle = ({ children, action }: { children: string; action?: React.ReactNode }) => (
  <div className="flex items-center justify-between h-8 pt-3.5 pb-1 px-2 text-[11px] font-semibold text-zinc-500">
    <span>{children}</span>
    {action}
  </div>
);

// Desktop: a named sidebar (servers by folder, then the tools, then the
// profile) that collapses to an icon rail. Mobile: a bottom dock, so the
// terminal keeps the full width of a phone. DesktopApp puts the dock last
// visually with flex-col-reverse, keeping it first in tab order.
export const Sidebar = ({
  activeTab, setActiveTab, isMobile, onLogout, profileName, syncing,
  servers = [], folders = [], activeFolderId = null, onOpenFolder, onAddServer,
  loginCount = 0, libraryCount = 0, monitorAlerts = 0, wallCount, onSearch, searchShortcut, lockShortcut,
  toggleRequest = 0, sidebarShortcut, settingsShortcut, serverStatus = {}, onOpenServer, favorites,
}: any) => {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try { localStorage.setItem(COLLAPSED_KEY, c ? "off" : "on"); } catch { /* storage blocked */ }
      return !c;
    });
  };
  // ⌃⌘S from DesktopApp: each new request flips the sidebar.
  const seenToggle = useRef(toggleRequest);
  useEffect(() => {
    if (toggleRequest === seenToggle.current) return;
    seenToggle.current = toggleRequest;
    toggleCollapsed();
  }, [toggleRequest]);

  const tree = useMemo(() => folderTree(folders), [folders]);
  const countIn = useMemo(() => {
    const direct = new Map<number | null, number>();
    for (const s of servers) {
      const f = tree.serverFolder(s);
      direct.set(f, (direct.get(f) ?? 0) + 1);
    }
    return (id: number) => {
      let n = 0;
      tree.subtreeOf(id).forEach((f) => { n += direct.get(f) ?? 0; });
      return n;
    };
  }, [servers, tree]);
  const openPath = useMemo(
    () => new Set<number>(activeFolderId != null && tree.has(activeFolderId) ? tree.pathOf(activeFolderId).map((f: any) => f.id) : []),
    [activeFolderId, tree],
  );

  const serversIn = useMemo(() => {
    const by = new Map<number, any[]>();
    for (const s of servers) {
      const f = tree.serverFolder(s);
      if (f == null || !openPath.has(f)) continue;
      by.set(f, [...(by.get(f) ?? []), s]);
    }
    return by;
  }, [servers, tree, openPath]);

  const favoriteServers = useMemo(
    () => (favorites?.size ? servers.filter((s: any) => favorites.has(favoriteKey(s))) : []),
    [servers, favorites],
  );

  const tools = [
    { id: "vault", icon: KeyRound, label: "Logins", count: loginCount, alerts: 0 },
    { id: "library", icon: Library, label: "Library", count: libraryCount, alerts: 0 },
    { id: "monitor", icon: Activity, label: "Monitor", count: 0, alerts: monitorAlerts },
  ];

  if (isMobile) {
    const items = [{ id: "nodes", icon: Server, label: "Servers" }, ...tools];
    const dockBtn = (active: boolean, iconOnly = false) =>
      `flex flex-col items-center justify-center gap-0.5 h-12 rounded-lg text-[10.5px] font-medium transition-colors ${
        iconOnly ? "w-10 shrink-0" : "flex-1 min-w-0 max-w-[72px] px-1"
      } ${active ? "text-primary" : "text-zinc-400 hover:text-white"}`;
    return (
      <aside
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        className="w-full min-h-14 shrink-0 bg-sidebar border-t border-white/[0.075] flex items-center px-2 relative z-10"
      >
        <nav aria-label="Sections" className="flex-1 min-w-0 flex items-center justify-around gap-0.5">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              aria-current={activeTab === item.id ? "page" : undefined}
              className={dockBtn(activeTab === item.id)}
            >
              <span className="relative">
                <item.icon size={19} aria-hidden />
                {"alerts" in item && item.alerts > 0 && <AlertDot n={item.alerts} />}
              </span>
              <span className="max-w-full truncate">{item.label}</span>
              {"alerts" in item && item.alerts > 0 && <span className="sr-only">, {alertLabel("", item.alerts).slice(2)}</span>}
            </button>
          ))}
        </nav>
        <div className="shrink-0 flex items-center pl-1 ml-1 border-l border-white/[0.075]">
          <button type="button" onClick={() => setActiveTab("profile")} aria-label={profileName ? `Profile ${profileName}` : "Profile"} className={dockBtn(activeTab === "profile", true)}>
            <span className="relative">
              <UserCircle size={19} aria-hidden />
              {syncing && <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />}
            </span>
          </button>
          {onLogout && (
            <button type="button" onClick={onLogout} aria-label="Lock" className={dockBtn(false, true)}>
              <Lock size={19} aria-hidden />
            </button>
          )}
          <button type="button" onClick={() => setActiveTab("settings")} aria-label="Settings" className={dockBtn(activeTab === "settings", true)}>
            <Settings size={19} aria-hidden />
          </button>
        </div>
      </aside>
    );
  }

  if (collapsed) {
    const railBtn = (active: boolean) =>
      `relative w-9 h-9 flex items-center justify-center rounded-lg transition-colors ${
        active ? "bg-primary/15 text-primary" : "text-zinc-400 hover:bg-white/5 hover:text-white"
      }`;
    return (
      <aside aria-label="Sidebar" className={`${HAS_LIGHTS ? "w-[88px]" : "w-14"} h-full shrink-0 bg-sidebar border-r border-white/[0.075] flex flex-col items-center pb-2 gap-1 overflow-y-auto no-scrollbar`}>
        {HAS_LIGHTS ? <div data-tauri-drag-region className="h-11 w-full shrink-0 border-b border-white/[0.075] mb-1" /> : <div className="h-1 shrink-0" />}
        <button type="button" onClick={toggleCollapsed} aria-label="Show sidebar" title={sidebarShortcut ? `Show sidebar (${sidebarShortcut})` : "Show sidebar"} aria-keyshortcuts={sidebarShortcut} className={railBtn(false)}>
          <PanelLeftOpen size={17} aria-hidden />
        </button>
        {onSearch && (
          <button type="button" onClick={onSearch} aria-label="Search or run a command" title={`Search or run… (${searchShortcut})`} aria-keyshortcuts={searchShortcut} className={railBtn(false)}>
            <Search size={17} aria-hidden />
          </button>
        )}
        <div className="w-6 border-t border-white/[0.075] my-1" />
        {[{ id: "nodes", icon: Server, label: "Servers", alerts: 0 }, ...tools].map((item) => (
          <button key={item.id} type="button" onClick={() => setActiveTab(item.id)} aria-label={alertLabel(item.label, item.alerts)} title={alertLabel(item.label, item.alerts)} aria-current={activeTab === item.id ? "page" : undefined} className={railBtn(activeTab === item.id)}>
            <item.icon size={18} aria-hidden />
            {item.alerts > 0 && <AlertDot n={item.alerts} />}
          </button>
        ))}
        {wallCount !== undefined && (
          <button type="button" onClick={() => setActiveTab("wall")} aria-label="Wall" title="Wall" className={railBtn(activeTab === "wall")}>
            <LayoutGrid size={18} aria-hidden />
          </button>
        )}
        <div className="mt-auto flex flex-col items-center gap-1 pt-2">
          <button type="button" onClick={() => setActiveTab("profile")} aria-label="Profile" title={profileName ? `Profile ${profileName}` : "Profile"} className={railBtn(activeTab === "profile")}>
            <UserCircle size={18} aria-hidden />
            {syncing && <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />}
          </button>
          {onLogout && (
            <button type="button" onClick={onLogout} aria-label="Lock" title={lockShortcut ? `Lock (${lockShortcut})` : "Lock"} aria-keyshortcuts={lockShortcut} className={railBtn(false)}>
              <Lock size={17} aria-hidden />
            </button>
          )}
          <button type="button" onClick={() => setActiveTab("settings")} aria-label="Settings" title={settingsShortcut ? `Settings (${settingsShortcut})` : "Settings"} aria-keyshortcuts={settingsShortcut} className={railBtn(activeTab === "settings")}>
            <Settings size={17} aria-hidden />
          </button>
        </div>
      </aside>
    );
  }

  const renderServer = (s: any, depth: number, inset = 18) => {
    const active = activeTab === `session-${s.id}`;
    const status = serverStatus[s.id];
    return (
      <li key={`s${s.id}`}>
        <button
          type="button"
          onClick={() => onOpenServer?.(s)}
          aria-current={active ? "page" : undefined}
          className={`${itemBase} ${itemTone(active)}`}
          style={{ paddingLeft: 8 + depth * 14 + inset }}
        >
          <span
            role="img"
            aria-label={status ? STATUS_LABEL[status] : "Not connected"}
            className={`w-1.5 h-1.5 shrink-0 rounded-full ${status ? STATUS_DOT[status] : "bg-zinc-600"}`}
          />
          <span className="flex-1 min-w-0 truncate">{s.name}</span>
        </button>
      </li>
    );
  };

  const renderFolder = (f: any, depth: number): React.ReactNode => {
    const active = activeTab === "nodes" && activeFolderId === f.id;
    const open = openPath.has(f.id);
    const children = tree.childrenOf(f.id);
    const Icon = open ? FolderOpen : Folder;
    return (
      <li key={f.id}>
        <button
          type="button"
          onClick={() => onOpenFolder?.(f.id)}
          aria-current={active ? "page" : undefined}
          className={`${itemBase} ${itemTone(active)}`}
          style={{ paddingLeft: 8 + depth * 14 }}
        >
          <ChevronRight
            size={12}
            aria-hidden
            className={`shrink-0 text-zinc-500 transition-transform duration-150 ${children.length === 0 && countIn(f.id) === 0 ? "invisible" : ""} ${open ? "rotate-90" : ""}`}
          />
          <Icon size={15} aria-hidden className={`shrink-0 ${f.color ? "" : iconTone(active)}`} style={f.color ? { color: f.color } : undefined} />
          <span className="flex-1 min-w-0 truncate">{f.name}</span>
          <Count n={countIn(f.id)} />
        </button>
        {open && (children.length > 0 || serversIn.has(f.id)) && (
          <ul>
            {children.map((c: any) => renderFolder(c, depth + 1))}
            {(serversIn.get(f.id) ?? []).map((s: any) => renderServer(s, depth + 1))}
          </ul>
        )}
      </li>
    );
  };

  const allActive = activeTab === "nodes" && activeFolderId == null;

  return (
    <aside aria-label="Sidebar" className="w-[232px] h-full shrink-0 bg-sidebar border-r border-white/[0.075] flex flex-col relative z-10">
      <div data-tauri-drag-region className={`h-11 shrink-0 flex items-center gap-2 pr-2 ${HAS_LIGHTS ? LIGHTS_INSET : "pl-4"}`}>
        <span data-tauri-drag-region className="flex-1" />
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="Hide sidebar"
          title={sidebarShortcut ? `Hide sidebar (${sidebarShortcut})` : "Hide sidebar"}
          aria-keyshortcuts={sidebarShortcut}
          className="w-7 h-7 flex items-center justify-center rounded-md text-zinc-400 hover:bg-white/[0.09] hover:text-white"
        >
          <PanelLeftClose size={16} aria-hidden />
        </button>
      </div>

      {onSearch && (
        <div className="shrink-0 px-2.5 pb-1.5">
          <button
            type="button"
            onClick={onSearch}
            aria-keyshortcuts={searchShortcut}
            className="w-full h-[30px] flex items-center gap-2 px-2.5 rounded-[7px] bg-white/[0.06] text-[13px] text-zinc-400 text-left transition-colors hover:bg-white/[0.09] hover:text-zinc-300"
          >
            <Search size={14} aria-hidden className="shrink-0" />
            <span className="flex-1 min-w-0 truncate">Search or run…</span>
            {searchShortcut && <kbd className="font-sans text-[11px] font-medium">{searchShortcut}</kbd>}
          </button>
        </div>
      )}
      <nav aria-label="Servers and tools" className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-2.5 pb-2.5">
        {favoriteServers.length > 0 && (
          <>
            <SectionTitle>Favourites</SectionTitle>
            <ul>{favoriteServers.map((s: any) => renderServer(s, 0, 4))}</ul>
          </>
        )}
        <SectionTitle
          action={onAddServer && (
            <button
              type="button"
              onClick={onAddServer}
              aria-label="New server"
              title="New server"
              className="w-5 h-5 flex items-center justify-center rounded text-zinc-400 hover:bg-white/[0.09] hover:text-white"
            >
              <Plus size={13} aria-hidden />
            </button>
          )}
        >
          Servers
        </SectionTitle>
        <ul>
          <li>
            <button type="button" onClick={() => onOpenFolder?.(null)} aria-current={allActive ? "page" : undefined} className={`${itemBase} ${itemTone(allActive)}`}>
              <Server size={15} aria-hidden className={`shrink-0 ${iconTone(allActive)}`} />
              <span className="flex-1 min-w-0 truncate">All servers</span>
              <Count n={servers.length} />
            </button>
          </li>
          {tree.childrenOf(null).map((f: any) => renderFolder(f, 0))}
        </ul>

        <SectionTitle>Tools</SectionTitle>
        <ul>
          {tools.map((item) => {
            const active = activeTab === item.id;
            return (
              <li key={item.id}>
                <button type="button" onClick={() => setActiveTab(item.id)} aria-current={active ? "page" : undefined} className={`${itemBase} ${itemTone(active)}`}>
                  <item.icon size={15} aria-hidden className={`shrink-0 ${iconTone(active)}`} />
                  <span className="flex-1 min-w-0 truncate">{item.label}</span>
                  {item.alerts > 0
                    ? <span className="pill h-4 px-1.5 text-[10.5px] bg-danger/[0.12] text-danger tabular-nums">{item.alerts}<span className="sr-only">{item.alerts === 1 ? " alert" : " alerts"}</span></span>
                    : <Count n={item.count} />}
                </button>
              </li>
            );
          })}
          {wallCount !== undefined && (
            <li>
              <button type="button" onClick={() => setActiveTab("wall")} aria-current={activeTab === "wall" ? "page" : undefined} className={`${itemBase} ${itemTone(activeTab === "wall")}`}>
                <LayoutGrid size={15} aria-hidden className={`shrink-0 ${iconTone(activeTab === "wall")}`} />
                <span className="flex-1 min-w-0 truncate">Wall</span>
                <Count n={wallCount} />
              </button>
            </li>
          )}
        </ul>
      </nav>

      <div className="shrink-0 border-t border-white/[0.075] px-2.5 pt-2 pb-2.5 flex items-center gap-1">
        <button
          type="button"
          onClick={() => setActiveTab("profile")}
          aria-current={activeTab === "profile" ? "page" : undefined}
          className={`flex-1 min-w-0 flex items-center gap-2.5 px-1.5 py-1 rounded-lg text-left transition-colors ${itemTone(activeTab === "profile")}`}
        >
          <span aria-hidden className="w-[26px] h-[26px] shrink-0 rounded-[7px] bg-primary/15 text-primary flex items-center justify-center text-[12px] font-semibold">
            {(profileName || "?").trim().charAt(0).toUpperCase()}
          </span>
          <span className="flex-1 min-w-0 flex flex-col leading-[15px]">
            <span className="font-medium truncate">{profileName || "Profile"}</span>
            <span className="text-[11px] text-zinc-500 flex items-center gap-1">
              {syncing ? <><RefreshCw size={10} aria-hidden className="animate-spin" /> Syncing…</> : "Profile & sharing"}
            </span>
          </span>
        </button>
        {onLogout && (
          <button
            type="button"
            onClick={onLogout}
            aria-label="Lock"
            title={lockShortcut ? `Lock (${lockShortcut})` : "Lock"} aria-keyshortcuts={lockShortcut}
            className="w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-zinc-400 hover:bg-white/[0.09] hover:text-white"
          >
            <Lock size={15} aria-hidden />
          </button>
        )}
        <button
          type="button"
          onClick={() => setActiveTab("settings")}
          aria-label="Settings"
          title={settingsShortcut ? `Settings (${settingsShortcut})` : "Settings"}
          aria-keyshortcuts={settingsShortcut}
          className={`w-7 h-7 shrink-0 flex items-center justify-center rounded-md transition-colors ${
            activeTab === "settings" ? "bg-primary/15 text-primary" : "text-zinc-400 hover:bg-white/[0.09] hover:text-white"
          }`}
        >
          <Settings size={15} aria-hidden />
        </button>
      </div>
    </aside>
  );
};
