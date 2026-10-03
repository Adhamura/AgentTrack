/**
 * The desktop board's artwork: each piece is one SVG drawn in the reference
 * screenshot's own pixels (a 925 px wide content column), so every piece
 * scales together and lines up. Controls (chevrons, ⋯) are native Buttons laid
 * over the blank slots these leave for them.
 */
import type { Category, Task } from '../types'
import type { Counts, Filter, SectionId, Summary } from './board'
import { countTasks, currentStep, relTime, rowCheck, sectionOf } from './board'
import { runs } from './search'

export const W = 925

export const INK = {
  text: '#1b1c22',
  sub: '#8a8d99',
  count: '#737886',
  label: '#4d4e55',
  border: '#e9ebee',
  sep: '#f1f2f4',
  head: '#f4f5f6',
  pill: '#f4f5f6',
  bar: '#4cc785',
  barTrack: '#eef0f2',
  green: '#2fb36a',
  greenDot: '#37b76d',
  greenText: '#0c773b',
  greenBg: '#f1fbf5',
  blue: '#1f6ff5',
  blueText: '#0a62e8',
  blueBg: '#f1f6fe',
  blueTrack: '#cfdcf5',
  gray: '#9295a1',
  grayText: '#5d5e69',
  grayBg: '#f2f2f4',
  pink: '#dc267a',
  doneDot: '#15ab49',
  check: '#62cb94',
  box: '#b6b8c1',
  chipDoneBg: '#e9f8f0',
  chipDoneText: '#2f9e66',
  /** The characters a search found: drawn bold in this color. */
  hit: '#d9480f',
}

