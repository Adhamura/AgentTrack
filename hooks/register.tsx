import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { Category, DocBoard, DocItem, DocSection, Peer, Snapshot, Task, TaskStatus } from '../types'
import {
  MAIN,
  ago,
  applyTaskCreate,
  applyTaskUpdate,
  applyTodoWrite,
  countTasks,
  currentStep,
  emptyBoard,
  ensureCategory,
  grouped,
  isBlank,
  mergePeers,
  hasCategory,
  nextStep,
  relTime,
  ringGlyph,
  sectionOf,
  setLive,
  summarize,
  rowItems,
  bar,
  keepsRow,
  taskTimes,
  tasksFor,
  SCOPES,
  isScope,
  inProject,
  peerWork,
  scopedPeers,
  syncAgents,
} from './board'
import type { Filter, Scope, SectionId, Summary, TodoItem } from './board'
import { CONFIG_FILE, NOT_FOUND, applyLive, foundTitle, isChecklist, isTrackerName, countsFor, groupAsCategory, itemAsTask, itemNote, itemsOf, parseConfig, parseDoc, sectionColumns, tabPaneId } from './docs'
import type { DocTab } from './docs'
import {
  REFRESH_MS,
  UPDATE_MS,
  claudeArgv,
  compareVersions,
  findInstalled,
  installedVersion,
  lastLine,
  marketplaceDir,
  offered,
  outcomeText,
  pluginsDirOf,
  runFailure,
  versionOf,
} from './update'
import type { UpdateOutcome } from './update'
import { matches, runs, terms } from './search'
import type { ColumnPlan, Layout, Motion, TabSpec, Tone } from './look'
import {
  EMPTY_H,
  HIT_KEY,
  NOTHING_H,
  NOTHING_LINK_Y,
  PILL_H,
  PILL_TOP,
  ROW_H,
  SCOPE_H,
  SCOPE_LABEL,
  SCOPE_TOP,
  SECTION_H,
  SECTION_TONE,
  STATUS,
  SUMMARY_H,
  TABS_H,
  TASK_H,
  TONE_KEY,
  detailClose,
  detailH,
  detailSvg,
  loadingSvg,
  blankSvg,
  stackSvg,
  emptyRowSvg,
  headerSvg,
  maxColumns,
  nothingSvg,
  tabsHeight,
  textW,
  useScheme,
  layout,
  noticeH,
  noticeSvg,
  planColumns,
  rowSub,
  rowSvg,
  scopeLayout,
  sectionHeadSvg,
  summaryLayout,
  summarySvg,
  tabsLayout,
  tabsSvg,
  taskRowSvg,
  toneOf,
  widthFor,
} from './look'

const PANE = 'agent-track'
const TODO_TOOL = 'mcp__agent-track__todo'
const TITLE = 'Agents'
/** The pane's own title in the app's tab bar; its tabs are drawn inside it. */
const PANE_TITLE = 'Progress'

const board = atom({ plugin: 'agent-track', key: 'board' } as const, emptyBoard())
const collapsed = atom({ plugin: 'agent-track', key: 'collapsed' } as const, [] as string[])
const selected = atom({ plugin: 'agent-track', key: 'selected' } as const, null)
const tick = atom({ plugin: 'agent-track', key: 'tick' } as const, 0)
const dismissed = atom({ plugin: 'agent-track', key: 'dismissed' } as const, false)
const peers = atom({ plugin: 'agent-track', key: 'peers' } as const, [] as Peer[])
const selfName = atom({ plugin: 'agent-track', key: 'selfName' } as const, '')
const docs = atom({ plugin: 'agent-track', key: 'docs' } as const, {} as Record<string, DocBoard>)
const liveWork = atom({ plugin: 'agent-track', key: 'liveWork' } as const, [] as string[])
const docHistory = atom({ plugin: 'agent-track', key: 'docHistory' } as const, {} as Record<string, [number, number][]>)
const toggled = atom({ plugin: 'agent-track', key: 'toggled' } as const, {} as Record<string, { at: number; open: boolean }>)
const view = atom({ plugin: 'agent-track', key: 'view' } as const, PANE as string)
const filters = atom({ plugin: 'agent-track', key: 'filter' } as const, {} as Record<string, Filter>)
const updating = atom({ plugin: 'agent-track', key: 'updating' } as const, false)
const searches = atom({ plugin: 'agent-track', key: 'search' } as const, {} as Record<string, string>)
const scope = atom({ plugin: 'agent-track', key: 'scope' } as const, 'project' as Scope)
/**
 * The Agents tab's percent as the tab bar and the bar above the prompt show
 * it, kept apart from the boards: a checklist tab reads this one number, so
 * it is not drawn again each time any session's board changes.
 */
const agentsPct = atom({ plugin: 'agent-track', key: 'agentsPct' } as const, null as number | null)
/** Where the picked scope is kept past the session, so the next one opens the same way. */
const SCOPE_STORE = 'scope'

/** How long after a toggle its drawing still plays the turn. */
const MOTION_MS = 700
/** The shown pane's width in cells, as its last drawing read it: what sizes the drawings and the click targets. */
let paneColumns = 80
/**
 * The label of a Button with nothing visible, laid over a share (0..1) of a
 * drawing's width: figure spaces, which neither wrap nor collapse, a little
 * more than fill that share of the pane, so no edge of the cell is left dead.
 */
const hit = (share: number) =>
  '\u2007'.repeat(Math.min(HIT_ROOM - 2, Math.max(3, Math.ceil(Math.min(paneColumns, maxColumns()) * share * 1.5))))
/**
 * The room, in cells, a click target's Button is laid out in: wider than any
 * pane and centered on the target's cell, so the label always fits whole (a desktop cuts a label
 * that does not fit with an ellipsis), while the cell's `overflow="hidden"`
 * clips what spills past its edges, pointer and paint alike.
 */
const HIT_ROOM = 400
/** A section's progress: the summed items of its rows. */
const sectionProgress = (cats: readonly Category[]) =>
  cats.map(rowItems).reduce((a, b) => ({ done: a.done + b.done, total: a.total + b.total }), { done: 0, total: 0 })
/** How many finished rows the Done section lists before "Show all". */
const DONE_SHOWN = 5

/** How old a closed session's published board may be and still show. */
const KEEP_MS = 12 * 60 * 60 * 1000

type $ = EngineInterface
type Els = ReturnType<EngineInterface['ui']['resolve']>
type SvgEl = Extract<Els, { Svg: unknown }>['Svg']

const FILTER_ALT: Record<Filter, string> = {
  all: 'all',
  completed: 'done',
  in_progress: 'in progress',
  pending: 'not started',
}

/** The pane's filter, picked by pressing a status pill; pressing the picked one again goes back to All. */
const pickFilter = ($: $, pane: string, f: Filter) =>
  update($, filters, all => ({ ...all, [pane]: all[pane] === f ? 'all' : f }))

/** One click target over a drawing: its share of the drawing's width, in the drawing's own units. */
type Spot = { key: string; x: number; w: number; onPress: () => void }

/**
 * Click targets over a drawing `w` wide: a row laid over it whose boxes take
 * each target's own share of the width (whole percents, rounded at each edge
 * so the cells add up without drifting) and the band `top`..`top + band` of its height.
 */
/** One band of click targets: `top`..`top + band` of a drawing's height. */
type Band = { top: number; band: number; spots: readonly Spot[] }

/**
 * Click targets over a drawing, in ONE layer: each band a row whose boxes take
 * each target's share of the drawing's width (whole percents, edges clamped
 * and increasing so the cells add up to at most 100%). One layer, because a
 * second absolute layer would lie over the first and take its clicks.
 */
const hitBands = (els: Els, w: number, height: number, bands: readonly Band[]) => {
  const { Box, Button } = els
  const at = (px: number) => Math.max(0, Math.min(100, Math.round((px * 100) / w)))
  const pctH = (px: number) => Math.max(0, Math.min(100, Math.round((px * 100) / height)))
  const sorted = [...bands].filter(b => b.spots.length > 0).sort((a, b) => a.top - b.top)
  let usedH = 0
  const rows = sorted.flatMap((b, i) => {
    const top = Math.max(usedH, pctH(b.top))
    const bottom = Math.max(top, Math.min(100, pctH(b.top + b.band)))
    const gapH = top - usedH
    usedH = bottom
    let end = 0
    const cells = b.spots.flatMap(p => {
      const [from, to] = [Math.max(end, at(p.x)), Math.max(end, at(p.x + p.w))]
      const gap = from - end
      end = to

      return [
        ...(gap > 0 ? [<Box key={`gap-${p.key}`} width={`${gap}%`} />] : []),
        <Box key={`spot-${p.key}`} width={`${to - from}%`} overflow="hidden" flexDirection="row" alignItems="center" justifyContent="center">
          <Box width={HIT_ROOM} flexShrink={0} flexDirection="row" alignItems="center" justifyContent="center">
            <Button key={p.key} plain label={hit(p.w / w)} onPress={p.onPress} />
          </Box>
        </Box>,
      ]
    })

    return [
      ...(gapH > 0 ? [<Box key={`band-gap-${i}`} height={`${gapH}%`} />] : []),
      <Box key={`band-${i}`} height={`${bottom - top}%`} flexDirection="row">
        {cells}
      </Box>,
    ]
  })

  return (
    <Box position="absolute" left={0} right={0} top={0} bottom={0} flexDirection="column">
      {rows}
    </Box>
  )
}

/** Click targets in one band of a drawing's height. */
const hitRow = (els: Els, w: number, height: number, top: number, band: number, spots: readonly Spot[]) =>
  hitBands(els, w, height, [{ top, band, spots }])

/** One drawn strip, with click targets over the whole of its height. */
/** The room between two stacked sections. */
const SECTION_GAP = 14
const sectionGap = (lay: Layout): Piece => ({ isPiece: true, svg: blankSvg(lay.w, SECTION_GAP), h: SECTION_GAP, alt: '', spots: [] })

/** One drawn strip waiting to be stacked with its neighbors (`stack`): its drawing, height, words and click targets. */
type Piece = { isPiece: true; svg: string; h: number; alt: string; spots: readonly Spot[] }
const strip = (_els: Els, _Art: SvgEl, _lay: Layout, height: number, source: string, alt: string, spots: readonly Spot[] = []): Piece => ({
  isPiece: true,
  svg: source,
  h: height,
  alt,
  spots,
})
const isPiece = (x: unknown): x is Piece => typeof x === 'object' && x !== null && (x as Piece).isPiece === true

/**
 * The most a stacked drawing grows before a new one starts: its click
 * targets sit at whole percents of its height, so a taller one would let
 * them drift off their rows (about 3 px off at most here).
 */
const STACK_MAX_H = 600

/**
 * Strips and other elements in order, consecutive strips drawn as ONE image
 * with ONE layer of click targets (a band per strip): a long list costs the
 * surface a few images instead of one per row.
 */
