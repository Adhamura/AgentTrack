/**
 * The board's search: what a query matches and which characters of a text it
 * marks. A query is words; a thing matches when every word is found, in any
 * case, somewhere in its texts (a title, a step, a description, a detail).
 */

/** The query's words, lowercased; none for a blank query. */
export const terms = (query: string): string[] => query.toLowerCase().split(/\s+/).filter(Boolean)

/** Whether every word is found in one of the texts; true for no words. */
export const matches = (texts: readonly (string | undefined)[], words: readonly string[]): boolean => {
  if (words.length === 0) return true
  const hay = texts.filter(Boolean).join('\n').toLowerCase()

  return words.every(w => hay.includes(w))
}

/** One run of a text: marked when a word was found there. */
export type Run = { text: string; isHit: boolean }

/** The text cut into runs, every occurrence of every word marked (overlaps merged). */
export const runs = (text: string, words: readonly string[]): Run[] => {
  if (words.length === 0 || !text) return [{ text, isHit: false }]
  // Lowercased one character at a time, so every index still points at the same character.
  const low = Array.from(text, ch => (ch.toLowerCase().length === ch.length ? ch.toLowerCase() : ch)).join('')
  const hit = new Array<boolean>(text.length).fill(false)
  for (const w of words) {
    for (let at = low.indexOf(w); at >= 0; at = low.indexOf(w, at + 1)) hit.fill(true, at, at + w.length)
  }
  const out: Run[] = []
  for (let i = 0; i < text.length; ) {
    let j = i
    while (j < text.length && hit[j] === hit[i]) j++
    out.push({ text: text.slice(i, j), isHit: hit[i]! })
    i = j
  }

  return out
}
