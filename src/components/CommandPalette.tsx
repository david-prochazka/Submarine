import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Search, type LucideIcon } from "lucide-react";
import { fuzzyMatch, fuzzySegments } from "../util/fuzzy";

export type PaletteGroup = "Servers" | "Actions" | "Folders" | "Commands";

// What a row does with ⌘↩ (Ctrl+↩ off the Mac) or ⌥↩, besides ↩.
export type PaletteVariant = "meta" | "alt";

export type PaletteItem = {
  id: string;
  group: PaletteGroup;
  icon: LucideIcon;
  title: string;
  sub?: string;
  // Searched too, after the title, so "tunnel" finds "New tunnel".
  keywords?: string;
  shortcut?: string;
  // Tints the icon (a server's colour).
  color?: string | null;
  status?: "connected" | "connecting" | "failed" | null;
  // Shown in the footer: "↩ open", and the variants this row has.
  verb: string;
  variants?: Partial<Record<PaletteVariant, string>>;
  // Ranks the row when nothing is typed; higher first.
  rank?: number;
  run: (variant?: PaletteVariant) => void;
};

const GROUPS: PaletteGroup[] = ["Servers", "Actions", "Folders", "Commands"];
const PER_GROUP = 5;
const PER_GROUP_EMPTY: Record<PaletteGroup, number> = { Servers: 5, Actions: 6, Folders: 3, Commands: 4 };

const STATUS_DOT: Record<string, { cls: string; label: string }> = {
  connected: { cls: "bg-success", label: "Connected" },
  connecting: { cls: "bg-warning", label: "Connecting" },
  failed: { cls: "bg-danger", label: "Disconnected" },
};

const IS_MAC = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent);
const VARIANT_KEYS: Record<PaletteVariant, string> = { meta: IS_MAC ? "⌘↩" : "Ctrl+↩", alt: IS_MAC ? "⌥↩" : "Alt+↩" };

type Row = PaletteItem & { hits: number[] };

// The rows by group, each group cut to a few. Typed, the groups follow their
// best match, so an exact command isn't buried under loose server matches.
function rank(items: PaletteItem[], query: string): Row[] {
  const q = query.trim();
  const groups: { best: number; order: number; rows: Row[] }[] = [];
  GROUPS.forEach((group, order) => {
    const inGroup = items.filter((it) => it.group === group);
    let picked: { it: PaletteItem; score: number; hits: number[] }[];
    if (!q) {
      picked = inGroup
        .map((it, i) => ({ it, score: -(it.rank ?? 0) + i * 1e-6, hits: [] }))
        .sort((a, b) => a.score - b.score)
        .slice(0, PER_GROUP_EMPTY[group]);
    } else {
      picked = [];
      for (const it of inGroup) {
        const m = fuzzyMatch(q, it.title);
        if (m) { picked.push({ it, score: m.score, hits: m.hits }); continue; }
        // The rest only for a few typed characters, else everything matches.
        if (q.replace(/\s+/g, "").length < 3) continue;
        const extra = [it.keywords, it.sub].filter(Boolean).join(" ");
        const e = extra && fuzzyMatch(q, extra);
        if (e) picked.push({ it, score: 20 + e.score, hits: [] });
      }
      picked = picked.sort((a, b) => a.score - b.score).slice(0, PER_GROUP);
    }
    if (picked.length) groups.push({ best: q ? picked[0].score : 0, order, rows: picked.map((p) => ({ ...p.it, hits: p.hits })) });
  });
  return groups.sort((a, b) => a.best - b.best || a.order - b.order).flatMap((g) => g.rows);
}

const Kbd = ({ children }: { children: React.ReactNode }) => (
  <kbd className="font-sans text-[11px] font-medium text-zinc-500">{children}</kbd>
);

