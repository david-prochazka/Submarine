import { useMemo, useState } from "react";
import {
  Server, KeyRound, Library, Activity, Settings, Lock, UserCircle, Folder, FolderOpen,
  ChevronRight, Plus, LayoutGrid, PanelLeftClose, PanelLeftOpen, RefreshCw, Search,
} from "lucide-react";
import { folderTree } from "../util/folderTree";

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
  loginCount = 0, libraryCount = 0, wallCount, logoUrl, onSearch, searchShortcut,
}: any) => {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try { localStorage.setItem(COLLAPSED_KEY, c ? "off" : "on"); } catch { /* storage blocked */ }
      return !c;
    });
  };

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

  const tools = [
    { id: "vault", icon: KeyRound, label: "Logins", count: loginCount },
    { id: "library", icon: Library, label: "Library", count: libraryCount },
    { id: "monitor", icon: Activity, label: "Monitor", count: 0 },
  ];

  if (isMobile) {
    const items = [{ id: "nodes", icon: Server, label: "Servers" }, ...tools];
    const dockBtn = (active: boolean) =>
      `flex flex-col items-center justify-center gap-0.5 min-w-[52px] h-12 px-2 rounded-lg text-[10.5px] font-medium transition-colors ${
        active ? "text-primary" : "text-zinc-400 hover:text-white"
      }`;
    return (
      <aside
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
        className="w-full min-h-14 shrink-0 bg-sidebar border-t border-white/[0.075] flex items-center px-2 relative z-10"
      >
        <nav aria-label="Sections" className="flex-1 flex items-center justify-around gap-1">
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveTab(item.id)}
              aria-current={activeTab === item.id ? "page" : undefined}
              className={dockBtn(activeTab === item.id)}
            >
              <item.icon size={19} aria-hidden />
              {item.label}
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-1 pl-2 ml-1 border-l border-white/[0.075]">
          <button type="button" onClick={() => setActiveTab("profile")} aria-label={profileName ? `Profile ${profileName}` : "Profile"} className={dockBtn(activeTab === "profile")}>
            <span className="relative">
              <UserCircle size={19} aria-hidden />
              {syncing && <span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-primary animate-pulse" />}
            </span>
          </button>
          {onLogout && (
            <button type="button" onClick={onLogout} aria-label="Lock and switch profile" className={dockBtn(false)}>
              <Lock size={19} aria-hidden />
            </button>
          )}
          <button type="button" onClick={() => setActiveTab("settings")} aria-label="Settings" className={dockBtn(activeTab === "settings")}>
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
      <aside aria-label="Sidebar" className="w-14 h-full shrink-0 bg-sidebar border-r border-white/[0.075] flex flex-col items-center py-2 gap-1 overflow-y-auto no-scrollbar">
        <button type="button" onClick={toggleCollapsed} aria-label="Show sidebar" title="Show sidebar" className={railBtn(false)}>
          <PanelLeftOpen size={17} aria-hidden />
        </button>
        {onSearch && (
          <button type="button" onClick={onSearch} aria-label="Search or run a command" title={`Search or run… (${searchShortcut})`} aria-keyshortcuts={searchShortcut} className={railBtn(false)}>
            <Search size={17} aria-hidden />
          </button>
        )}
        <div className="w-6 border-t border-white/[0.075] my-1" />
        {[{ id: "nodes", icon: Server, label: "Servers" }, ...tools].map((item) => (
          <button key={item.id} type="button" onClick={() => setActiveTab(item.id)} aria-label={item.label} title={item.label} aria-current={activeTab === item.id ? "page" : undefined} className={railBtn(activeTab === item.id)}>
            <item.icon size={18} aria-hidden />
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
            <button type="button" onClick={onLogout} aria-label="Lock" title="Lock" className={railBtn(false)}>
              <Lock size={17} aria-hidden />
            </button>
          )}
          <button type="button" onClick={() => setActiveTab("settings")} aria-label="Settings" title="Settings" className={railBtn(activeTab === "settings")}>
            <Settings size={17} aria-hidden />
          </button>
        </div>
      </aside>
    );
  }

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
            className={`shrink-0 text-zinc-500 transition-transform duration-150 ${children.length === 0 ? "invisible" : ""} ${open ? "rotate-90" : ""}`}
          />
          <Icon size={15} aria-hidden className={`shrink-0 ${f.color ? "" : iconTone(active)}`} style={f.color ? { color: f.color } : undefined} />
          <span className="flex-1 min-w-0 truncate">{f.name}</span>
          <Count n={countIn(f.id)} />
        </button>
        {open && children.length > 0 && <ul>{children.map((c: any) => renderFolder(c, depth + 1))}</ul>}
      </li>
    );
  };

  const allActive = activeTab === "nodes" && activeFolderId == null;

  return (
    <aside aria-label="Sidebar" className="w-[232px] h-full shrink-0 bg-sidebar border-r border-white/[0.075] flex flex-col relative z-10">
      <div data-tauri-drag-region className="h-11 shrink-0 flex items-center gap-2 pl-4 pr-2">
        {logoUrl && <img src={logoUrl} alt="" draggable={false} className="h-5 w-5 object-contain" />}
        <span data-tauri-drag-region className="flex-1 text-[13px] font-semibold text-white tracking-tight">Submarine</span>
        <button
          type="button"
          onClick={toggleCollapsed}
          aria-label="Hide sidebar"
          title="Hide sidebar"
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
            className="w-full h-[30px] flex items-center gap-2 px-2.5 rounded-[7px] bg-white/[0.06] text-[13px] text-zinc-500 text-left transition-colors hover:bg-white/[0.09] hover:text-zinc-400"
          >
            <Search size={14} aria-hidden className="shrink-0" />
            <span className="flex-1 min-w-0 truncate">Search or run…</span>
            {searchShortcut && <kbd className="font-sans text-[11px] font-medium">{searchShortcut}</kbd>}
          </button>
        </div>
      )}
      <nav aria-label="Servers and tools" className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-2.5 pb-2.5">
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
                  <Count n={item.count} />
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
            aria-label="Lock and switch profile"
            title="Lock and switch profile"
            className="w-7 h-7 shrink-0 flex items-center justify-center rounded-md text-zinc-400 hover:bg-white/[0.09] hover:text-white"
          >
            <Lock size={15} aria-hidden />
          </button>
        )}
        <button
          type="button"
          onClick={() => setActiveTab("settings")}
          aria-label="Settings"
          title="Settings"
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