const stack = (els: Els, Art: SvgEl, lay: Layout, key: string, items: readonly (Piece | JSX.Element | null | false)[]) => {
  const out: JSX.Element[] = []
  let run: Piece[] = []
  const flush = () => {
    if (run.length === 0) return
    let top = 0
    const bands = run.map(p => {
      const band = { top, band: p.h, spots: p.spots }
      top += p.h

      return band
    })
    out.push(
      <els.Box key={`${key}-stack-${out.length}`} flexDirection="column">
        <Art source={stackSvg(lay.w, run)} alt={run.map(p => p.alt).join(' ')} />
        {bands.some(b => b.spots.length > 0) && hitBands(els, lay.w, top, bands)}
      </els.Box>,
    )
    run = []
  }
  for (const item of items) {
    if (!item) continue
    if (isPiece(item)) {
      if (run.length > 0 && run.reduce((a, p) => a + p.h, 0) + item.h > STACK_MAX_H) flush()
      run.push(item)
    } else {
      flush()
      out.push(item)
    }
  }
  flush()

  return out
}

/** "2 of 4 done": a count as a reader hears it. */
const ofDone = (done: number, total: number) => `${done} of ${total} done`

/** The drawn summary card: a click target over each status pill, and over each scope option when it has the switch. */
const summaryCard = ($: $, els: Els, Art: SvgEl, lay: Layout, pane: string, sum: Summary, filter: Filter, picked?: Scope) => {
  const { Box } = els
  const at = summaryLayout(lay, sum, picked ? SCOPES : undefined)

  return (
    <Box marginY={1} flexDirection="column">
      <Art
        source={summarySvg(lay, sum, filter, sum.unit, picked ? { scopes: SCOPES, picked } : undefined)}
        alt={`${sum.percent}%, ${ofDone(sum.done, sum.total)}: ${sum.inProgress} in progress, ${sum.notStarted} not started. Showing ${FILTER_ALT[filter]}.${picked ? ` Sessions: ${SCOPE_LABEL[picked]}.` : ''}`}
      />
      {hitBands(els, lay.w, SUMMARY_H, [
        {
          top: PILL_TOP,
          band: PILL_H,
          spots: at.pills.map(p => ({ key: `filter-${pane}:${p.id}`, x: p.x, w: p.w, onPress: () => void pickFilter($, pane, p.id) })),
        },
        ...(picked ? [{ top: SCOPE_TOP, band: SCOPE_H, spots: scopeSpots($, at.scope) }] : []),
      ])}
    </Box>
  )
}

const scopeSpots = ($: $, at: readonly { id: Scope; x: number; w: number }[]): Spot[] =>
  at.map(o => ({ key: `scope-${o.id}`, x: o.x, w: o.w, onPress: () => void pickScope($, o.id) }))

/** The board's tabs: each project checklist, then Agents last, each with its percent. */
const tabList = async ($: $): Promise<TabSpec[]> => {
  const pct = await read($, agentsPct)
  await read($, preparedRev)

  return [
    ...docCtx.tabs.map(tab => {
      const id = tabPaneId(tab)
      const p = prepared.get(id)
      const c = p && !p.doc.error ? p.counts : undefined

      return { id, title: tab.title, percent: c?.percent }
    }),
    { id: PANE, title: TITLE, percent: pct ?? undefined },
  ]
}

/** Keeps `agentsPct` in step with the boards; writes only when the number changed. */
const refreshAgentsPct = async ($: $) => {
  const sum = summarize(await shownBoard($))
  const pct = sum.total > 0 ? sum.percent : null
  if (pct !== (await read($, agentsPct))) await update($, agentsPct, () => pct)
}

/** The desktop tab bar: drawn, with a click target over each tab; none when there is one tab. */
const tabStrip = ($: $, els: Els, Art: SvgEl, lay: Layout, tabs: readonly TabSpec[], active: string) => {
  if (tabs.length < 2) return null
  const at = tabsLayout(lay, tabs)
  const height = tabsHeight(lay, tabs)
  const rows = [...new Set(at.map(t => t.y))]

  return (
    <els.Box flexDirection="column">
      <Art source={tabsSvg(lay, tabs, active)} alt={`Tabs: ${tabs.map(t => `${t.title}${t.percent === undefined ? '' : ` ${t.percent}%`}${t.id === active ? ' (shown)' : ''}`).join(', ')}`} />
      {hitBands(
        els,
        lay.w,
        height,
        rows.map(y => ({
          top: y,
          band: TABS_H,
          spots: at.filter(t => t.y === y).map(t => ({ key: `tab-${t.id}`, x: t.x, w: t.w, onPress: () => void update($, view, () => t.id) })),
        })),
      )}
    </els.Box>
  )
}

/** The terminal tab bar: a Button per tab, the shown one in brackets. */
const tabRowText = ($: $, els: Els, tabs: readonly TabSpec[], active: string) => {
  const { Box, Button } = els
  if (tabs.length < 2) return null

  return (
    <Box flexDirection="row" gap={2} marginBottom={1} flexWrap="wrap">
      {tabs.map(t => {
        const label = `${t.title}${t.percent === undefined ? '' : ` ${t.percent}%`}`

        return (
          <Button
            key={`tab-${t.id}`}
            plain
            label={t.id === active ? `[${label}]` : label}
            dimColor={t.id !== active}
            onPress={() => void update($, view, () => t.id)}
          />
        )
      })}
    </Box>
  )
}

/** The terminal scope switch: which sessions the Agents tab shows. */
const scopeRowText = ($: $, els: Els, picked: Scope) => {
  const { Box, Text, Button } = els

  return (
    <Box flexDirection="row" gap={1}>
      <Text dimColor>Sessions:</Text>
      {SCOPES.map(sc => (
        <Button
          key={`scope-${sc}`}
          plain
          label={sc === picked ? `[${SCOPE_LABEL[sc]}]` : SCOPE_LABEL[sc]}
          dimColor={sc !== picked}
          onPress={() => void pickScope($, sc)}
        />
      ))}
    </Box>
  )
}

/** The terminal's summary: percent, bar and count, then the pills, each a Button, the picked one in brackets. */
const summaryText = ($: $, els: Els, pane: string, sum: Summary, filter: Filter, picked?: Scope) => {
  const { Box, Text, Button } = els
  const one = (f: Filter, dot: string | undefined, label: string) => (
    <Box key={`tf-${pane}-${f}`} flexDirection="row" gap={1}>
      {dot && <Text color={dot}>●</Text>}
      <Button
        key={`filter-${pane}:${f}`}
        plain
        label={filter === f ? `[${label}]` : label}
        dimColor={filter !== 'all' && filter !== f}
        onPress={() => pickFilter($, pane, f)}
      />
    </Box>
  )

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row" gap={1} justifyContent="space-between">
        <Box flexDirection="row" gap={1}>
          <Text bold>{sum.percent}%</Text>
          <Text color={TONE_KEY.done}>{bar(sum.percent / 100, 16)}</Text>
          <Text dimColor>{ofDone(sum.done, sum.total)}</Text>
        </Box>
        {picked && scopeRowText($, els, picked)}
      </Box>
      <Box flexDirection="row" gap={2} flexWrap="wrap">
        {one('all', undefined, `All ${sum.total}`)}
        {one('completed', TONE_KEY.done, `${sum.done} done`)}
        {one('in_progress', TONE_KEY.active, `${sum.inProgress} in progress`)}
        {one('pending', TONE_KEY.pending, `${sum.notStarted} not started`)}
      </Box>
    </Box>
  )
}
/**
 * What each tab's search field last reported, so the field is drawn with no
 * `value` while it holds what the person typed (a redraw that lags a keystroke
 * would otherwise put back an older text) and with one when the board changed
 * the query itself: a clear, or a field drawn anew.
 */
const typed: Record<string, string> = {}

/** A tab's search query. */
const searchOf = async ($: $, pane: string) => (await read($, searches))[pane] ?? ''

/** Empties a tab's search. */
const clearSearch = ($: $, pane: string) => {
  delete typed[pane]

  return update($, searches, all => ({ ...all, [pane]: '' }))
}

/** The search field under a tab's summary, the width of the board, with a ✕ inside its trailing edge that clears it. */
const searchBox = ($: $, els: Els, pane: string, query: string, placeholder: string, isDesktop: boolean) => {
  const { Box, Button } = els
  const Input = 'Input' in els ? els.Input : undefined
  if (!Input) return null
  const set = (value: string) => {
    typed[pane] = value
    void update($, searches, all => ({ ...all, [pane]: value }))
  }
  const clear = query !== '' && (
    <Button key={`search-clear-${pane}`} plain label="✕" onPress={() => void clearSearch($, pane)} />
  )

  return (
    <Box key={`search-row-${pane}`} flexDirection="row" alignItems="center" gap={1} width="100%" marginBottom={1}>
      <Box flexGrow={1}>
        <Input
          key={`search-${pane}`}
          placeholder={placeholder}
          value={typed[pane] === query ? undefined : query}
          submitLabel="search"
          onInput={set}
          onSubmit={set}
        />
        {isDesktop && clear && (
          <Box position="absolute" right={1} top={0} bottom={0} flexDirection="row" alignItems="center">
            {clear}
          </Box>
        )}
      </Box>
      {!isDesktop && clear}
    </Box>
  )
}

/** A line of text with the characters the search found drawn bold in the highlight color. */
const markedText = (els: Els, text: string, words: readonly string[], props: Record<string, unknown> = {}) => {
  const { Text } = els

  return (
    <Text {...props}>
      {runs(text, words).map((r, i) =>
        r.isHit ? (
          <Text key={`hit-${i}`} bold color={HIT_KEY}>
            {r.text}
          </Text>
        ) : (
          r.text
        ),
      )}
    </Text>
  )
}

/** What the board says when the status filter and the search leave nothing. */
const nothingText = (filter: Filter, query: string) =>
  query.trim() ? `Nothing matches “${query.trim()}”${filter === 'all' ? '' : ` among ${FILTER_ALT[filter]}`}.` : `Nothing ${FILTER_ALT[filter]}.`

/** The empty result: a whole card saying so, with a line to press that clears the search and the filter. */
const nothingCard = ($: $, els: Els, Art: SvgEl | undefined, lay: Layout, pane: string, text: string) => {
  const { Box, Text, Button } = els
  const clear = () => {
    void clearSearch($, pane)
    void update($, filters, all => ({ ...all, [pane]: 'all' as Filter }))
  }
  if (!Art) {
    return (
      <Box key={`nothing-${pane}`} flexDirection="column" alignItems="flex-start">
        <Text dimColor>{text}</Text>
        <Button key={`clear-${pane}`} plain label="Clear search and filters" onPress={clear} />
      </Box>
    )
  }
  const linkW = Math.ceil(textW('Clear search and filters', 13, 500) * 1.1) + 24

  return (
    <Box key={`nothing-${pane}`} flexDirection="column">
      <Art source={nothingSvg(lay, text)} alt={`${text} Clear search and filters.`} />
      {hitRow(els, lay.w, NOTHING_H, NOTHING_LINK_Y, NOTHING_H - NOTHING_LINK_Y - 6, [{ key: `clear-${pane}`, x: 4, w: linkW, onPress: clear }])}
    </Box>
  )
}

/** Flips one section, row or group; `open` is the state it lands in, so the turn plays only once the flip is drawn. */
const toggleFold = async ($: $, key: string, open: boolean) => {
  const at = await $.clock.now()
  await update($, toggled, all => ({
    ...Object.fromEntries(Object.entries(all).filter(([, t]) => at - t.at < MOTION_MS)),
    [key]: { at, open },
  }))
  await update($, collapsed, list => (list.includes(key) ? list.filter(k => k !== key) : [...list, key]))
}

/** Which way a chevron turns if it was toggled a moment ago; nothing once it has settled. */
const motionFor = (flips: Record<string, { at: number; open: boolean }>, now: number) => (key: string, isOpen: boolean): Motion => {
  const flip = flips[key]

  return flip && flip.open === isOpen && now - flip.at < MOTION_MS ? (isOpen ? 'open' : 'close') : undefined
}