const SANS = `Inter, 'Segoe UI', -apple-system, system-ui, sans-serif`
const SERIF = `'Tiempos Headline', Georgia, 'Times New Roman', serif`

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Cuts text to roughly `px` wide at `perChar` px per character, with an ellipsis. */
export const fit = (s: string, px: number, perChar: number) => {
  const max = Math.max(1, Math.floor(px / perChar))

  return s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`
}

/**
 * A text cut to fit like `fit`, escaped, with the characters the search
 * `words` found drawn bold in the highlight color.
 */
export const marked = (s: string, px: number, perChar: number, words: readonly string[] = []) =>
  runs(fit(s, px, perChar), words)
    .map(r => (r.isHit ? `<tspan font-weight="700" fill="${INK.hit}">${esc(r.text)}</tspan>` : esc(r.text)))
    .join('')

const svg = (h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}" ` +
  `font-family="${SANS}">${body}</svg>`

/** A toggle that just happened, so its drawing plays the turn once. */
export type Motion = 'open' | 'close' | undefined

const EASE = `calcMode="spline" keyTimes="0;1" keySplines="0.2 0 0 1"`

/**
 * The chevron of the reference: a 10 x 5.5 open stroke pointing down when
 * open, turned a quarter to point right when closed. After a toggle it turns
 * between the two in 220 ms on an ease-out curve.
 */
const chevron = (cx: number, cy: number, isOpen: boolean, motion: Motion, color = '#2a2c36') => {
  const to = isOpen ? 0 : -90
  const from = motion === 'open' ? -90 : motion === 'close' ? 0 : to
  const turn =
    from === to
      ? ''
      : `<animateTransform attributeName="transform" type="rotate" from="${from} ${cx} ${cy}" to="${to} ${cx} ${cy}" ` +
        `dur="0.22s" fill="freeze" ${EASE}/>`

  return (
    `<g transform="rotate(${from} ${cx} ${cy})">${turn}` +
    `<path d="M${cx - 5},${cy - 2.6} L${cx},${cy + 2.6} L${cx + 5},${cy - 2.6}" fill="none" stroke="${color}" ` +
    `stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></g>`
  )
}

/** Rows a toggle just revealed slide 6 px down into place while fading in, a little after one another. */
const reveal = (body: string, order: number | undefined) =>
  order === undefined
    ? body
    : `<g opacity="0"><animate attributeName="opacity" from="0" to="1" begin="${(Math.min(order, 8) * 0.03).toFixed(2)}s" dur="0.2s" fill="freeze" ${EASE}/>` +
      `<animateTransform attributeName="transform" type="translate" from="0 -6" to="0 0" begin="${(Math.min(order, 8) * 0.03).toFixed(2)}s" dur="0.24s" fill="freeze" ${EASE}/>` +
      `${body}</g>`

export const SECTION_DOT: Record<SectionId, string> = { working: INK.pink, waiting: INK.gray, done: INK.doneDot }

/** Greeting (or a document's title), its subtitle, and the pink line of completions over the last `spanMs` (an hour). */
export const headerSvg = (
  name: string,
  subtitle: string,
  completions: readonly number[],
  now: number,
  heading?: string,
  spanMs = 60 * 60 * 1000,
) => {
  const h = 118
  const x0 = 664
  const x1 = 901
  const yLow = 86
  const yHigh = 36
  const span = spanMs
  const recent = completions.filter(t => now - t <= span).sort((a, b) => a - b)
  const total = Math.max(1, recent.length)
  const pts: string[] = [`${x0},${yLow}`]
  recent.forEach((t, i) => {
    const x = x0 + ((t - (now - span)) / span) * (x1 - x0)
    const y = yLow - ((i + 1) / total) * (yLow - yHigh)
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`)
  })
  const end = recent.length > 0 ? yHigh : yLow
  pts.push(`${x1},${end}`)
  let grid = ''
  for (let gx = 660; gx <= 915; gx += 8) for (let gy = 20; gy <= 100; gy += 8) grid += `<circle cx="${gx}" cy="${gy}" r="0.8"/>`
  const greeting = heading ?? (name ? `Welcome back, ${name}.` : 'Welcome back.')

  return svg(
    h,
    `<g fill="#e4e5ea" opacity="0.55">${grid}</g>` +
      `<text x="6" y="56" font-family="${SERIF}" font-size="39" font-weight="400" fill="${INK.text}" letter-spacing="-0.4">${esc(fit(greeting, 620, 19))}</text>` +
      `<text x="6" y="92" font-size="20" fill="${INK.sub}">${esc(fit(subtitle, 640, 10))}</text>` +
      `<polyline points="${pts.join(' ')}" fill="none" stroke="${INK.pink}" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>` +
      `<circle cx="${x1}" cy="${end}" r="11" fill="${INK.pink}" opacity="0.14"/>` +
      `<circle cx="${x1}" cy="${end}" r="6" fill="${INK.pink}"/>`,
  )
}

/** One status pill of the summary; the picked one is ringed in its dot's color. */
const pill = (x: number, w: number, bg: string, dot: string | undefined, color: string, label: string, isPicked: boolean) =>
  `<rect x="${x}" y="65" width="${w}" height="34" rx="17" fill="${bg}"` +
  (isPicked ? ` stroke="${dot ?? color}" stroke-width="1.6"/>` : '/>') +
  (dot ? `<circle cx="${x + 23}" cy="82" r="6" fill="${dot}"/>` : '') +
  `<text x="${x + (dot ? 44 : 20)}" y="89" font-size="19.5" fill="${color}">${esc(label)}</text>`

/** The pills' order, labels and colors: All first, then the three states. */
const pillSpecs = (c: Counts) =>
  [
    { id: 'all', label: `All ${c.total}`, bg: INK.pill, dot: undefined, color: INK.label },
    { id: 'completed', label: `${c.done} completed`, bg: INK.greenBg, dot: INK.greenDot, color: INK.greenText },
    { id: 'in_progress', label: `${c.inProgress} in progress`, bg: INK.blueBg, dot: INK.blue, color: INK.blueText },
    { id: 'pending', label: `${c.notStarted} not started`, bg: INK.grayBg, dot: INK.gray, color: INK.grayText },
  ] as const

/**
 * Where each pill sits on the card, in its 925 px: the click targets laid over
 * them use the same numbers. The card is 118 tall; the pills span y 65 to 99.
 */
export const summaryPills = (c: Counts): { id: Filter; x: number; w: number }[] => {
  let x = 20

  return pillSpecs(c).map(p => {
    const w = (p.dot ? 62 : 40) + p.label.length * 10.2
    const at = { id: p.id, x, w }
    x += w + 18

    return at
  })
}

export const SUMMARY_H = 118
export const PILL_TOP = 65
export const PILL_H = 34

/** The summary card: percent, bar, task count and the status pills that filter the board. */
export const summarySvg = (c: Summary, filter: Filter = 'all') => {
  const h = SUMMARY_H
  const barX = 133
  const barW = 642
  const fillW = c.total === 0 ? 0 : Math.max(15, (c.done / c.total) * barW)
  const at = summaryPills(c)

  return svg(
    h,
    `<rect x="0.5" y="0.5" width="${W - 1}" height="${h - 1}" rx="12" fill="#fff" stroke="${INK.border}"/>` +
      `<text x="25" y="50" font-size="37" font-weight="500" fill="${INK.text}" letter-spacing="-1">${c.percent}%</text>` +
      `<rect x="${barX}" y="28" width="${barW}" height="15" rx="7.5" fill="${INK.barTrack}"/>` +
      (fillW > 0 ? `<rect x="${barX}" y="28" width="${fillW.toFixed(1)}" height="15" rx="7.5" fill="${INK.bar}"/>` : '') +
      `<text x="${W - 25}" y="44" font-size="19" fill="${INK.label}" text-anchor="end">${c.done}/${c.total} ${c.unit}</text>` +
      pillSpecs(c)
        .map((p, i) => pill(at[i]?.x ?? 0, at[i]?.w ?? 0, p.bg, p.dot, p.color, p.label, filter === p.id))
        .join(''),
  )
}

/** The board's own tab bar: each tab's title and percent; the picked one on a gray pill, as the app's own nav. */
export type TabSpec = { id: string; title: string; percent?: number }

export const TABS_H = 50
const TAB_TOP = 5
const TAB_H = 40

/** Where each tab sits on the bar, in its 925 px: the click targets laid over them use the same numbers. */
export const tabsLayout = (tabs: readonly TabSpec[]) => {
  let x = 0

  return tabs.map(t => {
    const pct = t.percent === undefined ? '' : `${t.percent}%`
    const w = 40 + t.title.length * 10.6 + (pct ? 10 + pct.length * 9.4 : 0)
    const at = { id: t.id, x, w, top: TAB_TOP, h: TAB_H }
    x += w + 6

    return at
  })
}

export const tabsSvg = (tabs: readonly TabSpec[], active: string) => {
  const at = tabsLayout(tabs)

  return svg(
    TABS_H,
    tabs
      .map((t, i) => {
        const { x, w } = at[i] ?? { x: 0, w: 0 }
        const isOn = t.id === active
        const pct = t.percent === undefined ? '' : `${t.percent}%`

        return (
          (isOn ? `<rect x="${x}" y="${TAB_TOP}" width="${w}" height="${TAB_H}" rx="12" fill="#ececee"/>` : '') +
          `<text x="${x + 16}" y="31" font-size="19" fill="${isOn ? INK.text : INK.label}"${isOn ? ' font-weight="500"' : ''}>${esc(t.title)}` +
          (pct ? `<tspan dx="10" font-size="16" font-weight="400" fill="${INK.sub}">${pct}</tspan>` : '') +
          `</text>`
        )
      })
      .join(''),
  )
}

/** A section's gray header bar with its chevron; a transparent Button lies over the chevron. */
export const sectionHeadSvg = (
  id: SectionId,
  title: string,
  count: number | string,
  isOpen: boolean,
  motion?: Motion,
  progress?: { done: number; total: number },
  mark?: readonly string[],
) => {
  const h = 44
  const r = 10
  const bottom = isOpen
    ? `L${W - 0.5},${h} L0.5,${h} Z`
    : `L${W - 0.5},${h - r} Q${W - 0.5},${h - 0.5} ${W - r},${h - 0.5} L${r},${h - 0.5} Q0.5,${h - 0.5} 0.5,${h - r} Z`
  const path = `M0.5,${r} Q0.5,0.5 ${r},0.5 L${W - r},0.5 Q${W - 0.5},0.5 ${W - 0.5},${r} ${bottom}`

  return svg(
    h,
    `<path d="${path}" fill="${INK.head}"/>` +
      chevron(24, 22, isOpen, motion) +
      `<circle cx="59" cy="22" r="6.5" fill="${SECTION_DOT[id]}"/>` +
      `<text x="81" y="29" font-size="19" font-weight="500" fill="${INK.text}">${marked(title, progress ? 540 : 650, 10.4, mark)}` +
      `<tspan dx="12" font-size="18" font-weight="400" fill="${INK.count}">${count}</tspan></text>` +
      (progress ? sectionBar(progress.done, progress.total, id) : ''),
  )
}

/**
 * The section's own progress, right-aligned with the rows' pills below it:
 * a 6 px bar from x 707 to 845 and the percent ending at the ⋯ column.
 */
const sectionBar = (done: number, total: number, id: SectionId) => {
  const share = total === 0 ? 0 : done / total
  const color = id === 'done' || (total > 0 && done === total) ? INK.bar : id === 'working' ? INK.blue : INK.gray
  const w = 138
  const fill = share === 0 ? 0 : Math.max(6, share * w)

  return (
    `<rect x="707" y="19" width="${w}" height="6" rx="3" fill="#e3e5e9"/>` +
    (fill > 0 ? `<rect x="707" y="19" width="${fill.toFixed(1)}" height="6" rx="3" fill="${color}"/>` : '') +
    `<text x="${W - 24}" y="28.5" font-size="16.5" fill="${INK.count}" text-anchor="end">${Math.round(share * 100)}%</text>`
  )
}

/** The card's sides around one row; `isLast` closes it with rounded corners. */
const frame = (h: number, isLast: boolean, sep: boolean) => {
  const r = 10
  const sides = isLast
    ? `<path d="M0.5,0 L0.5,${h - r} Q0.5,${h - 0.5} ${r},${h - 0.5} L${W - r},${h - 0.5} Q${W - 0.5},${h - 0.5} ${W - 0.5},${h - r} L${W - 0.5},0" fill="#fff" stroke="${INK.border}"/>`
    : `<rect x="0" y="0" width="${W}" height="${h}" fill="#fff"/>` +
      `<path d="M0.5,0 L0.5,${h} M${W - 0.5},0 L${W - 0.5},${h}" stroke="${INK.border}"/>`

  return sides + (sep && !isLast ? `<path d="M20,${h - 0.5} L${W - 20},${h - 0.5}" stroke="${INK.sep}"/>` : '')
}

/**
 * The progress ring, read the same way as the row's section: a full green
 * ring when done, a blue arc for the done share (a short one while work has
 * no list yet) when working, the bare track when nothing has started.
 */
const ring = (cx: number, cy: number, c: Counts, section: SectionId) => {
  const r = 8
  const circ = 2 * Math.PI * r
  if (section === 'done' && (c.total === 0 || c.done === c.total)) {
    return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${INK.green}" stroke-width="3.6"/>`
  }
  const share = c.total === 0 ? 0 : c.done / c.total
  const f = section === 'waiting' && share === 0 ? 0 : Math.max(0.12, share)
  if (f === 0) return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${INK.blueTrack}" stroke-width="1.8"/>`

  return (
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${INK.blueTrack}" stroke-width="1.8"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${INK.blue}" stroke-width="1.8" stroke-linecap="round" ` +
    `stroke-dasharray="${(f * circ).toFixed(2)} ${circ.toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`
  )
}

const checkbox = (x: number, y: number, state: 'empty' | 'done' | 'mixed' | 'active') =>
  state === 'mixed'
    ? `<rect x="${x}" y="${y}" width="22" height="22" rx="4" fill="${INK.check}"/>` +
      `<path d="M${x + 6},${y + 11} L${x + 16},${y + 11}" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>`
    : state === 'done'
    ? `<rect x="${x}" y="${y}" width="22" height="22" rx="4" fill="${INK.check}"/>` +
      `<path d="M${x + 5.5},${y + 11.5} L${x + 9.5},${y + 15.5} L${x + 16.5},${y + 7}" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`
    : state === 'active'
      ? `<rect x="${x + 0.75}" y="${y + 0.75}" width="20.5" height="20.5" rx="4" fill="#fff" stroke="${INK.blue}" stroke-width="1.5"/>` +
        `<circle cx="${x + 11}" cy="${y + 11}" r="4" fill="${INK.blue}"/>`
      : `<rect x="${x + 0.75}" y="${y + 0.75}" width="20.5" height="20.5" rx="4" fill="#fff" stroke="${INK.box}" stroke-width="1.5"/>`

/** The right-hand pills: ring with done/total, then the time since the last change. */
const pills = (cy: number, c: Counts, when: string, section: SectionId) =>
  `<rect x="707" y="${cy - 15}" width="92" height="30" rx="15" fill="${INK.pill}"/>` +
  ring(727, cy, c, section) +
  `<text x="774" y="${cy + 6.5}" font-size="19" fill="${INK.text}" text-anchor="middle">${c.done}/${c.total}</text>` +
  `<rect x="803" y="${cy - 15}" width="52" height="30" rx="15" fill="${INK.pill}"/>` +
  `<text x="829" y="${cy + 6.5}" font-size="18" fill="${INK.grayText}" text-anchor="middle">${esc(when || '—')}</text>`

/** One agent (or session) row with its chevron; the ⋯ slot (x 872-905) is left for a Button. */
export const agentRowSvg = (
  cat: Category,
  now: number,
  opts: { isLast: boolean; isOpen: boolean; motion?: Motion; order?: number; when?: string; mark?: readonly string[] },
) => {
  const h = 64
  const c = countTasks(cat.tasks)
  const sub = [cat.kind === 'agent' && cat.agentType ? cat.agentType : '', currentStep(cat)].filter(Boolean).join(' · ')

  return svg(
    h,
    frame(h, opts.isLast && !opts.isOpen, true) +
      reveal(
        chevron(37, 31, opts.isOpen, opts.motion) +
          checkbox(71, 21, rowCheck(cat)) +
          `<text x="120" y="29" font-size="18.5" fill="${INK.text}">${marked(cat.title, 570, 9.6, opts.mark)}</text>` +
          `<text x="120" y="52" font-size="16.5" fill="${INK.sub}">${marked(sub, 560, 8.6, opts.mark)}</text>` +
          pills(32, c, opts.when ?? relTime(cat.updatedAt, now), sectionOf(cat)),
        opts.order,
      ),
  )
}

/** One todo item under an open agent, with the guide line on its left. */
export const taskRowSvg = (
  task: Task,
  now: number,
  opts: { isLast: boolean; isPicked: boolean; order?: number; when?: string; flat?: boolean; mark?: readonly string[] },
) => {
  const h = 36
  const [chip, chipBg, chipText] =
    task.status === 'completed'
      ? ['Done', INK.chipDoneBg, INK.chipDoneText]
      : task.status === 'in_progress'
        ? ['In progress', INK.blueBg, INK.blueText]
        : ['Not started', INK.grayBg, INK.grayText]
  const chipW = 24 + chip.length * 9.2
  const when = task.status === 'completed' ? task.completedAt : (task.startedAt ?? task.createdAt)
  const box = task.status === 'completed' ? 'done' : task.status === 'in_progress' ? 'active' : 'empty'
  const isDone = task.status === 'completed'
  /** A flat row sits right under a section header: no guide line, aligned with the rows' checkboxes. */
  const [boxX, textX] = opts.flat ? [71, 120] : [121, 166]
  const time = opts.when ?? (relTime(when, now) || '—')

  return svg(
    h,
    frame(h, opts.isLast, false) +
      (opts.flat ? '' : `<path d="M77.5,0 L77.5,${opts.isLast ? h - 10 : h}" stroke="${INK.sep}" stroke-width="2"/>`) +
      reveal(
        (opts.isPicked ? `<rect x="64" y="2" width="${W - 84}" height="${h - 4}" rx="6" fill="${INK.blueBg}"/>` : '') +
          checkbox(boxX, 7, box) +
          `<text x="${textX}" y="25" font-size="18" fill="${isDone ? '#555965' : INK.text}">${marked(task.title, 566 - textX + 120, 8.9, opts.mark)}</text>` +
          `<rect x="${792 - chipW}" y="4" width="${chipW}" height="28" rx="14" fill="${chipBg}"/>` +
          `<text x="${792 - chipW / 2}" y="24" font-size="16.5" fill="${chipText}" text-anchor="middle">${chip}</text>` +
          `<text x="829" y="25" font-size="18" fill="${INK.grayText}" text-anchor="middle">${esc(time)}</text>`,
        opts.order,
      ),
  )
}

/** The muted line a section shows when it has nothing in it. */
export const emptyRowSvg = (text: string, opts: { isLast?: boolean; indent?: number; order?: number } = {}) => {
  const h = 48

  return svg(
    h,
    frame(h, opts.isLast ?? true, false) +
      reveal(`<text x="${opts.indent ?? 71}" y="30" font-size="16" fill="${INK.sub}">${esc(text)}</text>`, opts.order),
  )
}
