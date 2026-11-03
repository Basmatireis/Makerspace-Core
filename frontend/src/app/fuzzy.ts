const boundary = /[^a-z0-9]/;
const startsWord = (text: string, index: number) => index === 0 || boundary.test(text[index - 1]);

/**
 * How well `query` matches `text`, 0 for no match. Each whitespace-separated token must match: a substring scores
 * high (earlier is better, a word start earns a bonus); otherwise the token's characters must appear in order, with
 * bonuses for consecutive characters and word starts. An empty query matches everything with score 1.
 */
export function fuzzyScore(query: string, text: string): number {
  const target = text.toLowerCase();
  const tokens = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return 1;
  let total = 0;
  for (const token of tokens) {
    const at = target.indexOf(token);
    if (at >= 0) {
      total += 100 - Math.min(at, 50) + (startsWord(target, at) ? 20 : 0);
      continue;
    }
    let from = 0;
    let score = 0;
    let previous = -2;
    for (const character of token) {
      const index = target.indexOf(character, from);
      if (index < 0) return 0;
      score += (index === previous + 1 ? 3 : 1) + (startsWord(target, index) ? 2 : 0);
      previous = index;
      from = index + 1;
    }
    total += score / token.length;
  }
  return total;
}

/** The items matching `query`, best match first; equal scores keep their original order. */
export function fuzzySort<T>(items: readonly T[], query: string, toText: (item: T) => string): T[] {
  return items
    .map((item, index) => ({ item, index, score: fuzzyScore(query, toText(item)) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.item);
}
