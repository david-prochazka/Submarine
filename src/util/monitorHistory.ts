// What the Monitor has seen since the app started, per server and metric, for
// the 15 minute, hour and 24 hour views. Every sample is kept for an hour;
// past that only minute averages, so a day of 5 s samples stays small.

export type MonitorRange = "m15" | "h1" | "h24";

export const RANGES: Record<MonitorRange, { ms: number; label: string; short: string }> = {
  m15: { ms: 15 * 60_000, label: "15 minutes", short: "15 min" },
  h1: { ms: 60 * 60_000, label: "hour", short: "1 hour" },
  h24: { ms: 24 * 60 * 60_000, label: "24 hours", short: "24 hours" },
};

const RAW_KEEP = 60 * 60_000;
const DAY = 24 * 60 * 60_000;
const MINUTE = 60_000;

interface Series {
  raw: { t: number; v: number }[];
  minutes: { t: number; sum: number; n: number }[];
}

const dropBefore = <T extends { t: number }>(list: T[], cutoff: number) => {
  let i = 0;
  while (i < list.length && list[i].t < cutoff) i++;
  if (i > 0) list.splice(0, i);
};

export class MonitorHistory {
  private nodes = new Map<number, Map<string, Series>>();

  add(nodeId: number, ts: number, values: Record<string, number>) {
    let node = this.nodes.get(nodeId);
    if (!node) this.nodes.set(nodeId, (node = new Map()));
    for (const [key, v] of Object.entries(values)) {
      if (!Number.isFinite(v)) continue;
      let s = node.get(key);
      if (!s) node.set(key, (s = { raw: [], minutes: [] }));
      s.raw.push({ t: ts, v });
      dropBefore(s.raw, ts - RAW_KEEP);
      const t = Math.floor(ts / MINUTE) * MINUTE;
      const last = s.minutes[s.minutes.length - 1];
      if (last && last.t === t) { last.sum += v; last.n++; }
      else s.minutes.push({ t, sum: v, n: 1 });
      dropBefore(s.minutes, ts - DAY);
    }
  }

  drop(nodeId: number) {
    this.nodes.delete(nodeId);
  }

  /** The range in `bins` equal steps ending now, each the average of what fell
   *  in it, or null where nothing did (paused, offline, before the app ran). */
  series(nodeId: number, key: string, range: MonitorRange, now: number, bins = 60): (number | null)[] {
    const s = this.nodes.get(nodeId)?.get(key);
    const out: (number | null)[] = new Array(bins).fill(null);
    if (!s) return out;
    const span = RANGES[range].ms;
    const start = now - span;
    const width = span / bins;
    const sum = new Array(bins).fill(0);
    const n = new Array(bins).fill(0);
    const put = (t: number, v: number, count: number) => {
      const i = Math.floor((t - start) / width);
      if (i < 0 || i >= bins) return;
      sum[i] += v * count;
      n[i] += count;
    };
    if (span <= RAW_KEEP) {
      for (const p of s.raw) put(p.t, p.v, 1);
    } else {
      for (const m of s.minutes) put(m.t + MINUTE / 2, m.sum / m.n, m.n);
    }
    for (let i = 0; i < bins; i++) if (n[i] > 0) out[i] = sum[i] / n[i];
    return out;
  }
}
