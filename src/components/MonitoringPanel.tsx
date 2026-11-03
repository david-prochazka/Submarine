import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Activity, Pause, Play, Trash2, Plus, X, AlertTriangle, AlertOctagon, CheckCircle2,
  Settings as SettingsIcon, BellRing, ShieldAlert, MoreHorizontal, TerminalSquare, SlidersHorizontal, Search, WifiOff,
} from "lucide-react";
import Sparkline from "./Sparkline";
import { SwitchRow } from "./FormRows";
import { useConfirm } from "../ui/confirm";
import { MonitorHistory, RANGES, type MonitorRange } from "../util/monitorHistory";
import {
  DEFAULT_RULES, RULE_METRICS, levelOf, loadRules, nextBreach, saveRules,
  type AlertRule, type Breach, type Level, type RuleMetric,
} from "../util/monitorRules";

// ---------- shared types ------------------------------------------------------

interface CustomMetric {
  id: string;
  name: string;
  command: string;
  parse: "number" | "regex" | "text";
  regex?: string;
  display: "sparkline" | "big_number" | "text";
  unit?: string;
}

interface MonitorRow {
  node_id: number;
  name: string;
  host: string;
  port: number;
  enabled_metrics: string[];
  custom_metrics: CustomMetric[];
  /** Custom metrics someone else added in a shared profile, not allowed on
   *  this device yet: listed but not run. */
  held_metric_ids?: string[];
  paused: boolean;
  connected: boolean;
  last_error?: string | null;
  last_sample_ts?: number | null;
  consecutive_failures?: number;
  outage_since_ms?: number | null;
}

interface Sample {
  node_id: number;
  ts: number;
  values: Record<string, number>;
  errors: Record<string, string>;
  texts: Record<string, string>;
}

interface OutageEvent {
  node_id: number;
  node_name: string;
  since_ms: number;
  consecutive_failures: number;
  last_error: string;
  notify: boolean;
  beep: boolean;
}
interface RecoveredEvent {
  node_id: number;
  node_name: string;
  since_ms: number;
  duration_ms: number;
  notify: boolean;
}

interface MonitorSettings {
  interval_secs: number;
  connect_timeout_secs: number;
  poll_timeout_secs: number;
  outage_threshold: number;
  notify_on_outage: boolean;
  beep_on_outage: boolean;
  beep_cooldown_secs: number;
}

// ---------- beep ---------------------------------------------------------------

// One shared AudioContext; the tone is synthesised, so no sound files and no
// per-platform sound API.
let sharedAudioCtx: AudioContext | null = null;
const beepNow = () => {
  try {
    if (!sharedAudioCtx) {
      const Ctor: any = (window as any).AudioContext || (window as any).webkitAudioContext;
      if (!Ctor) return;
      sharedAudioCtx = new Ctor();
    }
    const ctx = sharedAudioCtx!;
    void ctx.resume?.();
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0, t);
    gain.gain.linearRampToValueAtTime(0.18, t + 0.02);
    gain.gain.linearRampToValueAtTime(0.0, t + 0.28);
    osc.start(t);
    osc.stop(t + 0.3);
  } catch {
    // A failed beep never breaks the monitor.
  }
};

// Built-in metrics. Network is in bits per second, the unit links and plans
// are sold in.
const BUILTINS: Record<string, { label: string; is_pct: boolean; tone: string }> = {
  cpu: { label: "CPU", is_pct: true, tone: "text-primary" },
  mem: { label: "Memory", is_pct: true, tone: "text-info" },
  swap: { label: "Swap", is_pct: true, tone: "text-zinc-400" },
  disk: { label: "Disk /", is_pct: true, tone: "text-zinc-400" },
  load: { label: "Load (1 min)", is_pct: false, tone: "text-zinc-400" },
  net_in: { label: "Network in", is_pct: false, tone: "text-zinc-400" },
  net_out: { label: "Network out", is_pct: false, tone: "text-zinc-500" },
};

const TOGGLE_KEYS: { key: string; sub_keys: string[]; label: string; hint: string }[] = [
  { key: "cpu", sub_keys: ["cpu"], label: "CPU", hint: "Share of time the processors are busy" },
  { key: "mem", sub_keys: ["mem"], label: "Memory", hint: "Memory in use, not counting caches" },
  { key: "swap", sub_keys: ["swap"], label: "Swap", hint: "Swap space in use" },
  { key: "disk", sub_keys: ["disk"], label: "Disk /", hint: "Space used on the root file system" },
  { key: "load", sub_keys: ["load"], label: "Load", hint: "Load average over the last minute" },
  { key: "net", sub_keys: ["net_in", "net_out"], label: "Network", hint: "Traffic in and out, all interfaces" },
];

const RANGE_KEY = "submarine-monitor-range";

// ---------- formatters --------------------------------------------------------

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

const formatBitsPerSec = (bytesPerSec: number) => {
  if (!isFinite(bytesPerSec) || bytesPerSec < 0) return "—";
  const bits = bytesPerSec * 8;
  if (bits >= 1e9) return `${(bits / 1e9).toFixed(2)} Gbps`;
  if (bits >= 1e6) return `${(bits / 1e6).toFixed(1)} Mbps`;
  if (bits >= 1e3) return `${(bits / 1e3).toFixed(0)} Kbps`;
  return `${Math.round(bits)} bps`;
};
const formatBuiltin = (key: string, v: number | undefined) => {
  if (v === undefined || !isFinite(v)) return "—";
  if (key === "net_in" || key === "net_out") return formatBitsPerSec(v);
  if (BUILTINS[key]?.is_pct) return `${Math.round(v)}%`;
  return v.toFixed(2);
};
const formatCustomNumber = (v: number | undefined, unit?: string) => {
  if (v === undefined || !isFinite(v)) return "—";
  const num = Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3);
  return unit ? `${num} ${unit}` : num;
};
const timeAgo = (ts?: number | null) => {
  if (!ts) return null;
  const dt = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (dt < 2) return "just now";
  if (dt < 60) return `${dt} s ago`;
  if (dt < 3600) return `${Math.floor(dt / 60)} min ago`;
  return `${Math.floor(dt / 3600)} h ago`;
};
const formatDuration = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return m ? `${h} h ${m} min` : `${h} h`;
};
const randomId = () => Math.random().toString(36).slice(2, 10);

// ---------- health -------------------------------------------------------------

