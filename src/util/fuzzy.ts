// Fuzzy match for the command palette: the query's characters must appear in
// the text in order, case ignored, spaces in the query ignored ("web pr"
// finds "web-prod-01"). Lower scores rank first: a match that starts early,
// stays together and lands on word starts beats one spread across the text.

export type FuzzyMatch = { score: number; hits: number[] };

const isWordStart = (text: string, i: number) => i === 0 || /[\s\-_./@:]/.test(text[i - 1]);

export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { score: 0, hits: [] };
  const t = text.toLowerCase();

  // A plain substring is the best kind of match; prefer one on a word start.
  let at = -1;
  for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + 1)) {
    if (at < 0) at = i;
    if (isWordStart(t, i)) { at = i; break; }
  }
  if (at >= 0) {
    return { score: (isWordStart(t, at) ? 0 : 2) + at * 0.1, hits: Array.from(q, (_, k) => at + k) };
  }

  // In order from each place the first letter occurs; the tightest wins.
  let hits: number[] | null = null;
  for (let start = t.indexOf(q[0]); start >= 0; start = t.indexOf(q[0], start + 1)) {
    const h = [start];
    for (let i = start + 1; i < t.length && h.length < q.length; i++) if (t[i] === q[h.length]) h.push(i);
    if (h.length < q.length) break;
    if (!hits || h[h.length - 1] - h[0] < hits[hits.length - 1] - hits[0]) hits = h;
  }
  if (!hits) return null;
  const span = hits[hits.length - 1] - hits[0] + 1;
  const starts = hits.filter((i) => isWordStart(t, i)).length;
  // Letters strewn across a long name match nearly anything, so a wide
  // match counts only when it is mostly word starts ("wp1": web-prod-01).
  if (span > q.length * 3 && starts < q.length - 1) return null;
  return { score: 4 + (span - q.length) * 0.5 + hits[0] * 0.1 - starts * 0.5, hits };
}

// The text cut into runs, each marked as matched or not, for highlighting.
export function fuzzySegments(text: string, hits: number[]): { text: string; hit: boolean }[] {
  const set = new Set(hits);
  const out: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i);
    const last = out[out.length - 1];
    if (last && last.hit === hit) last.text += text[i];
    else out.push({ text: text[i], hit });
  }
  return out;
}