/** Picks a row or task for its details, or puts the details away when it is picked already. */
const pickDetail = ($: $, key: string) => update($, selected, cur => (cur === key ? null : key))

/** What a details box says: its title, its state and where, its text, and lines of facts. */
type Detail = { title: string; status?: TaskStatus; context?: string; body?: string; lines: readonly string[] }

/**
 * The details of what was picked, right under its row: on a desktop drawn
 * inside the card (its sides run on, and it closes the card when it ends it),
 * with a click target over its Close; on the terminal a bordered box.
 */
const detailView = ($: $, els: Els, Art: SvgEl | undefined, lay: Layout, o: Detail, isLast: boolean) => {
  if (!Art) return detailCard($, els, o)
  const lines = o.lines.filter(Boolean)
  const height = detailH(lay, { body: o.body, lines })
  const close = detailClose(lay)

  return (
    <els.Box key="detail" flexDirection="column">
      <Art
        source={detailSvg(lay, { ...o, lines, isLast })}
        alt={[o.title, o.status ? STATUS[o.status].label : '', o.context ?? '', o.body ?? '', ...lines].filter(Boolean).join('. ')}
      />
      {hitRow(els, lay.w, height, close.y, close.h, [
        { key: 'detail-close', x: close.x, w: close.w, onPress: () => void update($, selected, () => null) },
      ])}
    </els.Box>
  )
}

/** The terminal's details box. */
const detailCard = ($: $, els: Els, o: Detail) => {
  const { Box, Text, Button } = els

  return (
    <Box key="detail" flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
      <Box flexDirection="row" gap={1}>
        <Box flexGrow={1} flexShrink={1}>
          <Text bold wrap="truncate-end">
            {o.title}
          </Text>
        </Box>
        <Button key="detail-close" role="dismiss" label="Close" onPress={() => void update($, selected, () => null)} />
      </Box>
      {(o.status || o.context) && (
        <Text wrap="truncate-end">
          {o.status && <Text color={TONE_KEY[STATUS[o.status].tone]}>{STATUS[o.status].label}</Text>}
          {o.context && <Text dimColor>{`${o.status ? ' · ' : ''}${o.context}`}</Text>}
        </Text>
      )}
      {o.body && <Text wrap="wrap">{o.body}</Text>}
      {o.lines.filter(Boolean).map((l, i) => (
        <Text key={`detail-line-${i}`} dimColor wrap="wrap">
          {l}
        </Text>
      ))}
    </Box>
  )
}

/** A terminal label cut to `max` characters with an ellipsis, so a long title never runs into its chip. */
const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(1, max - 1)).trimEnd()}…`)

type Loose = { tool: string; agentId?: string; [k: string]: unknown }

const isUp = async ($: $) => (await $.ui.panes()).some(p => p.id === PANE)

/** Opens the board unasked the first time there is something to show. */
const autoOpen = async ($: $) => {
  if ((await read($, dismissed)) || (await isUp($))) return
  void $.ui.open({ id: PANE, title: PANE_TITLE })
}

/** Makes sure the loop the event ran in has a category, named from the agent list. */
const ensureLoop = async ($: $, agentId: string | undefined, agentType?: string) => {
  const id = agentId ?? MAIN
  const now = await $.clock.now()
  if (id === MAIN) {
    if (!hasCategory(await read($, board), MAIN)) {
      await update($, board, b => ensureCategory(b, MAIN, { title: 'Main session', kind: 'session' }, now))
    }

    return id
  }
  if (hasCategory(await read($, board), id) && agentType === undefined) return id
  const info = (await $.agent.list()).find(a => a.id === id)
  const type = agentType ?? info?.type
  const title = info?.description || info?.name || (type ? `${type} agent` : `Agent ${id.slice(0, 6)}`)
  await update($, board, b =>
    ensureCategory(b, id, { title, kind: 'agent', agentType: type, parentId: info?.parentId }, now),
  )

  return id
}

const taskIdFrom = (text: string | undefined, result: unknown): string | undefined => {
  const r = result as { task?: { id?: unknown }; id?: unknown } | undefined
  const fromResult = r?.task?.id ?? r?.id
  if (typeof fromResult === 'string' || typeof fromResult === 'number') return String(fromResult)

  return text?.match(/#\s?([\w-]+)/)?.[1]
}

type SessionFile = { sessionId?: string; name?: string; cwd?: string; status?: string; updatedAt?: number }

const readJson = async <T,>($: $, path: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return undefined
  }
}

const listJson = async ($: $, dir: string) => {
  try {
    return (await $.fs.list(dir)).filter(f => f.kind === 'file' && f.name.endsWith('.json'))
  } catch {
    return []
  }
}

/**
 * Cross-session sync: every session running this mod writes its board to
 * <claude home>/agent-track/<session id>.json, and reads everyone else's next
 * to the running-session registry (<claude home>/sessions/<pid>.json), which
 * every Claude Code session keeps, mod or not.
 */
const ctx = { home: '', selfId: '', cwd: '', lastWritten: '', lastPeers: '', isSyncing: false }

const syncInit = async ($: $) => {
  const config = await $.env.get('CLAUDE_CONFIG_DIR')
  const base = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  ctx.home = (config ?? `${base}/.claude`).replace(/\\/g, '/')
  ctx.selfId = await $.session.id()
}

const syncRun = async ($: $) => {
  const { home, selfId } = ctx
  if (!home) return
  const now = await $.clock.now()

  const running = new Map<string, SessionFile>()
  for (const f of await listJson($, `${home}/sessions`)) {
    const s = await readJson<SessionFile>($, `${home}/sessions/${f.name}`)
    if (s?.sessionId) running.set(s.sessionId, s)
  }

  const me = running.get(selfId)
  if (me?.cwd) ctx.cwd = me.cwd
  if (me?.name && me.name !== (await read($, selfName))) await update($, selfName, () => me.name ?? '')

  const local = await read($, board)
  if (local.categories.length > 0) {
    const body = JSON.stringify(local)
    if (body !== ctx.lastWritten) {
      const snap: Snapshot = { sessionId: selfId, name: me?.name ?? 'Session', cwd: me?.cwd ?? '', updatedAt: now, board: local }
      await $.fs.write(`${home}/agent-track/${selfId}.json`, JSON.stringify(snap))
      ctx.lastWritten = body
    }
  }

  const published = new Map<string, Snapshot>()
  for (const f of await listJson($, `${home}/agent-track`)) {
    if (now - f.mtimeMs > KEEP_MS) continue
    const snap = await readJson<Snapshot>($, `${home}/agent-track/${f.name}`)
    if (snap?.sessionId && snap.sessionId !== selfId) published.set(snap.sessionId, snap)
  }

  const ids = new Set([...running.keys(), ...published.keys()])
  ids.delete(selfId)
  const list: Peer[] = [...ids].map(id => {
    const live = running.get(id)
    const snap = published.get(id)

    return {
      sessionId: id,
      name: live?.name || snap?.name || `Session ${id.slice(0, 8)}`,
      cwd: live?.cwd ?? snap?.cwd ?? '',
      status: live?.status ?? 'closed',
      isRunning: live !== undefined,
      updatedAt: Math.max(live?.updatedAt ?? 0, snap?.updatedAt ?? 0),
      board: snap?.board,
    }
  })
  list.sort((a, b) => a.sessionId.localeCompare(b.sessionId))
  const key = JSON.stringify(list)
  if (key !== ctx.lastPeers) {
    ctx.lastPeers = key
    await update($, peers, () => list)
  }
}

/** The project's checklist tabs (from CONFIG_FILE) and the last change seen of each file. */
const docCtx = {
  tabs: [] as DocTab[],
  seen: {} as Record<string, number>,
  /** What each tab's file said when last drawn, to skip a redraw when it did not change. */
  bodies: {} as Record<string, string>,
  project: '',
  /** Doc work runs one job at a time, so a timer and a tool's re-read never overlap. */
  queue: Promise.resolve() as Promise<unknown>,
}

/** Runs doc work after the job before it; a failure (or an unload mid-job) never blocks the next, nor escapes. */
const serial = (job: () => Promise<unknown>) => {
  const run = docCtx.queue.then(job, job).catch(() => undefined)
  docCtx.queue = run

  return run
}

const DOC_SPAN = 7 * 24 * 60 * 60 * 1000
/** A checklist longer than this starts with only its sections in progress open. */
const LONG_DOC_ITEMS = 40

/**
 * Each tab's checklist with running work matched in, and its counts, kept
 * per tab until its file or the running work changes: switching tabs and
 * redrawing reuse them instead of matching every line again.
 */
const liveCache = new Map<string, { key: string; doc: DocBoard; counts: ReturnType<typeof countTasks> }>()
const liveDoc = (pane: string, raw: DocBoard, live: readonly string[]) => {
  // The file's time and its lines' names and marks: a cheap fingerprint of what it says.
  const lines = raw.sections.flatMap(itemsOf).map(i => `${i.status[0]}${i.title}`)
  const key = `${raw.updatedAt}|${raw.sections.map(x => x.title).join('|')}|${lines.join('|')}|${live.join('\u0000')}`
  const hit = liveCache.get(pane)
  if (hit?.key === key && hit.doc.title === raw.title) return hit
  const doc = applyLive(raw, live)
  const entry = { key, doc, counts: countTasks(doc.sections.flatMap(itemsOf).map(itemAsTask(raw.updatedAt))) }
  liveCache.set(pane, entry)

  return entry
}

/**
 * Each tab as the board draws it, prepared in the background (`prepareDocs`):
 * its checklist with running work matched in, and its counts. Drawing only
 * reads these, so switching tabs never waits on reading or matching; a tab
 * not prepared yet shows a loading ring.
 */
const prepared = new Map<string, { doc: DocBoard; counts: ReturnType<typeof countTasks> }>()
/** Bumped when a prepared tab changes, so the board draws it; read by the drawings that show prepared tabs. */
const preparedRev = atom({ plugin: 'agent-track', key: 'preparedRev' } as const, 0)
/** When each tab's file last changed while shown, and how many of its lines changed: the green "Updated" line. */
const changed = new Map<string, { at: number; lines: number }>()
/** How long the green "Updated" line stays. */
const CHANGED_MS = 6_000

/** How many lines differ between two versions of a checklist: added, removed, or with a new mark. */
const linesChanged = (before: DocBoard, after: DocBoard) => {
  const marks = (d: DocBoard) => new Map(d.sections.flatMap(itemsOf).map(i => [`${i.id}|${i.title}`, i.status]))
  const [a, b] = [marks(before), marks(after)]
  let n = 0
  for (const [k, v] of b) if (a.get(k) !== v) n++
  for (const k of a.keys()) if (!b.has(k)) n++

  return n
}

/**
 * Prepares every tab whose file or matched work changed since it was last
 * prepared, then has the board drawn once. Runs from the timers and after a
 * re-read, never while drawing.
 */
const prepareDocs = async ($: $) => {
  const all = await read($, docs)
  const live = await read($, liveWork)
  let isChanged = false
  for (const tab of docCtx.tabs) {
    const id = tabPaneId(tab)
    const raw = all[id]
    if (!raw) continue
    const before = prepared.get(id)
    const next = liveDoc(id, raw, live)
    if (before && before.doc === next.doc) continue
    if (before && before.doc.updatedAt !== raw.updatedAt && !raw.error) {
      const lines = linesChanged(before.doc, next.doc)
      if (lines > 0) changed.set(id, { at: await $.clock.now(), lines })
    }
    prepared.set(id, { doc: next.doc, counts: next.counts })
    isChanged = true
  }
  if (!isChanged) return
  await update($, preparedRev, n => n + 1)
  if ([...changed.values()].some(c => c.lines > 0)) void hideChanged($).catch(() => undefined)
}

/** Draws the board again once the green "Updated" lines have had their time. */
const hideChanged = async ($: $) => {
  await $.clock.sleep(CHANGED_MS + 100)
  const now = await $.clock.now()
  for (const [id, c] of changed) if (now - c.at >= CHANGED_MS) changed.delete(id)
  await update($, preparedRev, n => n + 1)
}

/**
 * This session's project folder: as the session registry names it (written
 * the same way as every other session's there), else the one it started in.
 */
const projectDir = () => ctx.cwd || docCtx.project

/** The board as the picked scope shows it: this session's rows, and the other sessions' it takes in. */
const shownBoard = async ($: $) =>
  mergePeers(await read($, board), await read($, selfName), scopedPeers(await read($, scope), await read($, peers), projectDir()))

/** `/agent-track sessions`: every session the sync sees, where it works, and whether the board shows it. */
const sessionsReport = async ($: $) => {
  const picked = await read($, scope)
  const all = await read($, peers)
  const shown = new Set(scopedPeers(picked, all, projectDir()).map(p => p.sessionId))
  const lines = all.map(p => {
    const rows = p.board ? `${p.board.categories.length} rows` : 'no board (Agent Track not loaded there)'
    const where = inProject(p.cwd, projectDir()) ? 'this project' : 'another project'
    return `${shown.has(p.sessionId) ? '●' : '○'} ${p.name}: ${p.isRunning ? p.status : 'closed'}, ${where} (${p.cwd || 'no folder'}), ${rows}`
  })

  return [
    `Showing: ${SCOPE_LABEL[picked]}. This session: ${projectDir() || 'no folder'}.`,
    ...(lines.length > 0 ? lines : ['No other sessions found in ' + `${ctx.home}/sessions` + '.']),
  ].join('\n')
}

/** Picks the scope, and keeps it for the next session. */
const pickScope = async ($: $, picked: Scope) => {
  await update($, scope, () => picked)
  await $.store.set(SCOPE_STORE, picked)
}

/** Where checklists are looked for by shape: the project's folder and its docs folders. */
const FOUND_DIRS = ['.', 'docs', 'doc'] as const

/**
 * The project's Markdown files named as trackers (`isTrackerName`) and shaped
 * like checklists (`isChecklist`) that the config does not list already:
 * each becomes a tab of its own.
 */
const findChecklists = async ($: $, listed: readonly DocTab[], hide: readonly string[] = []): Promise<DocTab[]> => {
  const known = new Set([...listed.map(t => t.file), ...hide].map(f => f.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()))
  const found: DocTab[] = []
  for (const dir of FOUND_DIRS) {
    let entries: Awaited<ReturnType<$['fs']['list']>> = []
    try {
      entries = await $.fs.list(dir)
    } catch {
      continue
    }
    for (const f of entries) {
      if (f.kind !== 'file' || !/\.md$/i.test(f.name) || NOT_FOUND.test(f.name) || !isTrackerName(f.name)) continue
      const file = dir === '.' ? f.name : `${dir}/${f.name}`
      if (known.has(file.toLowerCase())) continue
      try {
        const text = await $.fs.read(file)
        if (isChecklist(text)) found.push({ title: foundTitle(text, file), file, isFound: true })
      } catch {
        // Unreadable: not a tab.
      }
    }
  }

  return found.sort((a, b) => a.title.localeCompare(b.title))
}

const loadDocConfig = async ($: $) => {
  let discover = true
  let hide: string[] = []
  try {
    const config = parseConfig(await $.fs.read(CONFIG_FILE))
    docCtx.tabs = config.tabs
    discover = config.discover
    hide = config.hide
  } catch {
    docCtx.tabs = []
  }
  if (discover) docCtx.tabs = [...docCtx.tabs, ...(await findChecklists($, docCtx.tabs, hide))]
  try {
    docCtx.project = (await $.fs.stat('.', { resolve: true })).realPath ?? ''
  } catch {
    docCtx.project = ''
  }
}

/** Re-reads each tab's file when it changed (or always, with `force`), and keeps its done-count history. */
const refreshDocs = async ($: $, force = false) => {
  for (const tab of docCtx.tabs) {
    const id = tabPaneId(tab)
    let mtime = 0
    try {
      mtime = (await $.fs.stat(tab.file)).mtimeMs
    } catch {
      if (force || docCtx.seen[id] !== -1) {
        docCtx.seen[id] = -1
        await update($, docs, all => ({
          ...all,
          [id]: { title: tab.title, file: tab.file, sections: [], updatedAt: 0, error: `Can't read ${tab.file}` },
        }))
      }
      continue
    }
    if (!force && docCtx.seen[id] === mtime) continue
    docCtx.seen[id] = mtime
    let text = ''
    try {
      text = await $.fs.read(tab.file)
    } catch {
      continue
    }
    const doc = { ...parseDoc(text, tab), updatedAt: mtime }
    // Touched but not changed (a save with the same text): nothing to draw again.
    const body = JSON.stringify(doc.sections) + doc.title
    if (docCtx.bodies[id] === body && !force) continue
    docCtx.bodies[id] = body
    await update($, docs, all => ({ ...all, [id]: doc }))
    const done = doc.sections.flatMap(itemsOf).filter(i => i.status === 'completed').length
    const key = `history:${docCtx.project}|${tab.file}`
    const stored = (await $.store.get(key)) as [number, number][] | undefined
    const past = Array.isArray(stored) ? stored : []
    const last = past[past.length - 1]
    const next = last && last[1] === done ? past : [...past, [mtime, done] as [number, number]].slice(-200)
    if (next !== past) await $.store.set(key, next)
    await update($, docHistory, all => ({ ...all, [id]: next }))
  }
}

