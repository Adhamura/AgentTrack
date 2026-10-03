/**
 * The desktop board's artwork. Every strip is one SVG laid out at the pane's
 * own width (`widthFor`), so one unit is one CSS pixel and text keeps its
 * size at any width. A `Layout` holds the named anchors every strip lines up
 * on. Colors are tokens with a light and a dark value: the light one is
 * written on the element, the dark one in a `prefers-color-scheme` rule, so
 * a drawing reads on either host. Click targets are native Buttons laid over
 * the strips at the same anchors.
 */
import type { Category, Facet, TaskStatus } from '../types'
import type { Filter, Scope, SectionId } from './board'
import { runs } from './search'

/* ------------------------------------------------------------------ tokens */

const LIGHT = {
  text: '#1b1c22',
  text2: '#3a3c45',
  sub: '#6b6e7a',
  faint: '#9a9da8',
  border: '#e3e5e9',
  sep: '#eff0f2',
  head: '#f4f5f7',
  pill: '#f2f3f5',
  track: '#e8eaee',
  seg: '#e6e7eb',
  done: '#2fb36a',
  doneText: '#1f7f4f',
  doneBg: '#eaf7ef',
  active: '#1f6ff5',
  activeText: '#0a62e8',
  activeBg: '#eef4fe',
  activeTrack: '#c9dafa',
  pending: '#8a8d99',
  pendingText: '#5d5e69',
  pendingBg: '#f2f2f4',
  box: '#8f92a0',
  onFill: '#ffffff',
  hit: '#d9480f',
}
type Tok = keyof typeof LIGHT

const DARK: Record<Tok, string> = {
  text: '#ececf1',
  text2: '#c9cbd3',
  sub: '#a0a3ae',
  faint: '#7c7f8a',
  border: '#34363e',
  sep: '#2a2c33',
  head: '#26282e',
  pill: '#2b2d34',
  track: '#33353d',
  seg: '#3a3c45',
  done: '#3cc77a',
  doneText: '#86dfaa',
  doneBg: '#1b3326',
  active: '#4d8ff8',
  activeText: '#a3c4ff',
  activeBg: '#1c2a45',
  activeTrack: '#2d4068',
  pending: '#8a8d99',
  pendingText: '#b9bbc4',
  pendingBg: '#2c2e35',
  box: '#7a7d89',
  onFill: '#ffffff',
  hit: '#ff8a4c',
}

/** A state's three tokens: its mark, its text, and the wash behind that text. */
export type Tone = 'done' | 'active' | 'pending'
const TONE: Record<Tone, { fg: Tok; text: Tok; bg: Tok }> = {
  done: { fg: 'done', text: 'doneText', bg: 'doneBg' },
  active: { fg: 'active', text: 'activeText', bg: 'activeBg' },
  pending: { fg: 'pending', text: 'pendingText', bg: 'pendingBg' },
}

/**
 * Each task status as every surface shows it: its words, its tone, its
 * terminal glyph (a square for a tracked leaf) and the host theme key native
 * text is colored with.
 */
export const STATUS: Record<TaskStatus, { label: string; tone: Tone; glyph: string }> = {
  completed: { label: 'Done', tone: 'done', glyph: '☑' },
  in_progress: { label: 'In progress', tone: 'active', glyph: '▣' },
  pending: { label: 'Not started', tone: 'pending', glyph: '☐' },
}

/** Native text takes the host's theme keys, so it follows a light or dark host. */
export const TONE_KEY: Record<Tone, string> = { done: 'success', active: 'permission', pending: 'inactive' }
/** The theme key search hits are drawn in, in native text. */
export const HIT_KEY = 'warning'

export const SECTION_TONE: Record<SectionId, Tone> = { working: 'active', waiting: 'pending', done: 'done' }

/** The tone of a share of work: all done, some started or live, or nothing yet. */
export const toneOf = (done: number, total: number, isActive = false): Tone =>
  total > 0 && done === total ? 'done' : isActive || done > 0 ? 'active' : 'pending'

/**
 * An element's paint: the light color as the attribute (what shows if a
 * surface drops the style sheet), a class whose dark value `svg` adds.
 */
const paint = (fill?: Tok, stroke?: Tok) =>
  `class="${[fill ? `f-${fill}` : '', stroke ? `s-${stroke}` : ''].filter(Boolean).join(' ')}"` +
  ` fill="${fill ? LIGHT[fill] : 'none'}"` +
  (stroke ? ` stroke="${LIGHT[stroke]}"` : '')