type Severity = "alert" | "warn" | "ok" | "waiting" | "paused";

const SEVERITY: Record<Severity, { rank: number; label: string; pill: string }> = {
  alert: { rank: 0, label: "Alert", pill: "bg-danger/[0.12] text-danger" },
  warn: { rank: 1, label: "Warning", pill: "bg-warning/[0.13] text-warning" },
  ok: { rank: 2, label: "Healthy", pill: "bg-success/[0.12] text-success" },
  waiting: { rank: 3, label: "Connecting", pill: "bg-white/[0.06] text-zinc-400" },
  paused: { rank: 4, label: "Paused", pill: "bg-white/[0.06] text-zinc-400" },
};

interface Issue { level: Level; text: string; metric?: RuleMetric }

const ruleText = (rule: AlertRule, level: Level, since: number, now: number) => {
  const meta = RULE_METRICS.find((m) => m.metric === rule.metric)!;
  const at = level === "alert" ? rule.alert : rule.warn;
  return `${meta.label} at or above ${at}${meta.unit} for ${formatDuration(now - since)}`;
};

const assess = (row: MonitorRow, breaches: Partial<Record<RuleMetric, Breach>> | undefined, rules: AlertRule[], now: number) => {
  if (row.paused) return { severity: "paused" as Severity, issues: [] as Issue[] };
  const issues: Issue[] = [];
  if (row.outage_since_ms) {
    issues.push({ level: "alert", text: `Offline for ${formatDuration(now - row.outage_since_ms)}${row.last_error ? `: ${row.last_error}` : ""}` });
  } else {
    if (row.last_error) issues.push({ level: "warn", text: `Last check failed: ${row.last_error}` });
    for (const rule of rules) {
      const hit = levelOf(breaches?.[rule.metric], rule, now);
      if (hit) issues.push({ level: hit.level, text: ruleText(rule, hit.level, hit.since, now), metric: rule.metric });
    }
  }
  issues.sort((a, b) => (a.level === b.level ? 0 : a.level === "alert" ? -1 : 1));
  const severity: Severity = issues.some((i) => i.level === "alert") ? "alert"
    : issues.length ? "warn"
    : !row.connected && !row.last_sample_ts ? "waiting"
    : "ok";
  return { severity, issues };
};

// ---------- component ---------------------------------------------------------

interface Props {
  servers: any[];
  refreshServers: () => void;
  /** Outages, recoveries and alerts also go to the activity log. */
  addLog?: (msg: string, type: "info" | "success" | "warn" | "error") => void;
  /** Opens (or switches to) a session on this server. */
  onOpenServer?: (serverId: number) => void;
  /** How many servers are in alert, for the badge on Monitor in the sidebar. */
  onAlertCount?: (n: number) => void;
}

