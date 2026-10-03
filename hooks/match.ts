/**
 * Plain string matching (no model) between what is running in the session and
 * the lines of a project checklist: the same task code (`HU.5`, `W.14`) is a
 * match, and so is a title that covers at least 80% of the other's text.
 */

/** How alike two titles must be, 0 to 1. */
export const THRESHOLD = 0.8

const CODE = /\b([A-Za-z]{1,4}\.\d+(?:\.\d+)?)\b/

/** A task code such as `HU.5` or `W.14`, upper-cased, when the text has one. */
export const codeOf = (text: string) => CODE.exec(text)?.[1]?.toUpperCase()

export const words = (text: string) =>
  text
    .toLowerCase()
    .replace(/`|\*\*/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)

const pairs = (text: string) => {
  const out = new Map<string, number>()
  for (let i = 0; i < text.length - 1; i++) {
    const p = text.slice(i, i + 2)
    out.set(p, (out.get(p) ?? 0) + 1)
  }

  return out
}

/** Sørensen–Dice over character pairs: 1 for the same text, 0 for nothing shared. */
export const dice = (a: string, b: string) => {
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const pa = pairs(a)
  const pb = pairs(b)
  let shared = 0
  for (const [p, n] of pa) shared += Math.min(n, pb.get(p) ?? 0)

  return (2 * shared) / (a.length - 1 + (b.length - 1))
}

/**
 * The best likeness of the shorter title to any run of the same number of
 * words in the longer one, so "Night pass" is found inside "HU.5 trail and
 * Night pass (Fable)".
 */
export const partial = (a: string, b: string) => {
  const wa = words(a)
  const wb = words(b)
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa]
  if (short.length === 0) return 0
  const needle = short.join(' ')
  let best = 0
  for (let size = Math.max(1, short.length - 1); size <= short.length + 1; size++) {
    for (let i = 0; i + size <= long.length; i++) best = Math.max(best, dice(needle, long.slice(i, i + size).join(' ')))
  }

  return best
}

/** Whether a checklist title names the same work as a running title. */
export const sameWork = (title: string, running: string) => {
  const a = codeOf(title)
  const b = codeOf(running)
  if (a && b) return a === b
  const w = words(title)
  // A one-word or very short title would match too much by chance.
  if (w.length < 2 || w.join(' ').length < 6) return false

  return partial(title, running) >= THRESHOLD
}