const SANS = `Inter, 'Segoe UI', -apple-system, system-ui, sans-serif`
const SERIF = `'Tiempos Headline', Georgia, 'Times New Roman', serif`

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const svg = (w: number, h: number, body: string) => {
  const used = new Set<string>()
  for (const m of body.matchAll(/class="([^"]*)"/g)) for (const c of (m[1] ?? '').split(' ')) if (c) used.add(c)
  const dark = [...used]
    .map(c => {
      const tok = c.slice(2) as Tok
      const v = DARK[tok]

      return v ? `.${c}{${c.startsWith('f-') ? 'fill' : 'stroke'}:${v}}` : ''
    })
    .join('')

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="${SANS}">` +
    (dark ? `<style>@media (prefers-color-scheme: dark){${dark}}</style>` : '') +
    body +
    `</svg>`
  )
}

/* ------------------------------------------------------------------ text */

const ADV: Record<string, number> = {}
const adv = (chars: string, w: number) => {
  for (const c of chars) ADV[c] = w
}
adv(' ', 0.27)
adv("il.,:;'|!`", 0.26)
adv('jftrI()[]{}"', 0.36)
adv('abcdeghknopqsuvxyz?', 0.56)
adv('mw', 0.84)
adv('0123456789$#', 0.6)
adv('ABCDEFGHJKLNOPQRSTUVXYZ&', 0.68)
adv('MW%', 0.86)
adv('-/·•', 0.38)
adv('–', 0.56)
adv('—…', 0.92)

/** About how wide a text is in Inter at `size` px: an advance-width table, not a measurement. */
export const textW = (s: string, size: number, weight = 400) => {
  let em = 0
  for (const c of s) em += ADV[c] ?? (c.charCodeAt(0) > 0x2e80 ? 1 : 0.6)

  return em * size * (weight >= 600 ? 1.05 : weight >= 500 ? 1.025 : 1)
}

/** How much wider than the table a host's font may draw: what `fit` keeps clear, so a cut title never touches what follows it. */
const SLACK = 1.07

/** Cuts a text to `px` wide at `size`, with an ellipsis. */
export const fit = (s: string, px: number, size: number, weight = 400) => {
  if (textW(s, size, weight) * SLACK <= px) return s
  const chars = Array.from(s)
  let n = chars.length
  while (n > 1 && textW(`${chars.slice(0, n).join('').trimEnd()}…`, size, weight) * SLACK > px) n--

  return `${chars.slice(0, n).join('').trimEnd()}…`
}

/** A text cut to fit, escaped, with the characters the search `words` found bold in the highlight color. */
export const marked = (s: string, px: number, size: number, words: readonly string[] = [], weight = 400) =>
  runs(fit(s, px, size, weight), words)
    .map(r => (r.isHit ? `<tspan font-weight="700" ${paint('hit')}>${esc(r.text)}</tspan>` : esc(r.text)))
    .join('')

/** Breaks a text into lines of at most `px` at `size`. */
const wrapLines = (s: string, px: number, size: number) => {
  const lines: string[] = []
  let line = ''
  for (const word of s.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (line && textW(next, size) > px) {
      lines.push(line)
      line = word
    } else line = next
  }
  if (line) lines.push(line)

  return lines
}

/* ------------------------------------------------------------------ layout */

/** CSS px per cell of `bodyColumns` on a desktop; a little generous, so a strip fills its slot and is scaled down rather than left short. */
export const CELL_PX = 8.4
export const MIN_W = 360
export const MAX_W = 925

/** The drawing width for a pane `cols` cells wide. */
export const widthFor = (cols: number) => Math.round(Math.max(MIN_W, Math.min(MAX_W, (cols || 80) * CELL_PX)))

/**
 * The named anchors of every strip, from its width: the ⋯ slot at the right
 * edge, the time pill and the ring pill left of it (where task chips end too),
 * and the x where titles start.
 */
export type Layout = {
  w: number
  /** Under 560 px: no time column, part columns as icons. */
  isNarrow: boolean
  /** Under 460 px: no status chips (the checkbox says it). */
  isTiny: boolean
  more: { x: number; w: number }
  time?: { x: number; w: number }
  ring: { x: number; w: number }
  /** Where a row's title starts, and a task's checkbox and title under it. */
  titleX: number
  boxX: number
  taskX: number
}

export const layout = (w: number, opts: { hasTime?: boolean } = {}): Layout => {
  const isNarrow = w < 560
  const isTiny = w < 460
  const more = { x: w - 40, w: 32 }
  const time = opts.hasTime !== false && !isNarrow ? { x: more.x - 50, w: 46 } : undefined
  const ringW = 62

  return {
    w,
    isNarrow,
    isTiny,
    more,
    time,
    ring: { x: (time ? time.x : more.x) - 6 - ringW, w: ringW },
    titleX: 38,
    boxX: 38,
    taskX: 60,
  }
}

/* ------------------------------------------------------------------ motion */

/** A toggle that just happened, so its drawing plays the turn once. */
export type Motion = 'open' | 'close' | undefined

const EASE = `calcMode="spline" keyTimes="0;1" keySplines="0.2 0 0 1"`

/**
 * The chevron: an open stroke pointing down when open, right when closed.
 * Its resting turn is the element's own, so a surface that draws a still
 * frame shows the right state; after a toggle it turns in 220 ms.
 */
const chevron = (cx: number, cy: number, isOpen: boolean, motion: Motion) => {
  const to = isOpen ? 0 : -90
  const from = motion === 'open' ? -90 : motion === 'close' ? 0 : to
  const turn =
    from === to
      ? ''
      : `<animateTransform attributeName="transform" type="rotate" from="${from} ${cx} ${cy}" to="${to} ${cx} ${cy}" dur="0.22s" fill="freeze" ${EASE}/>`

  return (
    `<g transform="rotate(${to} ${cx} ${cy})">${turn}` +
    `<path d="M${cx - 4.5},${cy - 2.3} L${cx},${cy + 2.3} L${cx + 4.5},${cy - 2.3}" ${paint(undefined, 'text2')} ` +
    `stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></g>`
  )
}

/** Rows a toggle just revealed slide 5 px down into place, one a little after another; at rest they are where they belong. */
const reveal = (body: string, order: number | undefined) =>
  order === undefined
    ? body
    : `<g><animateTransform attributeName="transform" type="translate" values="0 -5;0 -5;0 0" keyTimes="0;${Math.min(0.6, Math.min(order, 8) * 0.07).toFixed(2)};1" dur="${(0.22 + Math.min(order, 8) * 0.03).toFixed(2)}s" fill="freeze"/>${body}</g>`

/* ------------------------------------------------------------------ marks */

/** A tracked leaf's square: filled with a check when done, a blue dot when in progress, empty otherwise. */
const checkbox = (x: number, cy: number, status: TaskStatus, size = 14) => {
  const y = cy - size / 2
  const r = size * 0.22
  if (status === 'completed') {
    const s = size / 14

    return (
      `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${r}" ${paint('done')}/>` +
      `<path d="M${x + 3.5 * s},${y + 7.3 * s} L${x + 6 * s},${y + 9.8 * s} L${x + 10.6 * s},${y + 4.4 * s}" ${paint(undefined, 'onFill')} stroke-width="${(1.8 * s).toFixed(2)}" stroke-linecap="round" stroke-linejoin="round"/>`
    )
  }
  const outline = `<rect x="${x + 0.75}" y="${y + 0.75}" width="${size - 1.5}" height="${size - 1.5}" rx="${r}" ${paint(undefined, status === 'in_progress' ? 'active' : 'box')} stroke-width="1.5"/>`

  return status === 'in_progress' ? outline + `<circle cx="${x + size / 2}" cy="${cy}" r="${size * 0.2}" ${paint('active')}/>` : outline
}

/** Aggregate progress: a ring whose arc is the done share; full and green when all is done. */
const ring = (cx: number, cy: number, done: number, total: number, tone: Tone, r = 6.5) => {
  const circ = 2 * Math.PI * r
  if (tone === 'done') return `<circle cx="${cx}" cy="${cy}" r="${r}" ${paint(undefined, 'done')} stroke-width="2.4"/>`
  const share = total === 0 ? 0 : done / total
  const f = tone === 'active' ? Math.max(0.1, share) : share
  const track = `<circle cx="${cx}" cy="${cy}" r="${r}" ${paint(undefined, tone === 'active' ? 'activeTrack' : 'track')} stroke-width="2.4"/>`
  if (f === 0) return track

  return (
    track +
    `<circle cx="${cx}" cy="${cy}" r="${r}" ${paint(undefined, 'active')} stroke-width="2.4" stroke-linecap="round" ` +
    `stroke-dasharray="${(f * circ).toFixed(2)} ${circ.toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`
  )
}

/** A small pie of done/total: what a part column's count is drawn with. */
const pie = (cx: number, cy: number, done: number, total: number, r = 5.5) => {
  const share = total === 0 ? 0 : done / total
  const base = `<circle cx="${cx}" cy="${cy}" r="${r}" ${paint(share === 1 ? 'done' : undefined, share === 1 ? undefined : 'box')} stroke-width="1.3"/>`
  if (share <= 0 || share >= 1) return base
  const a = share * 2 * Math.PI
  const x = cx + r * Math.sin(a)
  const y = cy - r * Math.cos(a)

  return base + `<path d="M${cx},${cy} L${cx},${cy - r} A${r},${r} 0 ${share > 0.5 ? 1 : 0} 1 ${x.toFixed(2)},${y.toFixed(2)} Z" ${paint('done')}/>`
}

/** A part of a line: a small green square with a check when done, an empty square when not, a dash when the line has no such part. */
const facetMark = (cx: number, cy: number, facet: Facet | undefined) =>
  !facet
    ? `<path d="M${cx - 3.5},${cy} L${cx + 3.5},${cy}" ${paint(undefined, 'faint')} stroke-width="1.6" stroke-linecap="round"/>`
    : checkbox(cx - 6, cy, facet.isDone ? 'completed' : 'pending', 12)

/** The ⋯ of a row that opens its details. */
const moreDots = (lay: Layout, cy: number) => {
  const cx = lay.more.x + lay.more.w / 2

  return [-6, 0, 6].map(d => `<circle cx="${cx + d}" cy="${cy}" r="1.6" ${paint('sub')}/>`).join('')
}

/** A dot after a live title. */
const liveDot = (x: number, cy: number) => `<circle cx="${x}" cy="${cy}" r="3.5" ${paint('active')}/>`

/* ------------------------------------------------------------------ frames */

const R = 10

/** A whole rounded card outline. */
const card = (w: number, h: number, fill?: Tok) =>
  `<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="${R}" ${paint(fill, 'border')}/>`

/**
 * The card's sides around one row (a row has no fill of its own, so strips
 * meet without a seam on any background); `isLast` closes it with rounded
 * corners, `sep` draws the hairline under the row.
 */
const frame = (w: number, h: number, isLast: boolean, sep: boolean) => {
  const sides = isLast
    ? `<path d="M0.5,-1 L0.5,${h - R} Q0.5,${h - 0.5} ${R},${h - 0.5} L${w - R},${h - 0.5} Q${w - 0.5},${h - 0.5} ${w - 0.5},${h - R} L${w - 0.5},-1" ${paint(undefined, 'border')}/>`
    : `<path d="M0.5,-1 L0.5,${h + 1} M${w - 0.5},-1 L${w - 0.5},${h + 1}" ${paint(undefined, 'border')}/>`

  return sides + (sep && !isLast ? `<path d="M16,${h - 0.5} L${w - 16},${h - 0.5}" ${paint(undefined, 'sep')}/>` : '')
}

/* ------------------------------------------------------------------ header */

/**
 * The greeting (or a document's title), a line of facts under it, and, when
 * something finished in the span, a step line of those completions with its caption.
 */
export const headerSvg = (
  lay: Layout,
  o: { heading: string; subtitle: string; completions: readonly number[]; now: number; spanMs: number; caption: string },
) => {
  const { w } = lay
  const h = lay.isNarrow ? 58 : 68
  const size = lay.isNarrow ? 21 : 26
  const recent = o.completions.filter(t => o.now - t <= o.spanMs && t <= o.now).sort((a, b) => a - b)
  const sparkW = recent.length > 0 && !lay.isTiny ? Math.min(180, Math.round(w * 0.28)) : 0
  const textEnd = w - (sparkW ? sparkW + 24 : 4)
  let spark = ''
  if (sparkW) {
    const x0 = w - sparkW - 4
    const x1 = w - 8
    const [yLow, yHigh] = [h - 26, 10]
    const pts = [`${x0},${yLow}`]
    let y = yLow
    recent.forEach((t, i) => {
      const x = x0 + ((t - (o.now - o.spanMs)) / o.spanMs) * (x1 - x0)
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`)
      y = yLow - ((i + 1) / recent.length) * (yLow - yHigh)
      pts.push(`${x.toFixed(1)},${y.toFixed(1)}`)
    })
    pts.push(`${x1},${y.toFixed(1)}`)
    spark =
      `<path d="M${x0},${yLow + 0.5} L${x1},${yLow + 0.5}" ${paint(undefined, 'border')}/>` +
      `<polyline points="${pts.join(' ')}" ${paint(undefined, 'done')} stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${x1}" cy="${y.toFixed(1)}" r="3.5" ${paint('done')}/>` +
      `<text x="${x1}" y="${h - 8}" font-size="11" text-anchor="end" ${paint('sub')}>${esc(`${recent.length} done · ${o.caption}`)}</text>`
  }

  return svg(
    w,
    h,
    `<text x="2" y="${lay.isNarrow ? 26 : 32}" font-family="${SERIF}" font-size="${size}" letter-spacing="-0.3" ${paint('text')}>${esc(fit(o.heading, textEnd - 2, size * 0.95))}</text>` +
      `<text x="2" y="${h - 10}" font-size="13" ${paint('sub')}>${esc(fit(o.subtitle, textEnd - 2, 13))}</text>` +
      spark,
  )
}

/* ------------------------------------------------------------------ tabs */

/** The board's own tab bar: each tab's title and percent; the picked one on a gray pill. */
export type TabSpec = { id: string; title: string; percent?: number }

export const TABS_H = 36

/** Where each tab sits on the bar: the click targets laid over them use the same numbers. Percents go first when room runs out, then titles shrink. */
export const tabsLayout = (lay: Layout, tabs: readonly TabSpec[]) => {
  const gap = 4
  const titleW = (t: TabSpec) => Math.ceil(textW(t.title, 13, 600) * SLACK)
  const pctOf = (t: TabSpec) => (t.percent === undefined ? '' : `${t.percent}%`)
  const widths = (withPct: boolean) => tabs.map(t => 24 + titleW(t) + (withPct && pctOf(t) ? 6 + textW(pctOf(t), 12) : 0))
  const sum = (ws: number[]) => ws.reduce((a, b) => a + b, 0) + gap * Math.max(0, ws.length - 1)
  let withPct = true
  let ws = widths(true)
  if (sum(ws) > lay.w) {
    withPct = false
    ws = widths(false)
  }
  const over = sum(ws) - lay.w
  if (over > 0) ws = ws.map(x => Math.max(44, x - over / ws.length))
  let x = 0

  return tabs.map((t, i) => {
    const at = { id: t.id, x, w: ws[i]!, pct: withPct ? pctOf(t) : '' }
    x += ws[i]! + gap

    return at
  })
}

export const tabsSvg = (lay: Layout, tabs: readonly TabSpec[], active: string) => {
  const at = tabsLayout(lay, tabs)

  return svg(
    lay.w,
    TABS_H,
    tabs
      .map((t, i) => {
        const { x, w, pct } = at[i]!
        const isOn = t.id === active
        const room = w - 24 - (pct ? 6 + textW(pct, 12) : 0)

        return (
          (isOn ? `<rect x="${x}" y="4" width="${w}" height="28" rx="8" ${paint('seg')}/>` : '') +
          `<text x="${x + 12}" y="23" font-size="13" font-weight="${isOn ? 600 : 500}" ${paint(isOn ? 'text' : 'sub')}>${esc(fit(t.title, room, 13, 600))}` +
          (pct ? `<tspan dx="6" font-size="12" font-weight="400" ${paint('sub')}>${pct}</tspan>` : '') +
          `</text>`
        )
      })
      .join(''),
  )
}

/* ------------------------------------------------------------------ summary */

/** The scope switch's words, in the order drawn. */
export const SCOPE_LABEL: Record<Scope, string> = { session: 'Session', project: 'Project', all: 'All' }

export const SUMMARY_H = 110
export const PILL_TOP = 72
export const PILL_H = 26
export const SCOPE_TOP = 12
export const SCOPE_H = 30

export type SummaryCounts = { total: number; done: number; inProgress: number; notStarted: number; percent: number }

/** The pills' words and tones: All first, then the three states; shorter words when the card is narrow. */
const pillSpecs = (c: SummaryCounts, short: boolean) =>
  [
    { id: 'all' as Filter, label: `All ${c.total}`, tone: undefined },
    { id: 'completed' as Filter, label: `${c.done} done`, tone: 'done' as Tone },
    { id: 'in_progress' as Filter, label: `${c.inProgress} ${short ? 'active' : 'in progress'}`, tone: 'active' as Tone },
    { id: 'pending' as Filter, label: `${c.notStarted} ${short ? 'to do' : 'not started'}`, tone: 'pending' as Tone },
  ]

/** Where each option of the scope switch sits, at the card's top right. */
export const scopeLayout = (lay: Layout, scopes: readonly Scope[]) => {
  const ws = scopes.map(sc => Math.ceil(textW(SCOPE_LABEL[sc], 13, 600) + 24))
  let x = lay.w - 14 - ws.reduce((a, b) => a + b, 0)

  return scopes.map((id, i) => {
    const at = { id, x, w: ws[i]! }
    x += ws[i]!

    return at
  })
}

/** The scope switch: a gray track, the picked option raised on it. */
const scopeArt = (at: readonly { id: Scope; x: number; w: number }[], picked: Scope) => {
  const first = at[0]
  const last = at[at.length - 1]
  if (!first || !last) return ''

  return (
    `<rect x="${first.x}" y="${SCOPE_TOP}" width="${last.x + last.w - first.x}" height="${SCOPE_H}" rx="8" ${paint('pill')}/>` +
    at
      .map(o => {
        const isOn = o.id === picked

        return (
          (isOn ? `<rect x="${o.x + 3}" y="${SCOPE_TOP + 3}" width="${o.w - 6}" height="${SCOPE_H - 6}" rx="6" ${paint('seg')}/>` : '') +
          `<text x="${o.x + o.w / 2}" y="${SCOPE_TOP + 20}" font-size="13" text-anchor="middle" font-weight="${isOn ? 600 : 400}" ${paint(isOn ? 'text' : 'sub')}>${SCOPE_LABEL[o.id]}</text>`
        )
      })
      .join('')
  )
}

/** Where each pill and scope option sits on the summary card: the click targets use the same numbers. */
export const summaryLayout = (lay: Layout, c: SummaryCounts, scopes?: readonly Scope[]) => {
  const place = (short: boolean) => {
    let x = 16

    return pillSpecs(c, short).map(p => {
      const w = Math.ceil((p.tone ? 26 : 16) + textW(p.label, 12, 500))
      const at = { ...p, x, w }
      x += w + 6

      return at
    })
  }
  let pills = place(false)
  const last = pills[pills.length - 1]!
  if (last.x + last.w > lay.w - 16) pills = place(true)

  return { pills, scope: scopeLayout(lay, scopes ?? []) }
}

/** The summary card: percent, a bar of done and in-progress work, the pills that filter, and (on Agents) the scope switch. */
export const summarySvg = (lay: Layout, c: SummaryCounts, filter: Filter, unit: string, scope?: { scopes: readonly Scope[]; picked: Scope }) => {
  const { w } = lay
  const at = summaryLayout(lay, c, scope?.scopes)
  const barX = 16
  const barW = w - 32
  const doneW = c.done === 0 ? 0 : Math.max(8, (c.done / Math.max(1, c.total)) * barW)
  const activeW = c.inProgress === 0 ? 0 : Math.max(6, (c.inProgress / Math.max(1, c.total)) * barW)
  const pct = `${c.percent}%`
  const metaX = 16 + textW(pct, 28, 600) + 10
  const meta = `${c.done} of ${c.total} ${unit} done`
  const metaEnd = at.scope[0] ? at.scope[0].x - 12 : w - 16

  return svg(
    w,
    SUMMARY_H,
    card(w, SUMMARY_H) +
      `<text x="16" y="42" font-size="28" font-weight="600" letter-spacing="-0.6" ${paint('text')}>${pct}</text>` +
      (metaEnd - metaX > textW(meta, 12) ? `<text x="${metaX}" y="41" font-size="12" ${paint('sub')}>${esc(meta)}</text>` : '') +
      (scope ? scopeArt(at.scope, scope.picked) : '') +
      `<rect x="${barX}" y="54" width="${barW}" height="6" rx="3" ${paint('track')}/>` +
      (activeW > 0 ? `<rect x="${barX + doneW}" y="54" width="${Math.min(activeW, barW - doneW).toFixed(1)}" height="6" rx="3" ${paint('activeTrack')}/>` : '') +
      (doneW > 0 ? `<rect x="${barX}" y="54" width="${doneW.toFixed(1)}" height="6" rx="3" ${paint('done')}/>` : '') +
      at.pills
        .map(p => {
          const t = p.tone ? TONE[p.tone] : undefined
          const isPicked = filter === p.id
          const cy = PILL_TOP + PILL_H / 2

          return (
            `<rect x="${p.x + 0.75}" y="${PILL_TOP + 0.75}" width="${p.w - 1.5}" height="${PILL_H - 1.5}" rx="${PILL_H / 2}" ${paint(t?.bg ?? 'pill', isPicked ? (t?.fg ?? 'text2') : undefined)}${isPicked ? ' stroke-width="1.5"' : ''}/>` +
            (t ? `<circle cx="${p.x + 13}" cy="${cy}" r="3.5" ${paint(t.fg)}/>` : '') +
            `<text x="${p.x + (t ? 21 : 8)}" y="${cy + 4.2}" font-size="12" font-weight="500" ${paint(t?.text ?? 'text2')}>${esc(p.label)}</text>`
          )
        })
        .join(''),
  )
}

/* ------------------------------------------------------------------ columns */

/** How many of a list's lines have a part done, of those that have it. */
export type ColumnCount = { key: string; done: number; total: number }

/**
 * Where a section's part columns sit, the same for every group and line in
 * it: right-aligned before the ring pill. `full` columns carry their word and
 * count on the group row; `compact` ones are icons (the counts move to the
 * group's second line); `none` when even icons leave no room for names.
 */
export type ColumnPlan = { mode: 'full' | 'compact' | 'none'; cells: { key: string; x: number; w: number }[] }

export const planColumns = (lay: Layout, keys: readonly string[], widest: number): ColumnPlan => {
  if (keys.length === 0) return { mode: 'none', cells: [] }
  const end = lay.ring.x - 10
  const lay2 = (ws: number[]) => {
    let x = end - ws.reduce((a, b) => a + b, 0)

    return keys.map((key, i) => {
      const at = { key, x, w: ws[i]! }
      x += ws[i]!

      return at
    })
  }
  const counter = `${widest}/${widest}`
  const full = keys.map(k => Math.ceil(28 + textW(`${k} ${counter}`, 12)))
  if (end - full.reduce((a, b) => a + b, 0) >= lay.taskX + 130) return { mode: 'full', cells: lay2(full) }
  const icons = keys.map(() => 24)
  if (end - icons.length * 24 >= lay.taskX + 100) return { mode: 'compact', cells: lay2(icons) }

  return { mode: 'none', cells: [] }
}

/** A column's count: a pie of done/total, and in a full column its word and numbers; a dash where the list has no such part. */
const countCell = (at: { x: number }, col: ColumnCount, cy: number, withWords: boolean) =>
  (col.total === 0 ? facetMark(at.x + 7, cy, undefined) : pie(at.x + 7, cy, col.done, col.total)) +
  (withWords
    ? `<text x="${at.x + 17}" y="${cy + 4}" font-size="12" ${paint(col.total === 0 ? 'faint' : col.done === col.total ? 'doneText' : 'sub')}>${esc(col.key)}${col.total === 0 ? '' : ` ${col.done}/${col.total}`}</text>`
    : '')

/* ------------------------------------------------------------------ sections */

/** A section's gray header: chevron, state dot, title, done/total, and its percent and bar (or its column counts) at the right. */
export const SECTION_H = 36

export const sectionHeadSvg = (
  lay: Layout,
  o: {
    tone: Tone
    title: string
    done: number
    total: number
    isOpen: boolean
    motion?: Motion
    mark?: readonly string[]
    plan?: ColumnPlan
    columns?: readonly ColumnCount[]
  },
) => {
  const { w } = lay
  const h = SECTION_H
  const bottom = o.isOpen
    ? `L${w - 0.5},${h} L0.5,${h} Z`
    : `L${w - 0.5},${h - R} Q${w - 0.5},${h - 0.5} ${w - R},${h - 0.5} L${R},${h - 0.5} Q0.5,${h - 0.5} 0.5,${h - R} Z`
  const path = `M0.5,${R} Q0.5,0.5 ${R},0.5 L${w - R},0.5 Q${w - 0.5},0.5 ${w - 0.5},${R} ${bottom}`
  const share = o.total === 0 ? 0 : o.done / o.total
  const ringEnd = lay.ring.x + lay.ring.w
  const hasCols = o.plan && o.plan.mode !== 'none' && o.columns && o.columns.length > 0
  const barW = lay.isTiny ? 0 : 72
  const barX = ringEnd - 40 - barW
  const right = hasCols
    ? o.plan!.cells.map(c => countCell(c, o.columns!.find(col => col.key === c.key) ?? { key: c.key, done: 0, total: 0 }, h / 2, o.plan!.mode === 'full')).join('')
    : (barW
        ? `<rect x="${barX}" y="${h / 2 - 2}" width="${barW}" height="4" rx="2" ${paint('track')}/>` +
          (share > 0 ? `<rect x="${barX}" y="${h / 2 - 2}" width="${Math.max(4, share * barW).toFixed(1)}" height="4" rx="2" ${paint(TONE[toneOf(o.done, o.total, true)].fg)}/>` : '')
        : '') + `<text x="${ringEnd}" y="${h / 2 + 4}" font-size="12" text-anchor="end" ${paint('sub')}>${Math.round(share * 100)}%</text>`
  const titleEnd = (hasCols ? o.plan!.cells[0]!.x : barW ? barX : ringEnd - 40) - 12
  const count = `${o.done}/${o.total}`
  const titleRoom = titleEnd - 46 - textW(count, 12) - 8

  return svg(
    w,
    h,
    `<path d="${path}" ${paint('head')}/>` +
      chevron(18, h / 2, o.isOpen, o.motion) +
      `<circle cx="34" cy="${h / 2}" r="4" ${paint(TONE[o.tone].fg)}/>` +
      `<text x="46" y="${h / 2 + 4.5}" font-size="13" font-weight="600" ${paint('text')}>${marked(o.title, titleRoom, 13, o.mark, 600)}` +
      `<tspan dx="8" font-size="12" font-weight="400" ${paint('sub')}>${count}</tspan></text>` +
      right,
  )
}

/* ------------------------------------------------------------------ rows */

export const ROW_H = 52

/** One agent, session or group row: chevron, title (with a dot while live), its second line, ring pill, time pill and ⋯. */
export const rowSvg = (
  lay: Layout,
  o: {
    title: string
    sub: string
    done: number
    total: number
    tone: Tone
    isLive: boolean
    isOpen: boolean
    isLast: boolean
    motion?: Motion
    order?: number
    when?: string
    hasMore?: boolean
    mark?: readonly string[]
    plan?: ColumnPlan
    columns?: readonly ColumnCount[]
  },
) => {
  const { w } = lay
  const h = ROW_H
  const cells = o.plan && o.plan.mode !== 'none' && o.columns ? o.plan.cells : []
  const end = (cells[0] ? cells[0].x : lay.ring.x) - 12
  const titleRoom = end - lay.titleX - (o.isLive ? 14 : 0)
  const title = fit(o.title, titleRoom, 14, 500)
  const dotX = lay.titleX + textW(title, 14, 500) + 9
  const counts = `${o.done}/${o.total}`

  return svg(
    w,
    h,
    frame(w, h, o.isLast && !o.isOpen, true) +
      reveal(
        chevron(18, 22, o.isOpen, o.motion) +
          `<text x="${lay.titleX}" y="27" font-size="14" font-weight="500" ${paint('text')}>${marked(title, titleRoom + 20, 14, o.mark, 500)}</text>` +
          (o.isLive ? liveDot(dotX, 22) : '') +
          `<text x="${lay.titleX}" y="44" font-size="12" ${paint('sub')}>${marked(o.sub, end - lay.titleX, 12, o.mark)}</text>` +
          cells.map(c => countCell(c, o.columns!.find(col => col.key === c.key) ?? { key: c.key, done: 0, total: 0 }, 22, o.plan!.mode === 'full')).join('') +
          `<rect x="${lay.ring.x}" y="10" width="${lay.ring.w}" height="24" rx="12" ${paint('pill')}/>` +
          ring(lay.ring.x + 14, 22, o.done, o.total, o.tone) +
          `<text x="${lay.ring.x + lay.ring.w - 10}" y="26.3" font-size="12" font-weight="500" text-anchor="end" ${paint('text')}>${counts}</text>` +
          (lay.time && o.when !== undefined
            ? `<rect x="${lay.time.x}" y="10" width="${lay.time.w}" height="24" rx="12" ${paint('pill')}/>` +
              `<text x="${lay.time.x + lay.time.w / 2}" y="26.3" font-size="12" text-anchor="middle" ${paint('pendingText')}>${esc(o.when || '—')}</text>`
            : '') +
          (o.hasMore ? moreDots(lay, 22) : ''),
        o.order,
      ),
  )
}

export const TASK_H = 32

/** One tracked leaf (a todo item or a checklist line): its square, title, part marks, status chip, time and ⋯. */
export const taskRowSvg = (
  lay: Layout,
  o: {
    title: string
    status: TaskStatus
    isLast: boolean
    isPicked: boolean
    /** Right under a section header: no guide line. */
    flat?: boolean
    order?: number
    when?: string
    isLive?: boolean
    mark?: readonly string[]
    plan?: ColumnPlan
    facets?: readonly Facet[]
  },
) => {
  const { w } = lay
  const h = TASK_H
  const cy = h / 2
  const st = STATUS[o.status]
  const tone = TONE[st.tone]
  const chipW = lay.isTiny ? 0 : Math.ceil(textW(st.label, 11, 500) + 16)
  const chipX = lay.ring.x + lay.ring.w - chipW
  const cells = o.plan && o.plan.mode !== 'none' ? o.plan.cells : []
  const end = (cells[0] ? cells[0].x : chipW ? chipX : lay.ring.x + lay.ring.w) - 10
  const titleRoom = end - lay.taskX - (o.isLive ? 14 : 0)
  const title = fit(o.title, titleRoom, 13)
  const isDone = o.status === 'completed'

  return svg(
    w,
    h,
    frame(w, h, o.isLast, false) +
      (o.flat ? '' : `<path d="M18,0 L18,${o.isLast ? h - 10 : h}" ${paint(undefined, 'sep')} stroke-width="2"/>`) +
      reveal(
        (o.isPicked ? `<rect x="28" y="2" width="${w - 36}" height="${h - 4}" rx="6" ${paint('activeBg')}/>` : '') +
          checkbox(lay.boxX, cy, o.status) +
          `<text x="${lay.taskX}" y="${cy + 4.5}" font-size="13" ${paint(isDone ? 'sub' : 'text')}>${marked(title, titleRoom + 20, 13, o.mark)}</text>` +
          (o.isLive ? liveDot(lay.taskX + textW(title, 13) + 9, cy) : '') +
          cells.map(c => facetMark(c.x + 7, cy, o.facets?.find(f => f.key === c.key))).join('') +
          (chipW
            ? `<rect x="${chipX}" y="${cy - 10}" width="${chipW}" height="20" rx="10" ${paint(tone.bg)}/>` +
              `<text x="${chipX + chipW / 2}" y="${cy + 3.8}" font-size="11" font-weight="500" text-anchor="middle" ${paint(tone.text)}>${st.label}</text>`
            : '') +
          (lay.time && o.when !== undefined
            ? `<text x="${lay.time.x + lay.time.w / 2}" y="${cy + 4}" font-size="12" text-anchor="middle" ${paint('sub')}>${esc(o.when || '—')}</text>`
            : '') +
          moreDots(lay, cy),
        o.order,
      ),
  )
}

export const EMPTY_H = 44

/** The muted line a section or row shows when it has nothing in it; `standalone` draws a whole card, `link` a line to press. */
export const emptyRowSvg = (
  lay: Layout,
  text: string,
  opts: { isLast?: boolean; indent?: number; order?: number; standalone?: boolean; link?: boolean } = {},
) => {
  const h = EMPTY_H
  const x = opts.indent ?? lay.titleX

  return svg(
    lay.w,
    h,
    (opts.standalone ? card(lay.w, h) : frame(lay.w, h, opts.isLast ?? true, false)) +
      reveal(
        `<text x="${x}" y="27" font-size="13"${opts.link ? ' font-weight="500"' : ''} ${paint(opts.link ? 'activeText' : 'sub')}>${esc(fit(text, lay.w - x - 16, 13))}</text>`,
        opts.order,
      ),
  )
}

/** A whole card with a title and a wrapped line or two: the board's empty state; with the scope switch at its top right. */
export const noticeSvg = (lay: Layout, title: string, body: string, scope?: { scopes: readonly Scope[]; picked: Scope }) => {
  const lines = wrapLines(body, lay.w - 40, 13)
  const at = scope ? scopeLayout(lay, scope.scopes) : []
  const h = noticeH(lay, body, scope !== undefined)
  const top = scope ? 30 : 0

  return svg(
    lay.w,
    h,
    card(lay.w, h) +
      (scope ? scopeArt(at, scope.picked) : '') +
      `<text x="20" y="${32 + (scope && lay.w < 520 ? top + 6 : 0)}" font-size="14" font-weight="600" ${paint('text')}>${esc(title)}</text>` +
      lines.map((l, i) => `<text x="20" y="${55 + (scope && lay.w < 520 ? top + 6 : 0) + i * 19}" font-size="13" ${paint('sub')}>${esc(l)}</text>`).join(''),
  )
}

/** How tall the notice card is: the click targets over its scope switch need it. */
export const noticeH = (lay: Layout, body: string, hasScope: boolean) => {
  const lines = wrapLines(body, lay.w - 40, 13).length

  return hasScope ? 64 + lines * 19 + (lay.w < 520 ? 36 : 0) : 60 + lines * 19
}

/** A row's second line: an agent's type, then what it is doing now. */
export const rowSub = (cat: Category, step: string) => [cat.kind === 'agent' && cat.agentType ? cat.agentType : '', step].filter(Boolean).join(' · ')