/**
 * Re-reads after a tool ran, from what the call names (its file path, or its
 * command), never from the text it wrote: a re-read of the tabs it names,
 * the tab list again when it touched the config or wrote a new tracker file.
 * Unchanged files cost a stat each (`refreshDocs` goes by modified time).
 */
const reread = async ($: $, call: Record<string, unknown>) => {
  const paths = [call.file_path, call.notebook_path, call.path].filter((v): v is string => typeof v === 'string').map(p => p.replace(/\\/g, '/'))
  const said = [...paths, typeof call.command === 'string' ? call.command : ''].join('\n')
  const isConfig = said.includes('agent-track.json')
  const names = (t: DocTab) => said.includes(t.file.split('/').pop() ?? t.file)
  const isNewTracker = paths.some(p => /\.md$/i.test(p) && isTrackerName(p) && !docCtx.tabs.some(t => p.endsWith(t.file)))
  if (!isConfig && !isNewTracker && !docCtx.tabs.some(names)) return
  if (isConfig || isNewTracker) await loadDocConfig($)
  await refreshDocs($, isConfig)
}

/** What runs in this session now: running agents' labels, and the todo items in progress on the board. */
const refreshLive = async ($: $) => {
  const listed = await $.agent.list()
  // Every running agent gets a row, so other sessions see it too: not only the ones that wrote a todo.
  const now = await $.clock.now()
  const before = await read($, board)
  if (syncAgents(before, listed, now) !== before) await update($, board, b => syncAgents(b, listed, now))
  const agents = listed.filter(a => a.status === 'running').flatMap(a => [a.description, a.name ?? ''])
  const b = await read($, board)
  const todos = b.categories
    .filter(c => !c.isFinished)
    .flatMap(c => [
      ...(c.kind === 'agent' && c.isLive ? [c.title] : []),
      ...c.tasks.filter(t => t.status === 'in_progress').flatMap(t => [t.title, t.activeForm ?? '']),
    ])
  // Work running in this project's other sessions counts too, unless the board shows this session alone.
  const others = (await read($, scope)) === 'session' ? [] : peerWork(scopedPeers('project', await read($, peers), projectDir()))
  const list = [...new Set([...agents, ...todos, ...others].map(t => t.trim()).filter(t => t.length > 0))].sort()
  const was = await read($, liveWork)
  if (list.join('|') !== was.join('|')) {
    await update($, liveWork, () => list)
    await serial(() => prepareDocs($))
  }
}

/** Opens every tab of the board (Agents and the project's), or closes them when any is open. */
const toggleBoard = async ($: $, reload: boolean) => {
  if (!reload && (await isUp($))) {
    await $.ui.close({ id: PANE })

    return 'Progress board hidden.'
  }
  await update($, dismissed, () => false)
  // Open at once; the tabs are read and prepared behind it (a tab not ready yet shows a loading ring).
  await $.ui.open({ id: PANE, title: PANE_TITLE })
  void serial(() => reloadDocs($, true))

  return reload ? 'Progress board: reading the tab list again.' : 'Progress board shown.'
}

/** Reads the tab list and every tab's file again, then prepares them for drawing. */
const reloadDocs = async ($: $, force: boolean) => {
  await loadDocConfig($)
  await refreshDocs($, force)
  await closeOldTabs($)
  await prepareDocs($)
}

/** Closes the separate pane each project tab had before 1.2.0, when one is still open. */
const closeOldTabs = async ($: $) => {
  const ids = new Set(docCtx.tabs.map(tabPaneId))
  for (const p of await $.ui.panes()) if (ids.has(p.id)) await $.ui.close({ id: p.id })
}

/** The person's name for the greeting, from the plugin's options. */
let userName = ''

/** What the Agents tab says before there is anything on it. */
const EMPTY_TITLE = 'No tasks yet'
const EMPTY_BODY = 'The board fills in as soon as an agent writes a todo list or a subagent starts.'
const HOUR = 60 * 60 * 1000

/** A row's ring tone: green when all of it is done (or it finished with no list), blue while it works, gray otherwise. */
const rowTone = (cat: Category): Tone => {
  const c = countTasks(cat.tasks)
  if (c.total > 0 && c.done === c.total) return 'done'
  const section = sectionOf(cat)
  if (section === 'done') return c.total === 0 ? 'done' : 'pending'

  return section === 'working' ? 'active' : 'pending'
}