const MonitoringPanel = ({ servers, addLog, onOpenServer, onAlertCount }: Props) => {
  const confirm = useConfirm();
  const [rows, setRows] = useState<MonitorRow[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [configFor, setConfigFor] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [menuFor, setMenuFor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [range, setRangeState] = useState<MonitorRange>(() => {
    try {
      const saved = localStorage.getItem(RANGE_KEY);
      if (saved && saved in RANGES) return saved as MonitorRange;
    } catch { /* storage blocked */ }
    return "h1";
  });
  const setRange = (r: MonitorRange) => {
    setRangeState(r);
    try { localStorage.setItem(RANGE_KEY, r); } catch { /* storage blocked */ }
  };

  const [toast, setToast] = useState<{ msg: string; tone: "warn" | "ok" | "err" } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const showToast = (msg: string, tone: "warn" | "ok" | "err") => {
    setToast({ msg, tone });
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToast(null), 4500);
  };

  const [latest, setLatest] = useState<Record<number, Sample>>({});
  const historyRef = useRef(new MonitorHistory());

  // Alert rules, and since when each server's metrics have been over them.
  // The sample listeners read these through refs: they outlive renders.
  const [rules, setRules] = useState<AlertRule[]>(loadRules);
  const rulesRef = useRef(rules);
  rulesRef.current = rules;
  const breachRef = useRef(new Map<number, Partial<Record<RuleMetric, Breach>>>());
  const levelRef = useRef(new Map<string, Level | null>());
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  // The backend only hints at a beep; the cooldown that collapses a burst of
  // outages into one tone lives here.
  const [settings, setSettings] = useState<MonitorSettings | null>(null);
  const settingsRef = useRef<MonitorSettings | null>(null);
  settingsRef.current = settings;
  const lastBeepAtRef = useRef<number>(0);
  useEffect(() => {
    invoke<MonitorSettings>("monitor_get_settings").then(setSettings).catch((e) => console.error("monitor_get_settings:", e));
  }, []);
  const tryBeep = () => {
    const s = settingsRef.current;
    if (!s || !s.beep_on_outage) return;
    const now = Date.now();
    if (now - lastBeepAtRef.current < Math.max(0, s.beep_cooldown_secs) * 1000) return;
    lastBeepAtRef.current = now;
    beepNow();
  };

  // A tick a second so durations advance between samples; stopped while the
  // window is hidden (the backend keeps checking, this is display only).
  const [, forceTick] = useState(0);
  const [winShown, setWinShown] = useState(() => typeof document === "undefined" || !document.hidden);
  useEffect(() => {
    const onVis = () => setWinShown(!document.hidden);
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, []);
  useEffect(() => {
    if (!winShown) return;
    forceTick((n) => n + 1);
    const id = window.setInterval(() => forceTick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, [winShown]);

  // ---- data load + live listeners --------------------------------------------

  const reload = async () => {
    try {
      setRows(await invoke<MonitorRow[]>("monitor_list"));
    } catch (e: any) {
      setError(String(e));
    }
  };
  useEffect(() => { reload(); /* eslint-disable-next-line */ }, []);

  const checkRules = (s: Sample) => {
    const b = { ...(breachRef.current.get(s.node_id) || {}) };
    const name = rowsRef.current.find((r) => r.node_id === s.node_id)?.name ?? "A server";
    for (const rule of rulesRef.current) {
      b[rule.metric] = nextBreach(b[rule.metric], rule, s.values[rule.metric], s.ts);
      const hit = levelOf(b[rule.metric], rule, s.ts);
      const key = `${s.node_id}:${rule.metric}`;
      const was = levelRef.current.get(key) ?? null;
      if (hit?.level === "alert" && was !== "alert") {
        const text = ruleText(rule, "alert", hit.since, s.ts);
        addLog?.(`[Monitor] ${name}: ${text}`, "error");
        if (settingsRef.current?.notify_on_outage ?? true) showToast(`${name}: ${text}`, "err");
        tryBeep();
      }
      levelRef.current.set(key, hit?.level ?? null);
    }
    breachRef.current.set(s.node_id, b);
  };

  useEffect(() => {
    // listen() hands back its unlisten through a promise: one that settles
    // after this effect was torn down is unlistened at once, not leaked.
    let cancelled = false;
    const unlistens: Array<() => void> = [];
    const track = (p: Promise<() => void>) => {
      p.then((fn) => {
        if (cancelled) fn();
        else unlistens.push(fn);
      });
    };
    rows.forEach((r) => {
      track(listen<MonitorRow>(`monitor-status-${r.node_id}`, () => reload()));
      track(listen<Sample>(`monitor-sample-${r.node_id}`, (event) => {
        const s = event.payload;
        if (!s) return;
        historyRef.current.add(s.node_id, s.ts, s.values);
        checkRules(s);
        setLatest((prev) => ({ ...prev, [s.node_id]: s }));
        setRows((prev) => prev.map((x) => (x.node_id === s.node_id ? { ...x, last_sample_ts: s.ts, connected: true } : x)));
      }));
      track(listen<OutageEvent>(`monitor-outage-${r.node_id}`, (event) => {
        const o = event.payload;
        if (!o) return;
        addLog?.(`[Monitor] ${o.node_name} is offline: ${o.last_error}`, "error");
        if (o.notify) showToast(`${o.node_name} is offline: ${o.last_error}`, "err");
        if (o.beep) tryBeep();
        reload();
      }));
      track(listen<RecoveredEvent>(`monitor-recovered-${r.node_id}`, (event) => {
        const o = event.payload;
        if (!o) return;
        addLog?.(`[Monitor] ${o.node_name} is back after ${formatDuration(o.duration_ms)}`, "success");
        if (o.notify) showToast(`${o.node_name} is back, after ${formatDuration(o.duration_ms)} offline`, "ok");
        reload();
      }));
    });
    return () => {
      cancelled = true;
      unlistens.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows.map((r) => r.node_id).join(",")]);

  // ---- mutations --------------------------------------------------------------

  const wrap = async (fn: () => Promise<any>) => {
    setBusy(true); setError(null);
    try { await fn(); await reload(); }
    catch (e: any) { setError(String(e)); }
    finally { setBusy(false); }
  };

  const forget = (nodeId: number) => {
    historyRef.current.drop(nodeId);
    breachRef.current.delete(nodeId);
    for (const k of [...levelRef.current.keys()]) if (k.startsWith(`${nodeId}:`)) levelRef.current.delete(k);
    setLatest((p) => { const { [nodeId]: _, ...rest } = p; return rest; });
  };

  const addNode = (nodeId: number) => wrap(() => invoke("monitor_add", { nodeId }));
  const removeNode = (nodeId: number) =>
    wrap(async () => {
      await invoke("monitor_remove", { nodeId });
      if (configFor === nodeId) setConfigFor(null);
      forget(nodeId);
    });
  const pauseNode = (nodeId: number) => wrap(() => invoke("monitor_pause", { nodeId }));
  const resumeNode = (nodeId: number) => wrap(() => invoke("monitor_resume", { nodeId }));
  const pauseAll = () => wrap(() => invoke("monitor_pause_all"));
  const resumeAll = () => wrap(() => invoke("monitor_resume_all"));
  const setMetrics = (nodeId: number, metrics: string[]) => wrap(() => invoke("monitor_set_metrics", { nodeId, metrics }));
  const setCustoms = (nodeId: number, customs: CustomMetric[]) => wrap(() => invoke("monitor_set_custom_metrics", { nodeId, customs }));

  const applyRules = (next: AlertRule[]) => {
    saveRules(next);
    setRules(next);
    // A new level starts its clock from the next sample.
    breachRef.current.clear();
    levelRef.current.clear();
  };

  // Focus goes back to a card's More button once its menu, or a dialog opened from it, closes.
  const refocusMore = (nodeId: number) => {
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-card-more="${nodeId}"]`)?.focus());
  };

  // A click outside a card's menu closes it.
  useEffect(() => {
    if (menuFor === null) return;
    const onDown = (e: PointerEvent) => {
      if (!(e.target as Element | null)?.closest?.("[data-card-menu]")) setMenuFor(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuFor(null);
      refocusMore(menuFor);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [menuFor]);

  // ---- derived ----------------------------------------------------------------

  const now = Date.now();
  const assessed = rows.map((row) => ({ row, ...assess(row, breachRef.current.get(row.node_id), rules, now) }));
  const sorted = [...assessed].sort((a, b) => SEVERITY[a.severity].rank - SEVERITY[b.severity].rank);
  const counts = assessed.reduce((c: Partial<Record<Severity, number>>, a) => ({ ...c, [a.severity]: (c[a.severity] ?? 0) + 1 }), {});
  const alertCount = counts.alert ?? 0;
  useEffect(() => { onAlertCount?.(alertCount); }, [alertCount, onAlertCount]);

  const availableToAdd = useMemo(
    // Only an SSH server has a shell to read numbers from.
    () => servers.filter((s: any) => (s.protocol ?? "ssh") === "ssh" && !rows.some((r) => r.node_id === s.id)),
    [servers, rows],
  );
  const anyRunning = rows.some((r) => !r.paused);
  const configRow = configFor !== null ? rows.find((r) => r.node_id === configFor) || null : null;
  const serverOf = (id: number) => servers.find((s: any) => s.id === id);

  const summary = [
    plural(rows.length, "server", "servers"),
    settings ? `checked every ${settings.interval_secs} s` : null,
    `showing the last ${RANGES[range].label}`,
  ].filter(Boolean).join(", ");

  // ---- render -----------------------------------------------------------------

  return (
    <div className="flex flex-col h-full bg-surface relative">
      <header className="h-[52px] shrink-0 flex items-center gap-2 pl-4 pr-3 border-b border-white/[0.075]">
        <span className="flex-1 min-w-0 h-6 flex items-center font-semibold text-white truncate">Monitor</span>
        {rows.length > 0 && (
          <div role="group" aria-label="Time range" className="seg">
            {(Object.keys(RANGES) as MonitorRange[]).map((r) => (
              <button key={r} type="button" onClick={() => setRange(r)} aria-pressed={range === r} className="seg-item">
                {RANGES[r].short}
              </button>
            ))}
          </div>
        )}
        <button type="button" onClick={() => setRulesOpen(true)} aria-label="Alert rules" className="btn">
          <BellRing size={14} aria-hidden /><span className="hidden md:inline">Alert rules</span>
        </button>
        <button type="button" onClick={() => setSettingsOpen(true)} aria-label="Monitor settings" title="Monitor settings" className="icon-btn">
          <SettingsIcon size={16} aria-hidden />
        </button>
        <button type="button" onClick={() => setAddOpen(true)} aria-label="Add server" className="btn btn-primary">
          <Plus size={14} aria-hidden /><span className="hidden md:inline">Add server</span>
        </button>
      </header>

      <div className="flex-1 overflow-y-auto custom-scrollbar px-4 pt-5 pb-8 sm:px-8 sm:pt-7 sm:pb-10">
        {error && (
          <div role="alert" className="mb-5 flex items-start gap-2 rounded-lg bg-danger/[0.12] px-3 py-2 text-[12.5px] text-white">
            <AlertTriangle size={15} aria-hidden className="text-danger shrink-0 mt-px" />
            <span className="flex-1 min-w-0 break-words">{error}</span>
            <button type="button" onClick={() => setError(null)} aria-label="Dismiss" className="icon-btn -my-1 w-6 h-6"><X size={13} /></button>
          </div>
        )}

        {rows.length === 0 ? (
          <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-4">
            <span aria-hidden className="w-12 h-12 rounded-xl flex items-center justify-center bg-primary/[0.12] text-primary">
              <Activity size={22} />
            </span>
            <h1 className="mt-4 text-[17px] font-semibold text-white">No servers monitored yet</h1>
            <p className="mt-1 max-w-[380px] text-zinc-400">
              Pick SSH servers to keep an eye on their CPU, memory, disk and network. Checks keep running while you work elsewhere in the app.
            </p>
            <button type="button" onClick={() => setAddOpen(true)} className="btn btn-primary mt-5">
              <Plus size={14} aria-hidden /> Add server
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-4 mb-5">
              <div className="min-w-0">
                <h1 className="text-[22px] leading-7 font-semibold tracking-[-0.01em] text-white">Monitor</h1>
                <p className="mt-0.5 text-zinc-400">{summary}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {(["alert", "warn", "ok", "paused"] as Severity[]).map((sev) => counts[sev] ? (
                  <span key={sev} className={`pill h-6 px-2.5 ${SEVERITY[sev].pill}`}>
                    {sev === "alert" ? plural(counts[sev]!, "alert", "alerts")
                      : sev === "warn" ? plural(counts[sev]!, "warning", "warnings")
                      : sev === "ok" ? `${counts[sev]} healthy`
                      : `${counts[sev]} paused`}
                  </span>
                ) : null)}
                {anyRunning ? (
                  <button type="button" onClick={pauseAll} disabled={busy} className="btn btn-ghost">
                    <Pause size={13} aria-hidden /> Pause all
                  </button>
                ) : (
                  <button type="button" onClick={resumeAll} disabled={busy} className="btn btn-ghost">
                    <Play size={13} aria-hidden /> Start all
                  </button>
                )}
              </div>
            </div>

            <div className="grid gap-4 grid-cols-1 md:grid-cols-2 xl:grid-cols-3 min-[1800px]:grid-cols-4">
              {sorted.map(({ row, severity, issues }) => {
                const server = serverOf(row.node_id);
                return (
                  <ServerCard
                    key={row.node_id}
                    row={row}
                    color={server?.color || null}
                    severity={severity}
                    issues={issues}
                    sample={latest[row.node_id]}
                    trend={(key) => historyRef.current.series(row.node_id, key, range, now)}
                    rangeLabel={RANGES[range].label}
                    busy={busy}
                    menuOpen={menuFor === row.node_id}
                    onMenu={(open) => setMenuFor(open ? row.node_id : null)}
                    onPause={() => { pauseNode(row.node_id); refocusMore(row.node_id); }}
                    onResume={() => { resumeNode(row.node_id); refocusMore(row.node_id); }}
                    onConfig={() => { setMenuFor(null); setConfigFor(row.node_id); }}
                    onOpen={onOpenServer && server ? () => { setMenuFor(null); onOpenServer(row.node_id); } : undefined}
                    onRemove={async () => {
                      setMenuFor(null);
                      if (!(await confirm({ title: `Stop monitoring ${row.name}?`, message: "Its custom commands are removed with it.", destructive: true }))) {
                        refocusMore(row.node_id);
                        return;
                      }
                      removeNode(row.node_id);
                    }}
                  />
                );
              })}
            </div>
            <p className="mt-5 text-[12px] text-zinc-500">
              History starts when the app does. Alerts also show as a badge on Monitor in the sidebar.
            </p>
          </>
        )}
      </div>

      {toast && (
        <div className="fixed bottom-5 right-6 z-[60] pointer-events-none" role="status">
          <div className="max-w-[420px] flex items-start gap-2.5 px-3.5 py-2.5 rounded-lg bg-elevated shadow-pop text-[12.5px] text-white">
            {toast.tone === "err" ? <AlertOctagon size={15} aria-hidden className="mt-px shrink-0 text-danger" />
              : toast.tone === "ok" ? <CheckCircle2 size={15} aria-hidden className="mt-px shrink-0 text-success" />
              : <AlertTriangle size={15} aria-hidden className="mt-px shrink-0 text-warning" />}
            <span>{toast.msg}</span>
          </div>
        </div>
      )}

      {configRow && (
        <MetricsDialog
          row={configRow}
          busy={busy}
          onClose={() => { setConfigFor(null); refocusMore(configRow.node_id); }}
          onSetMetrics={(m) => setMetrics(configRow.node_id, m)}
          onSetCustoms={(c) => setCustoms(configRow.node_id, c)}
        />
      )}
      {addOpen && <AddDialog servers={availableToAdd} busy={busy} onAdd={addNode} onClose={() => setAddOpen(false)} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} onSaved={setSettings} />}
      {rulesOpen && <RulesDialog rules={rules} onSave={(r) => { applyRules(r); setRulesOpen(false); }} onClose={() => setRulesOpen(false)} />}
    </div>
  );
};

// ---------- ServerCard --------------------------------------------------------

interface ServerCardProps {
  row: MonitorRow;
  color: string | null;
  severity: Severity;
  issues: Issue[];
  sample?: Sample;
  trend: (key: string) => (number | null)[];
  rangeLabel: string;
  busy: boolean;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  onPause: () => void;
  onResume: () => void;
  onConfig: () => void;
  onOpen?: () => void;
  onRemove: () => void;
}

const ServerCard = ({
  row, color, severity, issues, sample, trend, rangeLabel, busy, menuOpen, onMenu, onPause, onResume, onConfig, onOpen, onRemove,
}: ServerCardProps) => {
  const sev = SEVERITY[severity];
  const ring = severity === "alert" ? "shadow-[0_0_0_1px_rgb(var(--danger))]" : severity === "warn" ? "shadow-[0_0_0_1px_rgb(var(--warning))]" : "";
  const ruleLevel = (key: string) => issues.find((i) => i.metric === key)?.level;
  const builtinKeys = TOGGLE_KEYS.filter((tk) => row.enabled_metrics.includes(tk.key)).flatMap((tk) => tk.sub_keys);
  const ago = timeAgo(row.last_sample_ts);
  const held = row.held_metric_ids?.length ?? 0;
  const PillIcon = severity === "alert" ? AlertOctagon : severity === "warn" ? AlertTriangle : severity === "paused" ? Pause : null;

  return (
    <article aria-label={`${row.name}, ${sev.label.toLowerCase()}`} className={`tile p-4 flex flex-col ${ring}`}>
      <div className="flex items-center gap-2.5">
        <span aria-hidden className="w-2 h-2 rounded-full shrink-0 bg-zinc-500" style={color ? { background: color } : undefined} />
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-white truncate">{row.name}</h3>
          <div className="text-[11.5px] text-zinc-500 truncate">
            <span className="font-mono">{row.host}{row.port !== 22 ? `:${row.port}` : ""}</span>
            {ago && !row.paused && <span> · {ago}</span>}
          </div>
        </div>
        <span className={`pill ${sev.pill}`}>
          {PillIcon ? <PillIcon size={12} aria-hidden />
            : <span aria-hidden className={`w-1.5 h-1.5 rounded-full ${severity === "ok" ? "bg-success" : "bg-zinc-500 animate-pulse motion-reduce:animate-none"}`} />}
          {sev.label}
        </span>
        <div data-card-menu className="relative -mr-1.5">
          <button
            type="button"
            onClick={() => onMenu(!menuOpen)}
            aria-label={`More for ${row.name}`}
            data-card-more={row.node_id}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className="icon-btn w-6 h-6"
          >
            <MoreHorizontal size={14} aria-hidden />
          </button>
          {menuOpen && (
            <div role="menu" className="absolute right-0 top-full mt-1 z-30 min-w-[180px] p-1 rounded-lg bg-elevated shadow-pop">
              {onOpen && <MenuItem icon={TerminalSquare} label="Open terminal" onClick={onOpen} />}
              {row.paused
                ? <MenuItem icon={Play} label="Start checking" onClick={() => { onMenu(false); onResume(); }} disabled={busy} />
                : <MenuItem icon={Pause} label="Pause checking" onClick={() => { onMenu(false); onPause(); }} disabled={busy} />}
              <MenuItem icon={SlidersHorizontal} label="Metrics…" onClick={onConfig} />
              <div className="my-1 h-px bg-white/[0.075]" />
              <MenuItem icon={Trash2} label="Stop monitoring" onClick={onRemove} disabled={busy} danger />
            </div>
          )}
        </div>
      </div>

      {row.paused ? (
        <div className="mt-3.5 flex items-center gap-2 rounded-lg bg-white/[0.04] px-2.5 py-2 text-[12px] text-zinc-400">
          <span className="flex-1">Not checking this server.</span>
          <button type="button" onClick={onResume} disabled={busy} className="btn btn-sm">
            <Play size={12} aria-hidden /> Start
          </button>
        </div>
      ) : !sample && row.outage_since_ms ? null : builtinKeys.length + row.custom_metrics.length === 0 ? (
        <div className="mt-3.5 flex items-center gap-2 rounded-lg bg-white/[0.04] px-2.5 py-2 text-[12px] text-zinc-400">
          <span className="flex-1">No metrics picked.</span>
          <button type="button" onClick={onConfig} className="btn btn-sm">Pick metrics</button>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-x-[18px] gap-y-3.5 mt-3.5">
          {builtinKeys.map((key) => {
            const meta = BUILTINS[key];
            const value = sample?.values?.[key];
            const level = ruleLevel(key);
            const tone = level === "alert" ? "text-danger" : level === "warn" ? "text-warning" : meta.tone;
            return (
              <div key={key} className="min-w-0">
                <div className="flex justify-between items-baseline gap-2 text-[11.5px]">
                  <span className="text-zinc-500 truncate">{meta.label}</span>
                  <span className="text-[13px] font-semibold tabular-nums text-white whitespace-nowrap">{formatBuiltin(key, value)}</span>
                </div>
                <Sparkline
                  data={trend(key)}
                  min={0}
                  max={meta.is_pct ? 100 : undefined}
                  className={`mt-1 ${tone}`}
                  label={`${meta.label} over the last ${rangeLabel}, now ${formatBuiltin(key, value)}`}
                />
              </div>
            );
          })}
          {row.custom_metrics.map((cm) => {
            const err = sample?.errors?.[cm.id];
            const isText = cm.parse === "text";
            const value = sample?.values?.[cm.id];
            const shown = isText ? sample?.texts?.[cm.id] || "—" : formatCustomNumber(value, cm.unit);
            return (
              <div key={cm.id} className={`min-w-0 ${isText ? "col-span-2" : ""}`}>
                <div className="flex justify-between items-baseline gap-2 text-[11.5px]">
                  <span className="text-zinc-500 truncate" title={cm.command}>{cm.name}</span>
                  {err ? (
                    <span className="text-[12px] font-medium text-danger truncate" title={err}>Failed</span>
                  ) : (
                    <span className={`${isText ? "font-mono text-[12px] font-normal" : "text-[13px] font-semibold tabular-nums"} text-white truncate`} title={shown}>{shown}</span>
                  )}
                </div>
                {!isText && cm.display === "sparkline" && (
                  <Sparkline data={trend(cm.id)} min={Math.min(0, value ?? 0)} className="mt-1 text-zinc-400" label={`${cm.name} over the last ${rangeLabel}, now ${shown}`} />
                )}
              </div>
            );
          })}
        </div>
      )}

      {issues.map((issue, i) => (
        <div
          key={i}
          className={`mt-3.5 flex items-center gap-2 rounded-lg px-2.5 py-2 text-[12px] text-white ${issue.level === "alert" ? "bg-danger/[0.12]" : "bg-warning/[0.13]"}`}
        >
          <span aria-hidden className={`shrink-0 ${issue.level === "alert" ? "text-danger" : "text-warning"}`}>
            {row.outage_since_ms ? <WifiOff size={14} /> : issue.level === "alert" ? <AlertOctagon size={14} /> : <AlertTriangle size={14} />}
          </span>
          <span className="flex-1 min-w-0 break-words">{issue.text}</span>
          {i === 0 && onOpen && <button type="button" onClick={onOpen} className="btn btn-sm shrink-0">Open terminal</button>}
        </div>
      ))}
      {held > 0 && (
        <div className="mt-3.5 flex items-center gap-2 rounded-lg bg-warning/[0.13] px-2.5 py-2 text-[12px] text-white">
          <ShieldAlert size={14} aria-hidden className="text-warning shrink-0" />
          <span className="flex-1 min-w-0">
            {held === 1 ? "A custom command is" : `${held} custom commands are`} waiting for your OK in Servers.
          </span>
        </div>
      )}

    </article>
  );
};

const MenuItem = ({ icon: Icon, label, onClick, disabled, danger }: {
  icon: typeof Play; label: string; onClick: () => void; disabled?: boolean; danger?: boolean;
}) => (
  <button
    type="button"
    role="menuitem"
    onClick={onClick}
    disabled={disabled}
    className={`w-full flex items-center gap-2 h-7 px-2 rounded-md text-left disabled:opacity-40 ${danger ? "text-danger hover:bg-danger/10" : "text-white hover:bg-white/[0.09]"}`}
  >
    <Icon size={13} aria-hidden className={danger ? "" : "text-zinc-400"} /> {label}
  </button>
);

// ---------- dialogs -----------------------------------------------------------

const Dialog = ({ title, sub, onClose, footer, children, width = "max-w-[480px]" }: {
  title: string; sub?: ReactNode; onClose: () => void; footer?: ReactNode; children: ReactNode; width?: string;
}) => {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const had = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    return () => { if (had?.isConnected) had.focus({ preventScroll: true }); };
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-[60] bg-scrim flex items-center justify-center p-4" onClick={onClose}>
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") { e.stopPropagation(); onClose(); }
        }}
        className={`w-full ${width} max-h-[85vh] flex flex-col bg-elevated rounded-xl shadow-sheet text-[13px] outline-none animate-in zoom-in-95 fade-in duration-150`}
      >
        <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3">
          <div className="min-w-0">
            <h2 id={id} className="text-[15px] font-semibold text-white">{title}</h2>
            {sub && <p className="mt-0.5 text-[12px] text-zinc-400 truncate">{sub}</p>}
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="icon-btn -mr-1 -mt-0.5"><X size={14} /></button>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-4 pb-4">{children}</div>
        {footer && <div className="shrink-0 flex items-center justify-end gap-2 px-4 py-3 border-t border-white/[0.075]">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
};

const Group = ({ children }: { children: ReactNode }) => (
  <div className="rounded-[10px] bg-panel shadow-[0_0_0_0.5px_var(--border)] divide-y divide-white/[0.075]">{children}</div>
);

const AddDialog = ({ servers, busy, onAdd, onClose }: {
  servers: any[]; busy: boolean; onAdd: (id: number) => Promise<void>; onClose: () => void;
}) => {
  const [filter, setFilter] = useState("");
  const [added, setAdded] = useState<string[]>([]);
  const q = filter.trim().toLowerCase();
  const shown = q ? servers.filter((s) => `${s.name} ${s.host}`.toLowerCase().includes(q)) : servers;
  return (
    <Dialog
      title="Add servers to Monitor"
      sub="SSH servers only: they have a shell to read the numbers from."
      onClose={onClose}
      footer={<>
        <p className="flex-1 text-[11.5px] text-zinc-500 leading-[15px]">A server added here starts paused. Press Start on its card to begin checking.</p>
        <button type="button" onClick={onClose} className="btn">Done</button>
      </>}
    >
      {servers.length > 6 && (
        <label className="relative block mb-2">
          <Search size={14} aria-hidden className="absolute left-[9px] top-1/2 -translate-y-1/2 text-zinc-500" />
          <input type="search" autoFocus value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name or host" aria-label="Filter servers" className="field pl-7" />
        </label>
      )}
      {added.length > 0 && <p className="mb-2 text-[12px] text-success" role="status">Added {added.join(", ")}.</p>}
      {servers.length === 0 ? (
        <p className="py-6 text-center text-zinc-400">Every SSH server is already monitored.</p>
      ) : shown.length === 0 ? (
        <p className="py-6 text-center text-zinc-400">No servers match.</p>
      ) : (
        <ul className="-mx-1">
          {shown.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                onClick={async () => { await onAdd(s.id); setAdded((a) => [...a, s.name]); }}
                disabled={busy}
                className="group w-full flex items-center gap-2.5 h-11 px-2 rounded-lg text-left hover:bg-white/[0.06] disabled:opacity-50"
              >
                <span aria-hidden className="w-2 h-2 rounded-full shrink-0 bg-zinc-500" style={s.color ? { background: s.color } : undefined} />
                <span className="flex-1 min-w-0">
                  <span className="block font-medium text-white truncate">{s.name}</span>
                  <span className="block font-mono text-[11.5px] text-zinc-500 truncate">{s.host}{s.port !== 22 ? `:${s.port}` : ""}</span>
                </span>
                <span className="flex items-center gap-1 text-[12px] font-medium text-primary"><Plus size={13} aria-hidden /> Add</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
};

const NumberRow = ({ label, hint, value, min, max, suffix, onChange }: {
  label: string; hint: string; value: number; min: number; max: number; suffix: string; onChange: (v: number) => void;
}) => {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3 px-3.5 py-2.5">
      <div className="min-w-0">
        <label htmlFor={id} className="font-medium text-white">{label}</label>
        <div className="text-[11.5px] text-zinc-500 leading-[15px]">{hint}</div>
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(e) => {
            const v = parseInt(e.target.value);
            if (!isNaN(v)) onChange(Math.max(min, Math.min(max, v)));
          }}
          className="field w-[68px] text-right tabular-nums"
        />
        <span className="w-12 text-[12px] text-zinc-500">{suffix}</span>
      </div>
    </div>
  );
};

const SettingsDialog = ({ onClose, onSaved }: { onClose: () => void; onSaved: (s: MonitorSettings) => void }) => {
  const [s, setS] = useState<MonitorSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    invoke<MonitorSettings>("monitor_get_settings").then(setS).catch((e) => setErr(String(e)));
  }, []);

  const save = async () => {
    if (!s) return;
    setSaving(true); setErr(null);
    try {
      onSaved(await invoke<MonitorSettings>("monitor_set_settings", { newSettings: s }));
      onClose();
    } catch (e: any) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      title="Monitor settings"
      onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} className="btn">Cancel</button>
        <button type="button" onClick={save} disabled={!s || saving} className="btn btn-primary">{saving ? "Saving…" : "Save"}</button>
      </>}
    >
      {!s ? (
        <p className="py-6 text-center text-zinc-400">{err ?? "Loading…"}</p>
      ) : (
        <div className="space-y-4">
          <Group>
            <NumberRow label="Check every" hint="Time between checks of each server. Applies from the next check." value={s.interval_secs} min={1} max={600} suffix="seconds" onChange={(v) => setS({ ...s, interval_secs: v })} />
            <NumberRow label="Connect timeout" hint="How long to wait for the connection and SSH handshake." value={s.connect_timeout_secs} min={2} max={120} suffix="seconds" onChange={(v) => setS({ ...s, connect_timeout_secs: v })} />
            <NumberRow label="Check timeout" hint="How long to wait for the numbers on each check." value={s.poll_timeout_secs} min={2} max={120} suffix="seconds" onChange={(v) => setS({ ...s, poll_timeout_secs: v })} />
            <NumberRow label="Offline after" hint="Failed checks in a row before a server counts as offline." value={s.outage_threshold} min={1} max={100} suffix="checks" onChange={(v) => setS({ ...s, outage_threshold: v })} />
          </Group>
          <Group>
            <div className="px-3.5 py-2.5">
              <SwitchRow
                label="Pop-up for outages and alerts"
                hint="Shows when a server goes offline, comes back or crosses an alert rule. Each is logged either way."
                checked={s.notify_on_outage}
                onChange={(v) => setS({ ...s, notify_on_outage: v })}
              />
            </div>
            <div className="px-3.5 py-2.5">
              <SwitchRow
                label="Sound for outages and alerts"
                hint={<>A short tone, at most once per cooldown. <button type="button" onClick={beepNow} className="text-primary hover:underline">Play it</button></>}
                checked={s.beep_on_outage}
                onChange={(v) => setS({ ...s, beep_on_outage: v })}
              />
            </div>
            <NumberRow label="Sound cooldown" hint="Outages within this time of the last sound stay quiet." value={s.beep_cooldown_secs} min={0} max={600} suffix="seconds" onChange={(v) => setS({ ...s, beep_cooldown_secs: v })} />
          </Group>
          {err && <p role="alert" className="text-[12px] text-danger">{err}</p>}
        </div>
      )}
    </Dialog>
  );
};

const RulesDialog = ({ rules, onSave, onClose }: { rules: AlertRule[]; onSave: (r: AlertRule[]) => void; onClose: () => void }) => {
  const [draft, setDraft] = useState(rules);
  const set = (metric: RuleMetric, patch: Partial<AlertRule>) =>
    setDraft((d) => d.map((r) => (r.metric === metric ? { ...r, ...patch } : r)));
  const parse = (v: string) => (v.trim() === "" || isNaN(Number(v)) ? null : Number(v));

  return (
    <Dialog
      title="Alert rules"
      sub="Kept on this device. Leave a level empty to turn it off."
      width="max-w-[560px]"
      onClose={onClose}
      footer={<>
        <button type="button" onClick={() => setDraft(DEFAULT_RULES)} className="btn btn-ghost mr-auto">Reset to defaults</button>
        <button type="button" onClick={onClose} className="btn">Cancel</button>
        <button type="button" onClick={() => onSave(draft)} className="btn btn-primary">Save</button>
      </>}
    >
      <div className="rounded-[10px] bg-panel shadow-[0_0_0_0.5px_var(--border)] overflow-x-auto">
        <table className="w-full min-w-[440px] border-collapse">
          <thead>
            <tr className="text-left text-[11.5px] text-zinc-500">
              <th scope="col" className="font-medium px-3.5 pt-2.5 pb-1.5">Metric</th>
              <th scope="col" className="font-medium px-2 pt-2.5 pb-1.5"><span className="inline-flex items-center gap-1.5"><span aria-hidden className="w-1.5 h-1.5 rounded-full bg-warning" />Warning at</span></th>
              <th scope="col" className="font-medium px-2 pt-2.5 pb-1.5"><span className="inline-flex items-center gap-1.5"><span aria-hidden className="w-1.5 h-1.5 rounded-full bg-danger" />Alert at</span></th>
              <th scope="col" className="font-medium px-3.5 pt-2.5 pb-1.5">For at least</th>
            </tr>
          </thead>
          <tbody>
            {draft.map((r) => {
              const meta = RULE_METRICS.find((m) => m.metric === r.metric)!;
              const backwards = r.warn !== null && r.alert !== null && r.alert < r.warn;
              const level = (key: "warn" | "alert", label: string) => (
                <td className="px-2 py-1.5">
                  <span className="flex items-center gap-1">
                    <input
                      type="number"
                      min={0}
                      max={meta.max}
                      step={r.metric === "load" ? 0.5 : 1}
                      value={r[key] ?? ""}
                      placeholder="Off"
                      onChange={(e) => set(r.metric, { [key]: parse(e.target.value) })}
                      aria-label={`${meta.label}, ${label}`}
                      aria-invalid={backwards || undefined}
                      className={`field w-[64px] text-right tabular-nums ${backwards ? "border-danger" : ""}`}
                    />
                    <span className="w-3 text-[12px] text-zinc-500">{meta.unit}</span>
                  </span>
                </td>
              );
              return (
                <tr key={r.metric} className="border-t border-white/[0.075]">
                  <th scope="row" className="px-3.5 py-1.5 text-left font-medium text-white whitespace-nowrap">{meta.label}</th>
                  {level("warn", "warning at")}
                  {level("alert", "alert at")}
                  <td className="px-3.5 py-1.5">
                    <span className="flex items-center gap-1.5">
                      <input
                        type="number"
                        min={0}
                        max={120}
                        value={r.minutes}
                        onChange={(e) => set(r.metric, { minutes: Math.max(0, Math.min(120, parseInt(e.target.value) || 0)) })}
                        aria-label={`${meta.label}, minutes`}
                        className="field w-[56px] text-right tabular-nums"
                      />
                      <span className="text-[12px] text-zinc-500">min</span>
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11.5px] text-zinc-500 leading-[15px]">
        A level counts once a server has stayed at or above it for the minutes given, so a short spike doesn't raise an alert. Alerts show on the card, in the activity log and as a badge on Monitor; offline servers always raise one.
      </p>
      {draft.some((r) => r.warn !== null && r.alert !== null && r.alert < r.warn) && (
        <p role="alert" className="mt-2 text-[12px] text-danger">An alert level is below its warning level: the alert would show first.</p>
      )}
    </Dialog>
  );
};

const MetricsDialog = ({ row, busy, onClose, onSetMetrics, onSetCustoms }: {
  row: MonitorRow;
  busy: boolean;
  onClose: () => void;
  onSetMetrics: (m: string[]) => void;
  onSetCustoms: (c: CustomMetric[]) => void;
}) => {
  const [draft, setDraft] = useState<CustomMetric[]>(row.custom_metrics);
  useEffect(() => {
    setDraft(row.custom_metrics);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row.node_id]);

  const toggleBuiltin = (key: string, on: boolean) =>
    onSetMetrics(on ? [...row.enabled_metrics, key] : row.enabled_metrics.filter((k) => k !== key));
  const update = (idx: number, patch: Partial<CustomMetric>) => setDraft((prev) => prev.map((c, i) => (i === idx ? { ...c, ...patch } : c)));
  const dirty = JSON.stringify(draft) !== JSON.stringify(row.custom_metrics);

  return (
    <Dialog
      title="Metrics"
      sub={<>{row.name} · <span className="font-mono">{row.host}{row.port !== 22 ? `:${row.port}` : ""}</span></>}
      width="max-w-[540px]"
      onClose={onClose}
      footer={<>
        <button type="button" onClick={onClose} className="btn">{dirty ? "Cancel" : "Done"}</button>
        {dirty && <button type="button" onClick={async () => { onSetCustoms(draft); onClose(); }} disabled={busy} className="btn btn-primary">Save commands</button>}
      </>}
    >
      <h3 className="mb-1.5 text-[11px] font-semibold text-zinc-500">Built in</h3>
      <Group>
        {TOGGLE_KEYS.map(({ key, label, hint }) => (
          <div key={key} className="px-3.5 py-2.5">
            <SwitchRow label={label} hint={hint} checked={row.enabled_metrics.includes(key)} onChange={(on) => !busy && toggleBuiltin(key, on)} />
          </div>
        ))}
      </Group>

      <div className="flex items-center justify-between mt-5 mb-1.5">
        <h3 className="text-[11px] font-semibold text-zinc-500">Custom commands</h3>
        <button
          type="button"
          onClick={() => setDraft((prev) => [...prev, { id: randomId(), name: "New metric", command: "", parse: "number", display: "sparkline" }])}
          className="btn btn-sm"
        >
          <Plus size={12} aria-hidden /> Add command
        </button>
      </div>
      {draft.length === 0 ? (
        <p className="rounded-[10px] border border-dashed border-white/[0.14] py-5 text-center text-[12px] text-zinc-400">
          Run your own command on each check, such as <span className="font-mono text-white">ps -e | wc -l</span>, and chart what it prints.
        </p>
      ) : (
        <div className="space-y-3">
          {draft.map((cm, idx) => (
            <div key={cm.id} className="rounded-[10px] bg-panel shadow-[0_0_0_0.5px_var(--border)] p-3 space-y-2.5">
              <div className="flex items-center gap-2">
                <input value={cm.name} onChange={(e) => update(idx, { name: e.target.value })} placeholder="Name" aria-label="Name" className="field flex-1 font-medium" />
                <button type="button" onClick={() => setDraft((prev) => prev.filter((_, i) => i !== idx))} aria-label={`Remove ${cm.name}`} title="Remove" className="icon-btn hover:text-danger">
                  <Trash2 size={14} aria-hidden />
                </button>
              </div>
              <textarea
                value={cm.command}
                onChange={(e) => update(idx, { command: e.target.value })}
                placeholder="Shell command, e.g. ps -e | wc -l"
                aria-label="Command"
                rows={2}
                className="field h-auto py-1.5 font-mono text-[12px] resize-y"
              />
              <div className="grid grid-cols-3 gap-2">
                <label className="space-y-1">
                  <span className="block text-[11.5px] text-zinc-500">Read</span>
                  <select value={cm.parse} onChange={(e) => update(idx, { parse: e.target.value as CustomMetric["parse"] })} className="field">
                    <option value="number">First number</option>
                    <option value="regex">Regex match</option>
                    <option value="text">Text as is</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="block text-[11.5px] text-zinc-500">Show as</span>
                  <select value={cm.display} onChange={(e) => update(idx, { display: e.target.value as CustomMetric["display"] })} disabled={cm.parse === "text"} className="field disabled:opacity-50">
                    <option value="sparkline">Trend</option>
                    <option value="big_number">Number</option>
                  </select>
                </label>
                <label className="space-y-1">
                  <span className="block text-[11.5px] text-zinc-500">Unit</span>
                  <input value={cm.unit || ""} onChange={(e) => update(idx, { unit: e.target.value })} placeholder="ms" className="field" />
                </label>
              </div>
              {cm.parse === "regex" && (
                <input
                  value={cm.regex || ""}
                  onChange={(e) => update(idx, { regex: e.target.value })}
                  placeholder="One capture group, e.g. load average:\s*([0-9.]+)"
                  aria-label="Regex"
                  className="field font-mono text-[12px]"
                />
              )}
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 text-[11.5px] text-zinc-500 leading-[15px]">
        Commands run in the server's shell on every check. A regex takes its first group as the number; text is shown as printed, without a trend.
      </p>
    </Dialog>
  );
};

export default MonitoringPanel;