// The ⌘K palette: one search over servers, actions, folders and saved
// commands. Mounted only while open, so every opening starts empty. The
// field keeps focus; ↑ ↓ move the selection (aria-activedescendant).
export const CommandPalette = ({ items, onClose }: {
  items: PaletteItem[];
  onClose: () => void;
}) => {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const rows = useMemo(() => rank(items, query), [items, query]);
  const cur = Math.min(sel, Math.max(rows.length - 1, 0));
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const baseId = useId();
  const optionId = (i: number) => `${baseId}-opt-${i}`;

  // Esc or a click outside puts focus back where it was. The app behind is
  // inert while the palette is open, so that waits for the next frame.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const dismiss = () => {
    onClose();
    requestAnimationFrame(() => { if (opener?.isConnected) opener.focus({ preventScroll: true }); });
  };

  useEffect(() => { inputRef.current?.focus(); }, []);
  useLayoutEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${cur}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cur, rows]);

  const runRow = (row: Row | undefined, variant?: PaletteVariant) => {
    if (!row) return;
    if (variant && !row.variants?.[variant]) return;
    onClose();
    row.run(variant);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "ArrowDown" || (e.key === "n" && e.ctrlKey && IS_MAC)) {
      e.preventDefault();
      setSel(rows.length ? (cur + 1) % rows.length : 0);
    } else if (e.key === "ArrowUp" || (e.key === "p" && e.ctrlKey && IS_MAC)) {
      e.preventDefault();
      setSel(rows.length ? (cur - 1 + rows.length) % rows.length : 0);
    } else if (e.key === "PageDown" || e.key === "PageUp") {
      e.preventDefault();
      const step = e.key === "PageDown" ? 8 : -8;
      setSel(Math.min(Math.max(cur + step, 0), Math.max(rows.length - 1, 0)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const meta = IS_MAC ? e.metaKey : e.ctrlKey;
      runRow(rows[cur], meta ? "meta" : e.altKey ? "alt" : undefined);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (query) { setQuery(""); setSel(0); } else dismiss();
    }
  };

  const active = rows[cur];

  const renderOption = (row: Row, i: number) => {
    const on = i === cur;
    const Icon = row.icon;
    const dot = row.status ? STATUS_DOT[row.status] : null;
    return (
      <div
        key={row.id}
        id={optionId(i)}
        data-index={i}
        role="option"
        aria-selected={on}
        onMouseMove={() => { if (!on) setSel(i); }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => runRow(row, (IS_MAC ? e.metaKey : e.ctrlKey) ? "meta" : e.altKey ? "alt" : undefined)}
        className={`flex items-center gap-2.5 h-10 px-3 rounded-lg cursor-default ${on ? "bg-primary/[0.14]" : ""}`}
      >
        <span
          aria-hidden
          className="shrink-0 w-[26px] h-[26px] rounded-[7px] bg-white/[0.06] text-zinc-400 flex items-center justify-center"
          style={row.color ? { color: row.color } : undefined}
        >
          <Icon size={14} />
        </span>
        <span className="flex-1 min-w-0 flex items-baseline gap-2.5">
          <span className="shrink-0 max-w-[60%] truncate text-white">
            {fuzzySegments(row.title, row.hits).map((s, k) => (
              <span key={k} className={s.hit ? "text-primary font-semibold" : undefined}>{s.text}</span>
            ))}
          </span>
          {row.sub && <span className={`min-w-0 truncate text-[12px] ${on ? "text-zinc-400" : "text-zinc-500"}`}>{row.sub}</span>}
        </span>
        {dot && (
          <span className="shrink-0 flex items-center gap-1.5 text-[11.5px] text-zinc-400">
            <span className={`w-1.5 h-1.5 rounded-full ${dot.cls}`} aria-hidden />
            {dot.label}
          </span>
        )}
        {row.shortcut && <span className="chip shrink-0 text-[11px]">{row.shortcut}</span>}
        <span aria-hidden className={`shrink-0 w-3 text-[12px] text-zinc-500 ${on ? "" : "invisible"}`}>↩</span>
      </div>
    );
  };


  return (
    <div
      className="fixed inset-0 z-[60] bg-scrim flex items-start justify-center px-4 pt-[12vh]"
      onMouseDown={(e) => { if (e.target === e.currentTarget) dismiss(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-[680px] flex flex-col max-h-[76vh] bg-elevated rounded-[14px] shadow-sheet overflow-hidden text-[13px]"
      >
        <div className="shrink-0 flex items-center gap-2.5 px-4 h-[54px] border-b border-white/[0.075]">
          <Search size={18} className="shrink-0 text-zinc-500" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSel(0); }}
            onKeyDown={onKeyDown}
            role="combobox"
            aria-expanded="true"
            aria-controls={`${baseId}-list`}
            aria-activedescendant={active ? optionId(cur) : undefined}
            aria-autocomplete="list"
            aria-label="Search servers, folders, commands and actions"
            placeholder="Search servers, folders, commands and actions"
            spellCheck={false}
            autoComplete="off"
            className="flex-1 min-w-0 h-[52px] bg-transparent outline-none text-[16px] text-white placeholder:text-zinc-500"
          />
          <span className="chip text-[11px]">esc</span>
        </div>

        <div
          ref={listRef}
          id={`${baseId}-list`}
          role="listbox"
          aria-label="Results"
          className="flex-1 min-h-0 max-h-[430px] overflow-y-auto no-scrollbar px-2 pt-1.5 pb-2"
        >
          {GROUPS.filter((g) => rows.some((r) => r.group === g))
            .sort((a, b) => rows.findIndex((r) => r.group === a) - rows.findIndex((r) => r.group === b))
            .map((group) => {
            const members = rows.map((row, i) => ({ row, i })).filter((r) => r.row.group === group);
            return (
              <div key={group} role="group" aria-label={group}>
                <div role="presentation" className="px-3 pt-2.5 pb-1 text-[11.5px] font-semibold text-zinc-500">{group}</div>
                {members.map(({ row, i }) => renderOption(row, i))}
              </div>
            );
          })}
          {rows.length === 0 && (
            <div className="px-7 py-7 text-center text-zinc-400">
              No matches for “{query.trim()}”. Try a host, a folder or an action like “tunnel”.
            </div>
          )}
        </div>

        <div className="shrink-0 hidden sm:flex items-center gap-4 px-4 h-9 border-t border-white/[0.075] bg-panel text-[11.5px] text-zinc-500">
          <span><Kbd>↑</Kbd> <Kbd>↓</Kbd> to move</span>
          {active && <span><Kbd>↩</Kbd> to {active.verb}</span>}
          {active && (Object.keys(VARIANT_KEYS) as PaletteVariant[]).map((v) =>
            active.variants?.[v] ? <span key={v}><Kbd>{VARIANT_KEYS[v]}</Kbd> {active.variants[v]}</span> : null,
          )}
          <span className="flex-1" />
          <span aria-live="polite">{rows.length} {rows.length === 1 ? "result" : "results"}</span>
        </div>
      </div>
    </div>
  );
};
