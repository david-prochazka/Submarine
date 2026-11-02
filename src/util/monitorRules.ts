// Alert rules for the Monitor: a warning and an alert level per metric, held
// for some minutes before they count. Kept on this device.

export type RuleMetric = "cpu" | "mem" | "swap" | "disk" | "load";

export interface AlertRule {
  metric: RuleMetric;
  warn: number | null;
  alert: number | null;
  minutes: number;
}

export const RULE_METRICS: { metric: RuleMetric; label: string; unit: string; max?: number }[] = [
  { metric: "cpu", label: "CPU", unit: "%", max: 100 },
  { metric: "mem", label: "Memory", unit: "%", max: 100 },
  { metric: "swap", label: "Swap", unit: "%", max: 100 },
  { metric: "disk", label: "Disk /", unit: "%", max: 100 },
  { metric: "load", label: "Load (1 min)", unit: "" },
];

export const DEFAULT_RULES: AlertRule[] = [
  { metric: "cpu", warn: 80, alert: 90, minutes: 5 },
  { metric: "mem", warn: 85, alert: 95, minutes: 5 },
  { metric: "swap", warn: null, alert: null, minutes: 5 },
  { metric: "disk", warn: 85, alert: 95, minutes: 1 },
  { metric: "load", warn: null, alert: null, minutes: 5 },
];

const KEY = "submarine-monitor-rules";

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const loadRules = (): AlertRule[] => {
  let saved: unknown = null;
  try { saved = JSON.parse(localStorage.getItem(KEY) || "null"); } catch { /* storage blocked or bad JSON */ }
  const list = Array.isArray(saved) ? saved : [];
  return DEFAULT_RULES.map((d) => {
    const r = list.find((x: any) => x?.metric === d.metric);
    if (!r) return d;
    return { metric: d.metric, warn: num(r.warn), alert: num(r.alert), minutes: Math.max(0, num(r.minutes) ?? d.minutes) };
  });
};

export const saveRules = (rules: AlertRule[]) => {
  try { localStorage.setItem(KEY, JSON.stringify(rules)); } catch { /* storage blocked */ }
};

export type Level = "warn" | "alert";

/** Since when a metric has been at or over each level; null when it isn't. */
export interface Breach { warn: number | null; alert: number | null }

export const nextBreach = (prev: Breach | undefined, rule: AlertRule, v: number | undefined, ts: number): Breach => {
  if (v === undefined || !Number.isFinite(v)) return { warn: null, alert: null };
  const over = (t: number | null) => t !== null && v >= t;
  return {
    warn: over(rule.warn) ? prev?.warn ?? ts : null,
    alert: over(rule.alert) ? prev?.alert ?? ts : null,
  };
};

/** The level a breach has reached once held for the rule's minutes. */
export const levelOf = (b: Breach | undefined, rule: AlertRule, now: number): { level: Level; since: number } | null => {
  if (!b) return null;
  const held = (since: number | null) => since !== null && now - since >= rule.minutes * 60_000;
  if (held(b.alert)) return { level: "alert", since: b.alert! };
  if (held(b.warn)) return { level: "warn", since: b.warn! };
  return null;
};