const drawAgents = async ($: $, e: RenderInput<'Pane'>) => {
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined

  await read($, tick)
  const now = await $.clock.now()
  const b = await shownBoard($)
  const shut = new Set(await read($, collapsed))
  const pick = await read($, selected)
  const picked = await read($, scope)
  const sum = summarize(b)
  const filter = (await read($, filters))[PANE] ?? 'all'
  const query = await searchOf($, PANE)
  const words = terms(query)
  const isFiltered = filter !== 'all' || words.length > 0
  /** A row's own texts: a task under it is searched with them, so words may span the row and the task. */
  const rowTexts = (cat: Category) => [cat.title, cat.agentType, cat.note]
  /** The tasks a row shows: the status filter's, and of those the ones the search finds. */
  const shownTasks = (cat: Category) =>
    tasksFor(cat, filter).filter(t => matches([...rowTexts(cat), t.title, t.activeForm, t.description], words))
  /** A row shows when the search finds it (its step line included) or one of its tasks. */
  const keeps = (cat: Category) =>
    keepsRow(cat, filter) &&
    (words.length === 0 || matches([...rowTexts(cat), currentStep(cat)], words) || shownTasks(cat).length > 0)
  const nothing = nothingText(filter, query)
  /** Under a filter or a search sections and rows start open, so the matching tasks show; their own keys flip that. */
  const sectionKey = (id: string) => (isFiltered ? `sf:${id}` : `s:${id}`)
  const foldKey = (id: string) => (isFiltered ? `of:${id}` : `o:${id}`)
  const isRowOpen = (id: string) => shut.has(foldKey(id)) !== isFiltered
  /** Done starts closed (it only grows); the others start open. */
  const sectionOpen = (id: SectionId) => (isFiltered || id !== 'done') !== shut.has(sectionKey(id))
  const showsAll = (id: SectionId) => isFiltered || shut.has(`all:${id}`)
  const shownSections = grouped(b)
    .map(section => ({ ...section, categories: section.categories.filter(keeps) }))
    .filter(section => !isFiltered || section.categories.length > 0)
  /** The rows a section lists: Done its latest few until "Show all". */
  const listed = (id: SectionId, cats: readonly Category[]) => (id === 'done' && !showsAll(id) ? cats.slice(0, DONE_SHOWN) : cats)
  const hasShowAll = (id: SectionId, cats: readonly Category[]) => id === 'done' && !isFiltered && cats.length > DONE_SHOWN
  const showAllPress = (id: SectionId) => () =>
    void update($, collapsed, list => (list.includes(`all:${id}`) ? list.filter(k => k !== `all:${id}`) : [...list, `all:${id}`]))

  const motionOf = motionFor(await read($, toggled), now)
  const toggle = (key: string, open: boolean) => void toggleFold($, key, open)
  const isBlankBoard = isBlank(b) && !isFiltered
  const working = grouped(b).find(s => s.id === 'working')?.categories.length ?? 0
  const agents = grouped(b).find(s => s.id === 'working')?.categories.filter(c => c.kind === 'agent').length ?? 0
  const sessions = working - agents
  /** A status line, not the summary again: who is at work now. */
  const subtitle =
    working === 0
      ? sum.total > 0 && sum.done === sum.total
        ? 'All caught up'
        : 'Nothing running right now'
      : [
          agents > 0 ? `${agents} ${agents === 1 ? 'agent' : 'agents'} working` : '',
          sessions > 0 ? `${sessions} ${sessions === 1 ? 'session' : 'sessions'} busy` : '',
        ]
          .filter(Boolean)
          .join(' · ')
  const heading = userName ? `Welcome back, ${userName}.` : 'Welcome back.'

  /** The details of a picked row, or of a picked task under it. */
  const detailOf = (cat: Category, task?: Task): Detail => {
    if (task) {
      return {
        title: task.title,
        status: task.status,
        context: `in ${cat.title}`,
        body: task.description,
        lines: [task.activeForm && task.activeForm !== task.title ? `Step: ${task.activeForm}` : '', taskTimes(task, now)],
      }
    }
    const c = countTasks(cat.tasks)

    return {
      title: cat.title,
      context: [cat.kind === 'agent' ? (cat.agentType ?? 'Agent') : 'Session', cat.note].filter(Boolean).join(' · '),
      lines: [
        `${c.total > 0 ? `${ofDone(c.done, c.total)} · ` : 'No todo list · '}started ${ago(cat.startedAt, now) || '—'} · last change ${ago(cat.updatedAt, now) || '—'}`,
      ],
    }
  }

  if (Svg) {
    const Art = Svg
    const lay = layout(widthFor(paneColumns))
    const completions = b.categories.flatMap(c => c.tasks.flatMap(t => (t.completedAt ? [t.completedAt] : [])))
    const header = (
      <Art
        source={headerSvg(lay, { heading, subtitle, completions, now, spanMs: HOUR, caption: 'last hour' })}
        alt={`${heading} ${subtitle}`}
      />
    )
    if (isBlankBoard) {
      const noteH = noticeH(lay, EMPTY_BODY, true)

      return (
        <Box flexDirection="column">
          {header}
          <Box marginY={1} flexDirection="column">
            <Art source={noticeSvg(lay, EMPTY_TITLE, EMPTY_BODY, { scopes: SCOPES, picked })} alt={`${EMPTY_TITLE}. ${EMPTY_BODY} Sessions: ${SCOPE_LABEL[picked]}.`} />
            {hitRow(els, lay.w, noteH, SCOPE_TOP, SCOPE_H, scopeSpots($, scopeLayout(lay, SCOPES)))}
          </Box>
        </Box>
      )
    }

    const sections = shownSections.map(section => {
      const key = sectionKey(section.id)
      const isOpen = sectionOpen(section.id)
      const prog = sectionProgress(section.categories)
      const sectionMotion = motionOf(key, isOpen)
      const cats = listed(section.id, section.categories)
      const withShowAll = hasShowAll(section.id, section.categories)
      const rows: (Piece | JSX.Element)[] = []
      if (isOpen && section.categories.length === 0) {
        rows.push(strip(els, Art, lay, EMPTY_H, emptyRowSvg(lay, section.empty, { order: sectionMotion ? 0 : undefined }), section.empty))
      }
      if (isOpen) {
        cats.forEach((cat, i) => {
          const fold = foldKey(cat.id)
          const isExpanded = isRowOpen(cat.id)
          const tasksShown = shownTasks(cat)
          const isLast = i === cats.length - 1 && !withShowAll
          const foldMotion = motionOf(fold, isExpanded)
          const c = rowItems(cat)
          const step = currentStep(cat)
          const live = cat.isLive && !cat.isFinished
          rows.push(
            strip(
              els,
              Art,
              lay,
              ROW_H,
              rowSvg(lay, {
                title: cat.title,
                sub: rowSub(cat, step),
                done: c.done,
                total: c.total,
                tone: rowTone(cat),
                isLive: live,
                isOpen: isExpanded,
                isLast: isLast && pick !== `${cat.id}::`,
                motion: foldMotion,
                order: sectionMotion === 'open' ? i : undefined,
                when: relTime(cat.updatedAt, now),
                hasMore: true,
                mark: words,
              }),
              `${cat.title}${live ? ' (live)' : ''}: ${step}. ${c.total > 0 ? ofDone(c.done, c.total) : 'No todo list'}. ${isExpanded ? 'Expanded' : 'Collapsed'}.`,
              [
                { key: `fold-${cat.id}`, x: 0, w: lay.more.x, onPress: () => toggle(fold, !isExpanded) },
                { key: `more-${cat.id}`, x: lay.more.x, w: lay.w - lay.more.x, onPress: () => void pickDetail($, `${cat.id}::`) },
              ],
            ),
          )
          if (pick === `${cat.id}::`) rows.push(detailView($, els, Art, lay, detailOf(cat), isLast && !isExpanded))
          if (!isExpanded) return
          const isReveal = foldMotion === 'open'
          if (tasksShown.length === 0) {
            if (!isFiltered) {
              rows.push(strip(els, Art, lay, EMPTY_H, emptyRowSvg(lay, 'No tasks yet.', { isLast, indent: lay.taskX, order: isReveal ? 0 : undefined }), 'No tasks yet.'))
            }

            return
          }
          tasksShown.forEach((task, j) => {
            const tkey = `${cat.id}::${task.id}`
            const when = task.status === 'completed' ? task.completedAt : (task.startedAt ?? task.createdAt)
            rows.push(
              strip(
                els,
                Art,
                lay,
                TASK_H,
                taskRowSvg(lay, {
                  title: task.title,
                  status: task.status,
                  isLast: isLast && j === tasksShown.length - 1 && pick !== tkey,
                  isPicked: pick === tkey,
                  order: isReveal ? j : undefined,
                  when: relTime(when, now),
                  mark: words,
                }),
                `${task.title}: ${STATUS[task.status].label}`,
                [{ key: `task-${tkey}`, x: 0, w: lay.w, onPress: () => void pickDetail($, tkey) }],
              ),
            )
            if (pick === tkey) rows.push(detailView($, els, Art, lay, detailOf(cat, task), isLast && j === tasksShown.length - 1))
          })
        })
        if (withShowAll) {
          const label = showsAll(section.id) ? 'Show fewer' : `Show all ${section.categories.length}`
          rows.push(
            strip(els, Art, lay, EMPTY_H, emptyRowSvg(lay, label, { isLast: true, link: true }), label, [
              { key: `show-all-${section.id}`, x: 0, w: lay.w, onPress: showAllPress(section.id) },
            ]),
          )
        }
      }

      return (
        [strip(
            els,
            Art,
            lay,
            SECTION_H,
            sectionHeadSvg(lay, {
              tone: SECTION_TONE[section.id],
              title: section.title,
              done: prog.done,
              total: prog.total,
              isOpen,
              motion: sectionMotion,
              mark: words,
            }),
            `${section.title}: ${section.categories.length} ${section.categories.length === 1 ? 'row' : 'rows'}, ${ofDone(prog.done, prog.total)}. ${isOpen ? 'Expanded' : 'Collapsed'}.`,
            [{ key: `head-${section.id}`, x: 0, w: lay.w, onPress: () => toggle(key, !isOpen) }],
          ),
            ...rows,
          sectionGap(lay),
        ]
      )
    })

    return (
      <Box flexDirection="column">
        {header}
        {summaryCard($, els, Art, lay, PANE, sum, filter, picked)}
        {searchBox($, els, PANE, query, 'Search tasks, agents, steps…', true)}
        {isFiltered && shownSections.length === 0 ? nothingCard($, els, Art, lay, PANE, nothing) : stack(els, Art, lay, 'sections', sections.flat())}
      </Box>
    )
  }

  const cols = paneColumns
  const showChips = cols >= 60

  const taskRow = (cat: Category, task: Task) => {
    const key = `${cat.id}::${task.id}`
    const st = STATUS[task.status]
    const when = task.status === 'completed' ? task.completedAt : (task.startedAt ?? task.createdAt)
    const room = cols - 4 - 2 - (showChips ? st.label.length + 1 : 0) - 5 - 1

    return (
      <Box key={`row-${key}`} flexDirection="column">
        <Box flexDirection="row" gap={1} paddingLeft={4}>
          <Text color={TONE_KEY[st.tone]}>{st.glyph}</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Button
              key={`task-${key}`}
              plain
              label={clip(task.title, room)}
              dimColor={task.status === 'completed' && pick !== key}
              onPress={() => void pickDetail($, key)}
            />
          </Box>
          {showChips && <Text color={TONE_KEY[st.tone]}>{st.label}</Text>}
          <Text dimColor>{(relTime(when, now) || '—').padStart(4)}</Text>
        </Box>
        {pick === key && detailCard($, els, detailOf(cat, task))}
      </Box>
    )
  }

  const agentRow = (cat: Category) => {
    const c = rowItems(cat)
    const key = foldKey(cat.id)
    const isOpen = isRowOpen(cat.id)
    const live = cat.isLive && !cat.isFinished
    const tone = rowTone(cat)

    return (
      <Box key={`agent-${cat.id}`} flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Button key={`fold-${cat.id}`} plain label={isOpen ? '▾' : '▸'} onPress={() => toggle(key, !isOpen)} />
          <Text color={TONE_KEY[tone]}>{ringGlyph(c.total === 0 ? 0 : c.done / c.total)}</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Text wrap="truncate-end">
              {markedText(els, cat.title, words)}
              {live ? <Text color={TONE_KEY.active}> ●</Text> : ''}
            </Text>
          </Box>
          <Text dimColor={c.total === 0}>{c.total === 0 ? '—' : `${c.done}/${c.total}`}</Text>
          <Text dimColor>{(relTime(cat.updatedAt, now) || '—').padStart(4)}</Text>
          <Button key={`more-${cat.id}`} plain label="⋯" onPress={() => void pickDetail($, `${cat.id}::`)} />
        </Box>
        <Box paddingLeft={4}>
          <Text dimColor wrap="truncate-end">
            {rowSub(cat, currentStep(cat))}
          </Text>
        </Box>
        {pick === `${cat.id}::` && detailCard($, els, detailOf(cat))}
        {isOpen && shownTasks(cat).map(task => taskRow(cat, task))}
      </Box>
    )
  }

  const sections = shownSections.map(section => {
    const key = sectionKey(section.id)
    const isOpen = sectionOpen(section.id)
    const prog = sectionProgress(section.categories)
    const cats = listed(section.id, section.categories)

    return (
      <Box key={`sec-${section.id}`} flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" gap={1}>
          <Button key={`head-${section.id}`} plain label={isOpen ? '▾' : '▸'} onPress={() => toggle(key, !isOpen)} />
          <Text color={TONE_KEY[SECTION_TONE[section.id]]}>●</Text>
          {markedText(els, section.title, words, { bold: true })}
          {prog.total > 0 && <Text dimColor>{`${prog.done}/${prog.total}`}</Text>}
        </Box>
        {isOpen && section.categories.length === 0 && (
          <Box paddingLeft={2}>
            <Text dimColor>{section.empty}</Text>
          </Box>
        )}
        {isOpen && cats.map(agentRow)}
        {isOpen && hasShowAll(section.id, section.categories) && (
          <Box paddingLeft={2}>
            <Button
              key={`show-all-${section.id}`}
              plain
              label={showsAll(section.id) ? 'Show fewer' : `Show all ${section.categories.length}`}
              onPress={showAllPress(section.id)}
            />
          </Box>
        )}
      </Box>
    )
  })

  if (isBlankBoard) {
    return (
      <Box flexDirection="column">
        <Text bold>{EMPTY_TITLE}</Text>
        <Text dimColor wrap="wrap">
          {EMPTY_BODY}
        </Text>
        <Box marginTop={1}>{scopeRowText($, els, picked)}</Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      {summaryText($, els, PANE, sum, filter, picked)}
      {searchBox($, els, PANE, query, 'Search tasks, agents, steps…', false)}
      {isFiltered && shownSections.length === 0 ? nothingCard($, els, undefined, layout(widthFor(cols)), PANE, nothing) : sections}
    </Box>
  )
}

/** A checklist line as words: its name, its status, and each part's. */
const itemAlt = (item: DocItem) =>
  `${item.title}: ${STATUS[item.status].label}${item.facets ? `; ${item.facets.map(f => `${f.key} ${f.isDone ? 'done' : 'not done'}`).join(', ')}` : ''}`

/** A project tab: one checklist file in the board's design. */
const drawDoc = async ($: $, e: RenderInput<'Pane'>, pane: string) => {
  await read($, preparedRev)
  const doc = prepared.get(pane)?.doc
  if (!doc) return undefined
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined

  await read($, tick)
  const now = await $.clock.now()
  const shut = new Set(await read($, collapsed))
  const pick = await read($, selected)
  const history = (await read($, docHistory))[pane] ?? []

  const all = doc.sections.flatMap(itemsOf)
  const asTask = itemAsTask(doc.updatedAt)
  const sum = { ...countTasks(all.map(asTask)), unit: 'items' as const }
  const stateOf = (items: readonly DocItem[], isLive = false): SectionId => {
    const c = countTasks(items.map(asTask))
    if (c.total > 0 && c.done === c.total) return 'done'

    return isLive || c.done + c.inProgress > 0 ? 'working' : 'waiting'
  }
  const filter = (await read($, filters))[pane] ?? 'all'
  const query = await searchOf($, pane)
  const words = terms(query)
  const isFiltered = filter !== 'all' || words.length > 0
  /** An item the status filter and the search keep; the search reads the titles above it too, so words may span them. */
  const fits = (above: readonly string[]) => (item: DocItem) =>
    (filter === 'all' || item.status === filter) && matches([...above, item.title, item.detail], words)
  /**
   * Sections start open unless finished; groups start closed. Under a filter
   * both start open, on keys of their own. A key in `collapsed` flips the default.
   */
  const sectionKey = (sid: string) => (isFiltered ? `df:${pane}:${sid}` : `d:${pane}:${sid}`)
  const groupKey = (gid: string) => (isFiltered ? `gf:${pane}:${gid}` : `g:${pane}:${gid}`)
  /**
   * Which sections start open: in a long checklist only the ones where
   * something is in progress, so its first drawing stays small; in a short
   * one every unfinished one. A press flips the default.
   */
  const isLong = all.length > LONG_DOC_ITEMS
  const startsOpen = (state: SectionId, isActive: boolean) => (isLong ? isActive : state !== 'done')
  const sectionOpen = (sid: string, state: SectionId, isActive = false) => (isFiltered || startsOpen(state, isActive)) !== shut.has(sectionKey(sid))
  /** Something in the section runs now: an item in progress, or work matched to its title. */
  const isActiveSection = (section: DocSection) => section.isLive === true || itemsOf(section).some(i => i.status === 'in_progress')
  const groupOpen = (gid: string) => shut.has(groupKey(gid)) !== isFiltered
  /** The sections and groups the filter leaves, each with only its matching items. */
  const shown = doc.sections
    .map(section => ({
      section,
      items: section.items.filter(fits([section.title])),
      groups: section.groups
        .map(g => ({ group: g, items: g.items.filter(fits([section.title, g.title])) }))
        .filter(g => !isFiltered || g.items.length > 0),
    }))
    .filter(v => !isFiltered || v.items.length > 0 || v.groups.length > 0)
  const nothing = nothingText(filter, query)
  const motionOf = motionFor(await read($, toggled), now)
  const toggle = (key: string, open: boolean) => void toggleFold($, key, open)
  const subtitle = doc.error ?? `${doc.file} · updated ${ago(doc.updatedAt, now) || 'just now'}`
  const steps = history.flatMap(([t, d], i) => {
    const prev = history[i - 1]?.[1] ?? d

    return d > prev ? Array.from({ length: Math.min(d - prev, 20) }, () => t) : []
  })
  const itemKey = (item: DocItem) => `${pane}::${item.id}`
  /** The details of a picked line, under it. */
  const itemDetail = (item: DocItem, where: string): Detail => ({
    title: item.title,
    status: item.status,
    context: `in ${where}`,
    body: item.facets ? undefined : itemNote(item),
    lines: [
      item.facets ? `Parts: ${item.facets.map(f => f.label).join(', ')}` : '',
      item.liveBy ? `In progress: matched to running work “${item.liveBy}”` : '',
    ],
  })
  /** Each section's part columns, as one list, and the most lines any of its lists has (what sizes a count). */
  const columnsOfSection = (s: (typeof doc.sections)[number]) => ({
    keys: sectionColumns(s),
    widest: Math.max(1, s.items.length, ...s.groups.map(g => g.items.length)),
  })

  if (Svg) {
    const Art = Svg
    const lay = layout(widthFor(paneColumns), { hasTime: false })
    const itemStrip = (item: DocItem, o: { isLast: boolean; flat?: boolean; order?: number; plan: ColumnPlan }) =>
      strip(
        els,
        Art,
        lay,
        TASK_H,
        taskRowSvg(lay, {
          title: item.title,
          status: item.status,
          isLast: o.isLast && pick !== itemKey(item),
          isPicked: pick === itemKey(item),
          flat: o.flat,
          order: o.order,
          isLive: item.liveBy !== undefined,
          mark: words,
          plan: o.plan,
          facets: item.facets,
        }),
        itemAlt(item),
        [{ key: `item-${itemKey(item)}`, x: 0, w: lay.w, onPress: () => void pickDetail($, itemKey(item)) }],
      )

    return (
      <Box flexDirection="column">
        <Art
          source={headerSvg(lay, { heading: doc.title, subtitle, completions: steps, now, spanMs: DOC_SPAN, caption: 'last 7 days' })}
          alt={`${doc.title}. ${subtitle}`}
        />
        {changedLine(els, pane, now)}
        {summaryCard($, els, Art, lay, pane, sum, filter)}
        {searchBox($, els, pane, query, 'Search items and details…', true)}
        {isFiltered && shown.length === 0 && nothingCard($, els, Art, lay, pane, nothing)}
        {stack(els, Art, lay, `doc-${pane}`, shown.map(({ section, items: ownItems, groups }) => {
          const items = itemsOf(section)
          const state = stateOf(items, section.isLive)
          const key = sectionKey(section.id)
          const isOpen = sectionOpen(section.id, state, isActiveSection(section))
          const sectionMotion = motionOf(key, isOpen)
          const c = countTasks(items.map(asTask))
          const { keys, widest } = columnsOfSection(section)
          const plan = planColumns(lay, keys, widest)
          const ownHasParts = section.items.some(i => i.facets)
          const rows: (Piece | JSX.Element)[] = []
          if (isOpen) {
            ownItems.forEach((item, j) => {
              rows.push(
                itemStrip(item, {
                  isLast: groups.length === 0 && j === ownItems.length - 1,
                  flat: true,
                  order: sectionMotion === 'open' ? j : undefined,
                  plan,
                }),
              )
              if (pick === itemKey(item)) rows.push(detailView($, els, Art, lay, itemDetail(item, section.title), groups.length === 0 && j === ownItems.length - 1))
            })
            groups.forEach(({ group, items: groupItems }, j) => {
              const gkey = groupKey(group.id)
              const gOpen = groupOpen(group.id)
              const gMotion = motionOf(gkey, gOpen)
              const isLast = j === groups.length - 1
              const cat = groupAsCategory(group.id, group.title, group.items, doc.updatedAt, group.isLive)
              const gc = countTasks(cat.tasks)
              const counts = countsFor(group.items, keys)
              const countWords = counts
                .filter(col => col.total > 0)
                .map(col => `${col.key} ${col.done}/${col.total}`)
                .join(' · ')
              rows.push(
                strip(
                  els,
                  Art,
                  lay,
                  ROW_H,
                  rowSvg(lay, {
                    title: group.title,
                    sub: plan.mode === 'compact' && countWords ? countWords : nextStep(cat),
                    done: gc.done,
                    total: gc.total,
                    tone: toneOf(gc.done, gc.total, cat.isLive),
                    isLive: cat.isLive,
                    isOpen: gOpen,
                    isLast,
                    motion: gMotion,
                    order: sectionMotion === 'open' ? ownItems.length + j : undefined,
                    mark: words,
                    plan,
                    columns: counts,
                  }),
                  `${group.title}: ${ofDone(gc.done, gc.total)}${counts
                    .filter(col => col.total > 0)
                    .map(col => `, ${col.key} ${col.done} of ${col.total}`)
                    .join('')}. ${gOpen ? 'Expanded' : 'Collapsed'}.`,
                  [{ key: `group-${pane}:${group.id}`, x: 0, w: lay.w, onPress: () => toggle(gkey, !gOpen) }],
                ),
              )
              if (gOpen) {
                groupItems.forEach((item, k) => {
                  rows.push(itemStrip(item, { isLast: isLast && k === groupItems.length - 1, order: gMotion === 'open' ? k : undefined, plan }))
                  if (pick === itemKey(item)) rows.push(detailView($, els, Art, lay, itemDetail(item, group.title), isLast && k === groupItems.length - 1))
                })
              }
            })
            if (items.length === 0) rows.push(strip(els, Art, lay, EMPTY_H, emptyRowSvg(lay, 'No checklist items.'), 'No checklist items.'))
          }

          return [
              strip(
                els,
                Art,
                lay,
                SECTION_H,
                sectionHeadSvg(lay, {
                  tone: SECTION_TONE[state],
                  title: section.title,
                  done: c.done,
                  total: c.total,
                  isOpen,
                  motion: sectionMotion,
                  mark: words,
                  plan: ownHasParts ? plan : undefined,
                  columns: ownHasParts ? countsFor(section.items, keys) : undefined,
                }),
                `${section.title}: ${ofDone(c.done, c.total)}. ${isOpen ? 'Expanded' : 'Collapsed'}.`,
                [{ key: `head-${pane}:${section.id}`, x: 0, w: lay.w, onPress: () => toggle(key, !isOpen) }],
              ),
                ...rows,
                sectionGap(lay),
              ]
        })
        .flat())}
      </Box>
    )
  }

  const cols = paneColumns
  /** The terminal's part columns for a section: each as wide as its widest count, in the section's order; none when they leave a name too little room. */
  const termColumns = (section: (typeof doc.sections)[number]) => {
    const { keys } = columnsOfSection(section)
    const lists = [section.items, ...section.groups.map(g => g.items)]
    const ws = keys.map(k => Math.max(...lists.map(l => countsFor(l, [k]).map(col => `${k} ${col.done}/${col.total}`.length)[0] ?? 0)) + 1)
    const total = ws.reduce((a, b) => a + b, 0) + ws.length

    return total > cols - 28 ? [] : keys.map((key, i) => ({ key, w: ws[i]! }))
  }
  const itemRow = (item: DocItem, indent: number, columns: readonly { key: string; w: number }[], where: string, tail: number) => {
    const st = STATUS[item.status]
    const room = cols - indent - 2 - columns.reduce((a, c) => a + c.w + 1, 0) - (columns.length > 0 ? tail + 1 : 0) - 1

    return (
      <Box key={`row-${pane}-${item.id}`} flexDirection="column">
        <Box flexDirection="row" gap={1} paddingLeft={indent}>
          <Text color={TONE_KEY[st.tone]}>{st.glyph}</Text>
          <Box flexGrow={1} flexShrink={1}>
            <Button
              key={`item-${itemKey(item)}`}
              plain
              label={`${clip(item.title, room - (item.liveBy ? 2 : 0))}${item.liveBy ? ' ●' : ''}`}
              dimColor={item.status === 'completed' && pick !== itemKey(item)}
              onPress={() => void pickDetail($, itemKey(item))}
            />
          </Box>
          {columns.map(col => {
            const f = item.facets?.find(x => x.key === col.key)

            return (
              <Box key={`facet-${pane}-${item.id}-${col.key}`} width={col.w}>
                <Text color={f ? TONE_KEY[f.isDone ? 'done' : 'pending'] : undefined} dimColor={!f}>
                  {f ? (f.isDone ? '☑' : '☐') : '–'}
                </Text>
              </Box>
            )
          })}
          {columns.length > 0 && <Box width={tail} />}
        </Box>
        {pick === itemKey(item) && detailCard($, els, itemDetail(item, where))}
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Text bold>{doc.title}</Text>
      <Text dimColor>{subtitle}</Text>
      {changedLine(els, pane, now)}
      <Box marginTop={1}>{summaryText($, els, pane, sum, filter)}</Box>
      {searchBox($, els, pane, query, 'Search items and details…', false)}
      {isFiltered && shown.length === 0 && nothingCard($, els, undefined, layout(widthFor(cols)), pane, nothing)}
      {shown.map(({ section, items: ownItems, groups }) => {
        const items = itemsOf(section)
        const state = stateOf(items, section.isLive)
        const key = sectionKey(section.id)
        const isOpen = sectionOpen(section.id, state, isActiveSection(section))
        const c = countTasks(items.map(asTask))
        const columns = termColumns(section)
        /** The done/total at a row's end, as wide on every row, so the part columns line up. */
        const tail = Math.max(`${c.done}/${c.total}`.length, ...section.groups.map(g => `${g.items.length}/${g.items.length}`.length))
        const countCells = (list: readonly DocItem[], prefix: string) =>
          countsFor(list, columns.map(col => col.key)).map((col, i) => (
            <Box key={`count-${prefix}-${col.key}`} width={columns[i]!.w}>
              <Text color={col.total === 0 ? undefined : TONE_KEY[col.done === col.total ? 'done' : 'pending']} dimColor={col.total === 0}>
                {col.total === 0 ? '–' : `${col.key} ${col.done}/${col.total}`}
              </Text>
            </Box>
          ))

        return (
          <Box key={`doc-${pane}-${section.id}`} flexDirection="column" marginBottom={1}>
            <Box flexDirection="row" gap={1}>
              <Button key={`head-${pane}:${section.id}`} plain label={isOpen ? '▾' : '▸'} onPress={() => toggle(key, !isOpen)} />
              <Text color={TONE_KEY[SECTION_TONE[state]]}>●</Text>
              <Box flexGrow={1} flexShrink={1}>
                {markedText(els, section.title, words, { bold: true, wrap: 'truncate-end' })}
              </Box>
              {section.items.some(i => i.facets) && countCells(section.items, `${pane}-${section.id}`)}
              <Box width={tail} justifyContent="flex-end">
                <Text dimColor>
                  {c.done}/{c.total}
                </Text>
              </Box>
            </Box>
            {isOpen && ownItems.map(item => itemRow(item, 4, columns, section.title, tail))}
            {isOpen &&
              groups.map(({ group, items: groupItems }) => {
                const gkey = groupKey(group.id)
                const gOpen = groupOpen(group.id)
                const gc = countTasks(group.items.map(asTask))
                const tone = toneOf(gc.done, gc.total, group.isLive)

                return (
                  <Box key={`grp-${pane}-${group.id}`} flexDirection="column" paddingLeft={2}>
                    <Box flexDirection="row" gap={1}>
                      <Button key={`group-${pane}:${group.id}`} plain label={gOpen ? '▾' : '▸'} onPress={() => toggle(gkey, !gOpen)} />
                      <Text color={TONE_KEY[tone]}>{ringGlyph(gc.total ? gc.done / gc.total : 0)}</Text>
                      <Box flexGrow={1} flexShrink={1}>
                        {markedText(els, group.title, words, { wrap: 'truncate-end' })}
                      </Box>
                      {countCells(group.items, `${pane}-${group.id}`)}
                      <Box width={tail} justifyContent="flex-end">
                        <Text>
                          {gc.done}/{gc.total}
                        </Text>
                      </Box>
                    </Box>
                    {gOpen && groupItems.map(item => itemRow(item, 2, columns, group.title, tail))}
                  </Box>
                )
              })}
          </Box>
        )
      })}
    </Box>
  )
}

/** A file's text, or '' when it cannot be read. */
const readText = async ($: $, path: string): Promise<string> => {
  try {
    const text = await $.fs.read(path)

    return typeof text === 'string' ? text : ''
  } catch {
    return ''
  }
}

/** The version the marketplace's checkout offers: the plugin's own plugin.json there, else its marketplace entry. */
const offeredVersion = async ($: $, dir: string, name: string): Promise<string | undefined> => {
  const entry = offered(await readText($, `${dir}/.claude-plugin/marketplace.json`), name, dir)
  const own = entry.pluginDir ? versionOf(await readText($, `${entry.pluginDir}/.claude-plugin/plugin.json`)) : undefined

  return own ?? entry.version
}

/**
 * Refreshes the marketplace this plugin came from, then updates the plugin
 * from it when it offers a newer version. What is installed and offered is
 * read from Claude Code's own files; the `claude` command line only runs the
 * refresh and the update, with no option a build might lack.
 */
const checkUpdates = async ($: $): Promise<UpdateOutcome> => {
  const root = $.plugin.root
  const plugins = pluginsDirOf(root)
  if (!plugins) return { kind: 'local' }
  const installedFile = `${plugins}/installed_plugins.json`
  const me = findInstalled(await readText($, installedFile), root)
  if (!me) return { kind: 'local' }
  const from = me.version ?? versionOf(await readText($, `${root}/.claude-plugin/plugin.json`))
  try {
    const refreshed = await $.process.run(claudeArgv(root, ['plugin', 'marketplace', 'update', me.marketplace]), { timeoutMs: REFRESH_MS })
    if (refreshed.exitCode !== 0) {
      return { kind: 'failed', reason: lastLine(refreshed.stderr, refreshed.stdout) ?? `could not refresh the ${me.marketplace} marketplace` }
    }
    const dir = marketplaceDir(await readText($, `${plugins}/known_marketplaces.json`), me.marketplace, plugins)
    const latest = await offeredVersion($, dir, me.name)
    if (latest && from && compareVersions(latest, from) <= 0) return { kind: 'current', version: from }
    const scope = me.scope && me.scope !== 'user' ? ['--scope', me.scope] : []
    const updated = await $.process.run(claudeArgv(root, ['plugin', 'update', me.id, ...scope]), { timeoutMs: UPDATE_MS })
    if (updated.exitCode !== 0) return { kind: 'failed', reason: lastLine(updated.stderr, updated.stdout) ?? `could not update ${me.id}` }
    const to = installedVersion(await readText($, installedFile), me.id, me.scope) ?? latest
    if (to && from && compareVersions(to, from) <= 0) return { kind: 'current', version: from }

    return { kind: 'updated', from, to }
  } catch (err) {
    return runFailure(err)
  }
}

/** The built-in command that loads a plugin's new version into the running session. */
const RELOAD_COMMAND = 'reload-plugins'

/** Refreshes the marketplace and updates the plugin from it, once at a time. */
const runCheckUpdates = async ($: $): Promise<UpdateOutcome | undefined> => {
  let wasRunning = false
  await update($, updating, cur => {
    wasRunning = cur

    return true
  })
  if (wasRunning) return undefined
  try {
    return await checkUpdates($)
  } finally {
    await update($, updating, () => false)
  }
}

/** How `/reload-plugins` answers when it cannot run here (a remote connection, an older build). */
const RELOAD_REFUSED = /not available|isn't available|unknown|not found|no such/i

/**
 * Hot-reloads the plugins once an update landed: `/reload-plugins`, queued
 * to run as soon as the session is idle, so the new version replaces this one
 * in the same session. When it cannot run, says so and to reload by hand.
 */
const reloadAfterUpdate = ($: $, outcome: UpdateOutcome) => {
  void $.command.run({ command: RELOAD_COMMAND }).then(
    ran => {
      if (RELOAD_REFUSED.test(ran.text ?? '')) $.ui.toast(`${outcomeText(outcome)} (${ran.text})`)
    },
    () => $.ui.toast(outcomeText(outcome)),
  )
}

/** Check updates, from the button or `/agent-track update`: the outcome as one line, and a reload when it updated. */
const checkAndReload = async ($: $): Promise<string> => {
  const outcome = await runCheckUpdates($)
  if (!outcome) return 'Already checking for updates.'
  if (outcome.kind !== 'updated') return outcomeText(outcome)
  reloadAfterUpdate($, outcome)

  return outcomeText(outcome, true)
}

/** The Check updates button: the outcome as a toast. */
const pressCheckUpdates = async ($: $) => {
  $.ui.toast(await checkAndReload($))
}

/** When the board is drawn again after a load: at once, and again as a slower surface catches up. */
const REDRAW_AFTER_LOAD_MS = [0, 1_500, 5_000] as const

/**
 * Draws a board that stayed open over a reload (Check updates, `/reload-plugins`)
 * again. The pane is the engine's and outlives the module, but a surface may
 * keep waiting for a drawing from the new one ("has not drawn in this pane"):
 * opening it again seats it, and an invalidate asks every surface for one.
 */
const redrawAfterLoad = async ($: $) => {
  if (!(await isUp($))) return
  await $.ui.open({ id: PANE, title: PANE_TITLE }).catch(() => undefined)
  let waited = 0
  for (const at of REDRAW_AFTER_LOAD_MS) {
    if (at > waited) await $.clock.sleep(at - waited)
    waited = at
    $.ui.invalidate('ui.render')
  }
}

/** What the board draws when drawing it failed: the reason, never a blank pane. */
const failedText = (els: Els, err: unknown) => (
  <els.Text dimColor>
    Agent Track could not draw this tab: {err instanceof Error ? err.message : String(err)}. Press ▦ Progress twice to
    open it again.
  </els.Text>
)

export const register: Register = (on, options) => {
  userName = typeof options.name === 'string' ? options.name.trim() : ''

  on('session.start', async ($, e, next) => {
    // A check the last load of this module left running ended with it.
    await update($, updating, () => false)
    await $.command.register({
      name: 'agent-track',
      description: 'Show or hide the live agent progress board',
    })
    await $.tool.register({
      name: 'todo',
      description:
        'Publish your current todo list to the live progress board the person is watching. ' +
        'Send the whole list every time: mark one item in_progress while you work on it and completed when done. ' +
        'Use it when you have no TodoWrite tool, for any multi-step task.',
      inputSchema: {
        type: 'object',
        required: ['todos'],
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              required: ['content', 'status'],
              properties: {
                content: { type: 'string', description: 'The task, imperative: "Run the tests"' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
                activeForm: { type: 'string', description: 'Present tense: "Running the tests"' },
              },
            },
          },
        },
      },
    })
    $.clock.every(30_000, () => void update($, tick, n => n + 1))
    await syncInit($)
    // The session's own row, so it is published (and other sessions list it) before it writes a todo.
    await ensureLoop($, undefined)
    const kept = await $.store.get(SCOPE_STORE)
    if (isScope(kept)) await update($, scope, () => kept)
    await serial(() => reloadDocs($, true))
    // Tabs the project lists open the board; ones only found by shape wait to be asked for.
    if (docCtx.tabs.some(t => !t.isFound)) await autoOpen($)
    // An unload (the next reload) ends its waits: nothing is left to draw then.
    void redrawAfterLoad($).catch(() => undefined)
    $.clock.every(3_000, () => {
      void serial(() => refreshDocs($).then(() => prepareDocs($)))
      void refreshLive($)
    })
    $.clock.every(2_000, () => {
      if (ctx.isSyncing) return
      ctx.isSyncing = true
      void syncRun($)
        .then(() => refreshAgentsPct($))
        .finally(() => {
          ctx.isSyncing = false
        })
    })

    return next(e)
  })

  on('command.run', { command: 'agent-track' }, async ($, e) => {
    const arg = e.args.trim()
    if (arg === 'update') return { text: await checkAndReload($) }
    if (arg === 'sessions') return { text: await sessionsReport($) }

    return { text: await toggleBoard($, arg === 'reload') }
  })

  /** The button above the message box: the board's live percents, and a press opens or closes it. */
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const pct = await read($, agentsPct)
    await read($, preparedRev)
    const tabs = docCtx.tabs.flatMap(tab => {
      const p = prepared.get(tabPaneId(tab))
      if (!p || p.doc.error) return []

      return [`${tab.title} ${p.counts.percent}%`]
    })
    const parts = [...tabs, ...(pct !== null ? [`${TITLE} ${pct}%`] : [])]
    const isUpdating = await read($, updating)

    return (
      <Box flexDirection="row" gap={1} alignItems="center">
        <Button key="board-toggle" plain label="▦ Progress" onPress={() => void toggleBoard($, false)} />
        <Button
          key="check-updates"
          plain
          dimColor={!isUpdating}
          label={isUpdating ? '↻ Checking…' : '↻ Check updates'}
          onPress={() => void pressCheckUpdates($)}
        />
        <Text dimColor wrap="truncate-end">
          {parts.length > 0 ? parts.join(' · ') : 'No tasks yet'}
        </Text>
      </Box>
    )
  })


  /** A new theme redraws the board, so its drawings take the new palette. */
  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const set = await next(e)
    themeSeen = undefined
    $.ui.invalidate('ui.render')

    return set
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE && e.origin.kind === 'person') await update($, dismissed, () => true)
    // The board's search fields are drawn anew when it opens again: give them their queries back.
    if (e.id === PANE) for (const pane of Object.keys(typed)) delete typed[pane]

    return next(e)
  })

  on('classic.SubagentStart', async ($, e, next) => {
    await ensureLoop($, e.agent_id, e.agent_type)
    await autoOpen($)

    return next(e)
  })

  on('classic.SubagentStop', async ($, e, next) => {
    const id = await ensureLoop($, e.agent_id)
    const now = await $.clock.now()
    await update($, board, b => setLive(b, id, false, now))

    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    await ensureLoop($, undefined)
    await update($, board, b => setLive(b, MAIN, true, now))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const id = e.agentId ?? MAIN
    if (hasCategory(await read($, board), id)) {
      const now = await $.clock.now()
      await update($, board, b => setLive(b, id, false, now))
    }

    return next(e)
  })

  /** A tool that writes files and names a tab's file (or the tab list) re-reads it right after it ran. */
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    // In the background: the tool's result goes back to the model at once.
    void serial(() => reread($, e as unknown as Record<string, unknown>).then(() => prepareDocs($)))

    return ran
  })
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    // In the background: the tool's result goes back to the model at once.
    void serial(() => reread($, e as unknown as Record<string, unknown>).then(() => prepareDocs($)))

    return ran
  })
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    // In the background: the tool's result goes back to the model at once.
    void serial(() => reread($, e as unknown as Record<string, unknown>).then(() => prepareDocs($)))

    return ran
  })
  // PowerShell is a Windows tool this build's type table may not list.
  on('tool.call', { tool: 'PowerShell' } as unknown as { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    // In the background: the tool's result goes back to the model at once.
    void serial(() => reread($, e as unknown as Record<string, unknown>).then(() => prepareDocs($)))

    return ran
  })

  on('tool.call', async ($, e, next) => {
    const call = e as unknown as Loose
    const tool = call.tool

    if ((tool === 'TodoWrite' || tool === TODO_TOOL) && Array.isArray(call.todos)) {
      const id = await ensureLoop($, call.agentId)
      const now = await $.clock.now()
      const todos = call.todos as TodoItem[]
      await update($, board, b => applyTodoWrite(b, id, todos, now))
      await autoOpen($)
      if (tool === TODO_TOOL) {
        const text = `Board updated: ${todos.length} items.`

        return { result: text, text }
      }

      return next(e)
    }

    if (tool === 'TaskCreate' && typeof call.subject === 'string') {
      const ran = await next(e)
      if (ran.isError) return ran
      const id = await ensureLoop($, call.agentId)
      const now = await $.clock.now()
      const taskId = taskIdFrom(ran.text, ran.result)
      await update($, board, b =>
        applyTaskCreate(
          b,
          id,
          {
            id: taskId,
            subject: call.subject as string,
            description: call.description as string | undefined,
            activeForm: call.activeForm as string | undefined,
          },
          now,
        ),
      )
      await autoOpen($)

      return ran
    }

    if (tool === 'TaskUpdate' && call.taskId !== undefined) {
      const ran = await next(e)
      if (ran.isError) return ran
      const id = await ensureLoop($, call.agentId)
      const now = await $.clock.now()
      await update($, board, b =>
        applyTaskUpdate(
          b,
          id,
          String(call.taskId),
          {
            status: call.status as string | undefined,
            subject: call.subject as string | undefined,
            description: call.description as string | undefined,
            activeForm: call.activeForm as string | undefined,
          },
          now,
        ),
      )

      return ran
    }

    if (call.agentId !== undefined && !hasCategory(await read($, board), call.agentId)) {
      await ensureLoop($, call.agentId)
    }

    return next(e)
  })

  /** The one board pane: its own tabs (each project checklist, then Agents) and the picked tab below them. */
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    try {
      return await drawBoard($, e)
    } catch (err) {
      return failedText($.ui.resolve(e), err)
    }
  })
}

