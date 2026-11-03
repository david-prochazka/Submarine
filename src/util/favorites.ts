// Servers starred on this device, shown at the top of the sidebar. Kept per
// device in localStorage like the last-connected times: a favourite says what
// this person reaches for here, and it needs no change to the synced profile.
// Keyed by the server's uuid, so profiles with overlapping local ids don't mix.

const KEY = "submarine-favorites";

export const favoriteKey = (s: { id: number; uuid?: string | null }) => s.uuid || `id:${s.id}`;

export function readFavorites(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    return new Set(Array.isArray(raw) ? raw.filter((k) => typeof k === "string") : []);
  } catch {
    return new Set();
  }
}

export function toggleFavorite(prev: Set<string>, key: string): Set<string> {
  const next = new Set(prev);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  try { localStorage.setItem(KEY, JSON.stringify([...next])); } catch { /* storage blocked: kept for this run only */ }
  return next;
}
