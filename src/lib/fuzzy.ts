/**
 * Subsequence matching for the session palette: "btg" finds "big_tdx_1_guest".
 * Consecutive letters and letters at the start of a word score higher.
 */
export interface Match {
  score: number;
  /** Indexes of the matched characters, for highlighting. */
  indexes: number[];
}

const isBoundary = (text: string, i: number) => i === 0 || /[\s_\-./@:]/.test(text[i - 1]);

export function fuzzyMatch(query: string, text: string): Match | null {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return { score: 0, indexes: [] };

  // A plain substring beats any scattered match.
  const at = t.indexOf(q);
  if (at >= 0) {
    const indexes = Array.from({ length: q.length }, (_, k) => at + k);
    return { score: 1000 - at + (isBoundary(text, at) ? 200 : 0) + (q.length === t.length ? 500 : 0), indexes };
  }

  const indexes: number[] = [];
  let score = 0;
  let from = 0;
  for (const ch of q) {
    const i = t.indexOf(ch, from);
    if (i < 0) return null;
    const previous = indexes[indexes.length - 1];
    score += previous === i - 1 ? 15 : 1;
    if (isBoundary(text, i)) score += 10;
    indexes.push(i);
    from = i + 1;
  }
  return { score: score - (indexes[0] ?? 0), indexes };
}