/** The host's theme setting (`dark`, `light`, `auto`…), when the engine lists it. */
/** The host's theme as last read: read once, and again when the setting changes, never on each drawing. */
let themeSeen: { value: unknown } | undefined
const hostTheme = async ($: $) => {
  if (themeSeen) return themeSeen.value
  try {
    themeSeen = { value: (await $.config.list()).find(row => row.key === 'theme')?.value }
  } catch {
    themeSeen = { value: undefined }
  }

  return themeSeen.value
}

/** A tab still being prepared: a turning ring in the middle, and what it waits for. */
const loadingView = (els: Els, Art: SvgEl | undefined, title: string) => {
  const label = `Preparing ${title}…`

  return Art ? (
    <Art key="loading" source={loadingSvg(layout(widthFor(paneColumns)), label)} alt={label} />
  ) : (
    <els.Box key="loading" justifyContent="center" paddingY={1}>
      <els.Text dimColor>◌ {label}</els.Text>
    </els.Box>
  )
}

/** The green line a tab shows for a few seconds after its file changed. */
const changedLine = (els: Els, pane: string, now: number) => {
  const c = changed.get(pane)
  if (!c || now - c.at >= CHANGED_MS) return null

  return (
    <els.Box key={`changed-${pane}`} justifyContent="center" marginTop={1}>
      <els.Text color="success">
        ✓ Updated from the file · {c.lines} {c.lines === 1 ? 'line' : 'lines'} changed
      </els.Text>
    </els.Box>
  )
}

/** The board pane's drawing: the tab bar, and the picked tab below it. */
const drawBoard = async ($: $, e: RenderInput<'Pane'>) => {
  paneColumns = e.props.bodyColumns
  if (e.surface !== 'terminal') useScheme(await hostTheme($))
  const els = $.ui.resolve(e)
  const { Box, Text } = els
  const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
  const tabs = await tabList($)
  const shownTab = await read($, view)
  const active = tabs.find(t => t.id === shownTab) ?? tabs[0]!
  const body =
    active.id === PANE
      ? await drawAgents($, e)
      : ((await drawDoc($, e, active.id)) ?? loadingView(els, Svg, active.title))

  return (
    <Box flexDirection="column" width={Svg ? Math.min(paneColumns, maxColumns()) : undefined}>
      {Svg ? tabStrip($, els, Svg, layout(widthFor(paneColumns)), tabs, active.id) : tabRowText($, els, tabs, active.id)}
      {body}
    </Box>
  )
}
