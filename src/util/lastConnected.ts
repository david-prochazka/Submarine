// When each server was last opened on this device. Kept per device in
// localStorage, not synced: it says what this device did, and it changes on
// every connect, which would otherwise make a sync of the whole profile.

const KEY = "submarine-last-connected";

export type LastConnected = Record<number, number>;

export function readLastConnected(): LastConnected {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "{}");
    if (!raw || typeof raw !== "object") return {};
    const out: LastConnected = {};
    for (const [id, at] of Object.entries(raw)) {
      if (Number.isFinite(Number(id)) && typeof at === "number" && Number.isFinite(at)) out[Number(id)] = at;
    }
    return out;
  } catch {
    return {};
  }
}

export function recordConnected(prev: LastConnected, serverId: number, at = Date.now()): LastConnected {
  const next = { ...prev, [serverId]: at };
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage blocked: kept for this run only */ }
  return next;
}

const clock = (d: Date) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/** "Just now", "2 min ago", "3 h ago", "Yesterday, 18:40", "4 days ago", "12 Mar 2026". */
export function sinceLabel(at: number | undefined, now = Date.now()): string | null {
  if (!at) return null;
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return "Just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  const then = new Date(at);
  const today = new Date(now);
  const dayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (at >= dayStart) return `${Math.floor(s / 3600)} h ago`;
  if (at >= dayStart - 86_400_000) return `Yesterday, ${clock(then)}`;
  const days = Math.ceil((dayStart - at) / 86_400_000);
  if (days < 30) return `${days} days ago`;
  return then.toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });
}
