import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderInput } from 'claude-code'

import type { Category, DocBoard, DocItem, Peer, Snapshot, Task } from '../types'
import {
  MAIN,
  applyTaskCreate,
  applyTaskUpdate,
  applyTodoWrite,
  clock,
  countTasks,
  currentStep,
  duration,
  emptyBoard,
  ensureCategory,
  grouped,
  mergePeers,
  hasCategory,
  relTime,
  ringGlyph,
  setLive,
  summarize,
  rowCheck,
  rowItems,
  bar,
  keepsRow,
  tasksFor,
  SCOPES,
  isScope,
  inProject,
  peerWork,
  scopedPeers,
  syncAgents,
} from './board'
import type { Filter, Scope, SectionId, Summary, TodoItem } from './board'
import { CONFIG_FILE, applyLive, groupAsCategory, itemAsTask, itemsOf, parseConfig, parseDoc, tabPaneId } from './docs'
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
import type { Motion, TabSpec } from './look'
import { INK, PILL_H, PILL_TOP, SCOPE_LABEL, SECTION_DOT, SUMMARY_H, TABS_H, W, scopeLayout, tabsLayout, tabsSvg, agentRowSvg, emptyRowSvg, headerSvg, sectionHeadSvg, summaryPills, summarySvg, taskRowSvg } from './look'

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
/** Where the picked scope is kept past the session, so the next one opens the same way. */
const SCOPE_STORE = 'scope'

/** How long after a toggle its drawing still plays the turn. */
const MOTION_MS = 700
/** The shown pane's width in cells, as its last drawing read it: what sizes the click targets. */
let paneColumns = 80
/**
 * The label of a Button with nothing visible, laid over a share (0..1) of a
 * drawing's width: figure spaces, which neither wrap nor collapse, a little
 * more than fill that share of the pane, so no edge of the cell is left dead.
 */
const hit = (share: number) => '\u2007'.repeat(Math.max(3, Math.ceil(paneColumns * share * 1.5)))
/**
 * The room, in cells, a click target's Button is laid out in: wider than any
 * pane and centered on the target's cell, so the label always fits whole (a desktop cuts a label
 * that does not fit with an ellipsis), while the cell's `overflow="hidden"`
 * clips what spills past its edges, pointer and paint alike.
 */
const HIT_ROOM = 400
/** The width, as a share of a drawn strip, that centers a click target on a chevron drawn at `cx` (of 925). */
const hitWidth = (cx: number) => `${Math.round((2 * cx * 100) / 925)}%`
/** A section's progress: the summed items of its rows. */
const sectionProgress = (cats: readonly Category[]) =>
  cats.map(rowItems).reduce((a, b) => ({ done: a.done + b.done, total: a.total + b.total }), { done: 0, total: 0 })

/** How old a closed session's published board may be and still show. */
const KEEP_MS = 12 * 60 * 60 * 1000

const C = {
  green: '#3fa66b',
  amber: '#d49a1f',
  blue: '#4a8fe7',
  gray: '#8a8a8a',
}

type $ = EngineInterface
type Els = ReturnType<EngineInterface['ui']['resolve']>
type SvgEl = Extract<Els, { Svg: unknown }>['Svg']

const pct = (px: number, of: number) => `${Math.round((px * 100) / of)}%`
const FILTER_ALT: Record<Filter, string> = {
  all: 'all',
  completed: 'completed',
  in_progress: 'in progress',
  pending: 'not started',
}

/** The pane's filter, picked by pressing a status pill; pressing the picked one again goes back to All. */
const pickFilter = ($: $, pane: string, f: Filter) =>
  update($, filters, all => ({ ...all, [pane]: all[pane] === f ? 'all' : f }))

/**
 * Click targets over a drawing: a row laid over it whose boxes take each
 * target's own share of the drawing's width (whole percents, rounded at each
 * edge so the cells add up without drifting) and the band `top`..`top + band` of its height.
 */
const hitRow = (
  els: Els,
  height: number,
  top: number,
  band: number,
  spots: readonly { key: string; x: number; w: number; onPress: () => void }[],
) => {
  const { Box, Button } = els
  const at = (px: number) => Math.round((px * 100) / W)
  let end = 0
  const cells = spots.flatMap(p => {
    const [from, to] = [at(p.x), at(p.x + p.w)]
    const gap = from - end
    end = to

    return [
      <Box key={`gap-${p.key}`} width={`${gap}%`} />,
      <Box key={`spot-${p.key}`} width={`${to - from}%`} overflow="hidden" flexDirection="row" alignItems="center" justifyContent="center">
        <Box width={HIT_ROOM} flexShrink={0} flexDirection="row" alignItems="center" justifyContent="center">
          <Button key={p.key} plain label={hit(p.w / W)} onPress={p.onPress} />
        </Box>
      </Box>,
    ]
  })

  return (
    <Box position="absolute" left={0} right={0} top={0} bottom={0} flexDirection="column">
      <Box height={pct(top, height)} />
      <Box height={pct(band, height)} flexDirection="row">
        {cells}
      </Box>
    </Box>
  )
}

/** The drawn summary card with a click target over each status pill. */
const summaryCard = ($: $, els: Els, Art: SvgEl, pane: string, sum: Summary, filter: Filter) => {
  const { Box } = els

  return (
    <Box marginY={1} flexDirection="column">
      <Art
        source={summarySvg(sum, filter)}
        alt={`${sum.percent}%: ${sum.done} completed, ${sum.inProgress} in progress, ${sum.notStarted} not started. Showing ${FILTER_ALT[filter]}.`}
      />
      {hitRow(
        els,
        SUMMARY_H,
        PILL_TOP,
        PILL_H,
        summaryPills(sum).map(p => ({ key: `filter-${pane}:${p.id}`, x: p.x, w: p.w, onPress: () => void pickFilter($, pane, p.id) })),
      )}
    </Box>
  )
}

/** The board's tabs: each project checklist, then Agents last, each with its percent. */
const tabList = async ($: $): Promise<TabSpec[]> => {
  const sum = summarize(await shownBoard($))
  const live = await read($, liveWork)
  const all = await read($, docs)

  return [
    ...docCtx.tabs.map(tab => {
      const id = tabPaneId(tab)
      const raw = all[id]
      const c = raw && !raw.error ? countTasks(applyLive(raw, live).sections.flatMap(itemsOf).map(itemAsTask(raw.updatedAt))) : undefined

      return { id, title: tab.title, percent: c?.percent }
    }),
    { id: PANE, title: TITLE, percent: sum.total > 0 ? sum.percent : undefined },
  ]
}

/** The desktop tab bar: drawn, with a click target over each tab. */
const tabStrip = ($: $, els: Els, Art: SvgEl, tabs: readonly TabSpec[], active: string, picked: Scope) => {
  const { Box } = els
  // A single tab needs no tab of its own: the bar then holds the scope switch alone.
  const shown = tabs.length > 1 ? tabs : []

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Art
        source={tabsSvg(shown, active, { scopes: SCOPES, picked })}
        alt={`${shown.length > 0 ? `Tabs: ${shown.map(t => (t.id === active ? `${t.title} (shown)` : t.title)).join(', ')}. ` : ''}Showing: ${SCOPE_LABEL[picked]}`}
      />
      {hitRow(els, TABS_H, 0, TABS_H, [
        ...tabsLayout(shown).map(t => ({ key: `tab-${t.id}`, x: t.x, w: t.w, onPress: () => void update($, view, () => t.id) })),
        ...scopeLayout(SCOPES).map(o => ({ key: `scope-${o.id}`, x: o.x, w: o.w, onPress: () => void pickScope($, o.id) })),
      ])}
    </Box>
  )
}

/** The terminal tab bar: a Button per tab, the shown one in brackets. */
const tabRowText = ($: $, els: Els, tabs: readonly TabSpec[], active: string, picked: Scope) => {
  const { Box, Button } = els

  return (
    <Box flexDirection="row" gap={2} marginBottom={1} justifyContent="space-between">
      <Box flexDirection="row" gap={2} flexShrink={1}>
        {(tabs.length > 1 ? tabs : []).map(t => {
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
      <Box flexDirection="row" gap={1} flexShrink={0}>
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
    </Box>
  )
}

/** The terminal's pills: each a Button, the picked one in brackets. */
const summaryPillsText = ($: $, els: Els, pane: string, sum: Summary, filter: Filter) => {
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
    <Box flexDirection="row" gap={2}>
      {one('all', undefined, `All ${sum.total}`)}
      {one('completed', C.green, `${sum.done} completed`)}
      {one('in_progress', C.blue, `${sum.inProgress} in progress`)}
      {one('pending', C.gray, `${sum.notStarted} not started`)}
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

/** The search field under a tab's summary, the width of the board, and a ✕ that clears it. */
const searchBox = ($: $, els: Els, pane: string, query: string) => {
  const { Box, Button } = els
  const Input = 'Input' in els ? els.Input : undefined
  if (!Input) return null
  const set = (value: string) => {
    typed[pane] = value
    void update($, searches, all => ({ ...all, [pane]: value }))
  }

  return (
    <Box key={`search-row-${pane}`} flexDirection="row" alignItems="center" gap={1} width="100%" marginBottom={1}>
      <Box flexGrow={1}>
        <Input
          key={`search-${pane}`}
          placeholder="Search tasks, agents, steps, details…"
          value={typed[pane] === query ? undefined : query}
          submitLabel="search"
          onInput={set}
          onSubmit={set}
        />
      </Box>
      {query !== '' && (
        <Button
          key={`search-clear-${pane}`}
          plain
          label="✕"
          onPress={() => {
            delete typed[pane]
            void update($, searches, all => ({ ...all, [pane]: '' }))
          }}
        />
      )}
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
          <Text key={`hit-${i}`} bold color={INK.hit}>
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
const docCtx = { tabs: [] as DocTab[], seen: {} as Record<string, number>, project: '' }

const DOC_SPAN = 7 * 24 * 60 * 60 * 1000

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

const loadDocConfig = async ($: $) => {
  try {
    docCtx.tabs = parseConfig(await $.fs.read(CONFIG_FILE)).tabs
  } catch {
    docCtx.tabs = []
  }
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

const reread = async ($: $, said: string) => {
  if (said.includes('agent-track.json')) await loadDocConfig($)
  if (said.includes('agent-track.json') || docCtx.tabs.some(t => said.includes(t.file.split('/').pop() ?? t.file))) {
    await refreshDocs($, true)
  }
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
  if (list.join('|') !== was.join('|')) await update($, liveWork, () => list)
}

/** Opens every tab of the board (Agents and the project's), or closes them when any is open. */
const toggleBoard = async ($: $, reload: boolean) => {
  await loadDocConfig($)
  await refreshDocs($, true)
  await closeOldTabs($)
  if (!reload && (await isUp($))) {
    await $.ui.close({ id: PANE })

    return 'Progress board hidden.'
  }
  await update($, dismissed, () => false)
  await $.ui.open({ id: PANE, title: PANE_TITLE })

  return `Progress board shown: ${[...docCtx.tabs.map(t => t.title), TITLE].join(', ')}.`
}

/** Closes the separate pane each project tab had before 1.2.0, when one is still open. */
const closeOldTabs = async ($: $) => {
  const ids = new Set(docCtx.tabs.map(tabPaneId))
  for (const p of await $.ui.panes()) if (ids.has(p.id)) await $.ui.close({ id: p.id })
}

/** The person's name for the greeting, from the plugin's options. */
let userName = ''

const drawAgents = async ($: $, e: RenderInput<'Pane'>) => {
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined

  await read($, tick)
  const now = await $.clock.now()
  const b = await shownBoard($)
  const shut = new Set(await read($, collapsed))
  const pick = await read($, selected)
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
  const shownSections = grouped(b)
    .map(section => ({ ...section, categories: section.categories.filter(keeps) }))
    .filter(section => !isFiltered || section.categories.length > 0)

  const flips = await read($, toggled)
  /** Flips one section or agent; `open` is the state it lands in, so the turn plays only once the flip is drawn. */
  const toggle = async (key: string, open: boolean) => {
    const at = await $.clock.now()
    await update($, toggled, all => ({
      ...Object.fromEntries(Object.entries(all).filter(([, t]) => at - t.at < MOTION_MS)),
      [key]: { at, open },
    }))
    await update($, collapsed, list => (list.includes(key) ? list.filter(k => k !== key) : [...list, key]))
  }
  /** Which way a chevron turns if it was toggled a moment ago; nothing once it has settled. */
  const motionOf = (key: string, isOpen: boolean): Motion => {
    const flip = flips[key]

    return flip && flip.open === isOpen && now - flip.at < MOTION_MS ? (isOpen ? 'open' : 'close') : undefined
  }

  if (Svg) {
    const Art = Svg
    const pickBy = (key: string) => update($, selected, cur => (cur === key ? null : key))
    const sections = shownSections
    const working = grouped(b).find(s => s.id === 'working')?.categories.length ?? 0
    const subtitle =
      working > 0
        ? 'Working on things! I’ll ping you.'
        : sum.total > 0 && sum.done === sum.total
          ? 'All caught up.'
          : 'Nothing running right now.'
    const completions = b.categories.flatMap(c => c.tasks.flatMap(t => (t.completedAt ? [t.completedAt] : [])))

    /** One drawn strip with native controls laid over the slots it leaves blank; unkeyed, so it is no hover scope. */
    const strip = (key: string, source: string, alt: string, left?: JSX.Element, right?: JSX.Element, cx = 37) => (
      <Box flexDirection="column">
        <Art source={source} alt={alt} />
        {left && (
          <Box
            position="absolute"
            left={0}
            top={0}
            bottom={0}
            width={hitWidth(cx)}
            overflow="hidden"
            flexDirection="row"
            alignItems="center"
            justifyContent="center"
          >
            <Box width={HIT_ROOM} flexShrink={0} flexDirection="row" alignItems="center" justifyContent="center">
              {left}
            </Box>
          </Box>
        )}
        {right && (
          <Box position="absolute" right={1} top={0} bottom={0} justifyContent="center">
            {right}
          </Box>
        )}
      </Box>
    )

    const detail = (() => {
      if (!pick) return null
      const [catId, taskId] = pick.split('::')
      const cat = b.categories.find(c => c.id === catId)
      if (!cat) return null
      const task = cat.tasks.find(t => t.id === taskId)
      const c = countTasks(cat.tasks)
      const end = task?.completedAt ?? (task?.status === 'in_progress' ? now : undefined)

      return (
        <Box key="detail" flexDirection="column" borderStyle="round" borderColor={INK.border} paddingX={1} marginTop={1}>
          <Box flexDirection="row" gap={1}>
            <Box flexGrow={1}>
              <Text bold color={INK.text} wrap="truncate-end">
                {task ? task.title : cat.title}
              </Text>
            </Box>
            <Button key="detail-close" role="dismiss" label="Close" onPress={() => update($, selected, () => null)} />
          </Box>
          {task ? (
            <Box flexDirection="column">
              <Text color={INK.sub}>
                {task.status === 'completed' ? 'Done' : task.status === 'in_progress' ? 'In progress' : 'Not started'} · in{' '}
                {cat.title}
              </Text>
              {task.activeForm && task.activeForm !== task.title && <Text color={INK.sub}>Step: {task.activeForm}</Text>}
              {task.description && <Text wrap="wrap">{task.description}</Text>}
              <Text color={INK.sub}>
                Created {clock(task.createdAt)} · Started {clock(task.startedAt)} · Finished {clock(task.completedAt)}
              </Text>
              <Text color={INK.sub}>Time spent {duration(task.startedAt, end)}</Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              <Text color={INK.sub}>{[cat.agentType, cat.note].filter(Boolean).join(' · ') || cat.kind}</Text>
              <Text color={INK.sub}>
                {c.done}/{c.total} tasks · started {clock(cat.startedAt)} · last change {clock(cat.updatedAt)}
              </Text>
              <Text color={INK.sub}>{currentStep(cat)}</Text>
            </Box>
          )}
        </Box>
      )
    })()

    return (
      <Box flexDirection="column">
        <Art source={headerSvg(userName, subtitle, completions, now)} alt={`Welcome back${userName ? `, ${userName}` : ''}. ${subtitle}`} />
        {summaryCard($, els, Art, PANE, sum, filter)}
        {searchBox($, els, PANE, query)}
        {detail}
        {isFiltered && sections.length === 0 && <Art source={emptyRowSvg(nothing)} alt={nothing} />}
        {sections.map(section => {
          const key = sectionKey(section.id)
          const isOpen = !shut.has(key)
          const count = section.categories.length
          const sectionMotion = motionOf(key, isOpen)

          return (
            <Box key={`sec-${section.id}`} flexDirection="column" marginBottom={1}>
              {strip(
                `head-row-${section.id}`,
                sectionHeadSvg(section.id, section.title, count, isOpen, sectionMotion, sectionProgress(section.categories), words),
                `${section.title}, ${count}, ${isOpen ? 'expanded' : 'collapsed'}`,
                <Button key={`head-${section.id}`} plain label={hit(48 / 925)} onPress={() => toggle(key, !isOpen)} />,
                undefined,
                24,
              )}
              {isOpen && count === 0 && (
                <Art source={emptyRowSvg(section.empty, { order: sectionMotion ? 0 : undefined })} alt={section.empty} />
              )}
              {isOpen &&
                section.categories.flatMap((cat, i) => {
                  const fold = foldKey(cat.id)
                  const isExpanded = isRowOpen(cat.id)
                  const tasksShown = shownTasks(cat)
                  const isLast = i === count - 1
                  const foldMotion = motionOf(fold, isExpanded)
                  const row = strip(
                    `agent-${cat.id}`,
                    agentRowSvg(cat, now, {
                      isLast,
                      isOpen: isExpanded,
                      motion: foldMotion,
                      order: sectionMotion === 'open' ? i : undefined,
                      mark: words,
                    }),
                    `${cat.title}: ${currentStep(cat)}, ${isExpanded ? 'expanded' : 'collapsed'}`,
                    <Button key={`fold-${cat.id}`} plain label={hit(74 / 925)} onPress={() => toggle(fold, !isExpanded)} />,
                    <Button key={`more-${cat.id}`} plain label="⋯" onPress={() => pickBy(`${cat.id}::`)} />,
                  )
                  if (!isExpanded) return [row]
                  const reveal = foldMotion === 'open'
                  if (tasksShown.length === 0) {
                    if (isFiltered) return [row]

                    return [
                      row,
                      <Art
                        key={`none-${cat.id}`}
                        source={emptyRowSvg('No tasks yet.', { isLast, indent: 121, order: reveal ? 0 : undefined })}
                        alt="No tasks yet."
                      />,
                    ]
                  }
                  const tasks = tasksShown.map((task, j) =>
                    strip(
                      `row-${cat.id}::${task.id}`,
                      taskRowSvg(task, now, {
                        isLast: isLast && j === tasksShown.length - 1,
                        isPicked: pick === `${cat.id}::${task.id}`,
                        order: reveal ? j : undefined,
                        mark: words,
                      }),
                      `${task.title}: ${task.status}`,
                      undefined,
                      <Button key={`task-${cat.id}::${task.id}`} plain label="⋯" onPress={() => pickBy(`${cat.id}::${task.id}`)} />,
                    ),
                  )

                  return [row, ...tasks]
                })}
            </Box>
          )
        })}
      </Box>
    )
  }

  const ring = (fraction: number, color: string) => <Text color={color}>{ringGlyph(fraction)}</Text>

  const chip = (task: Task) => {
    const [label, color] =
      task.status === 'completed'
        ? ['Done', C.green]
        : task.status === 'in_progress'
          ? ['In progress', C.blue]
          : ['Not started', C.gray]

    return <Text color={color}>{label}</Text>
  }

  const glyph = (task: Task) =>
    task.status === 'completed' ? (
      <Text color={C.green}>✓</Text>
    ) : task.status === 'in_progress' ? (
      <Text color={C.blue}>◐</Text>
    ) : (
      <Text color={C.gray}>○</Text>
    )

  const summary = (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="row" gap={1}>
        <Text bold>{sum.percent}%</Text>
        <Text color={C.green}>{bar(sum.percent / 100, 16)}</Text>
        <Text dimColor>
          {sum.done}/{sum.total} {sum.unit}
        </Text>
      </Box>
      {summaryPillsText($, els, PANE, sum, filter)}
      {searchBox($, els, PANE, query)}
    </Box>
  )

  const taskRow = (cat: Category, task: Task) => {
    const key = `${cat.id}::${task.id}`
    const isPicked = pick === key
    const when = task.status === 'completed' ? task.completedAt : (task.startedAt ?? task.createdAt)

    return (
      <Box key={`row-${key}`} flexDirection="row" gap={1} paddingLeft={4}>
        {glyph(task)}
        <Box flexGrow={1}>
          <Button
            key={`task-${key}`}
            plain
            label={task.title}
            dimColor={task.status === 'completed' && !isPicked}
            onPress={() => update($, selected, cur => (cur === key ? null : key))}
          />
        </Box>
        {chip(task)}
        <Text dimColor>{relTime(when, now)}</Text>
      </Box>
    )
  }

  const agentRow = (cat: Category) => {
    const c = countTasks(cat.tasks)
    const key = foldKey(cat.id)
    const isOpen = isRowOpen(cat.id)
    const live = cat.isLive && !cat.isFinished
    const color = c.total > 0 && c.done === c.total ? C.green : C.blue

    return (
      <Box key={`agent-${cat.id}`} flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Button key={`fold-${cat.id}`} plain label={isOpen ? '▾' : '▸'} onPress={() => toggle(key, !isOpen)} />
          <Text color={rowCheck(cat) === 'empty' ? INK.box : INK.check}>
            {rowCheck(cat) === 'done' ? '☑' : rowCheck(cat) === 'mixed' ? '⊟' : '☐'}
          </Text>
          <Box flexGrow={1}>
            <Text wrap="truncate-end">
              {markedText(els, cat.title, words)}
              {live ? <Text color={C.green}> ●</Text> : ''}
            </Text>
          </Box>
          <Box flexDirection="row" gap={1}>
            {ring(c.total === 0 ? 0 : c.done / c.total, color)}
            <Text>
              {c.done}/{c.total}
            </Text>
            <Text dimColor>{relTime(cat.updatedAt, now) || '—'}</Text>
            <Button key={`more-${cat.id}`} plain label="⋯" onPress={() => update($, selected, cur => (cur === `${cat.id}::` ? null : `${cat.id}::`))} />
          </Box>
        </Box>
        <Box paddingLeft={6}>
          <Text dimColor wrap="truncate-end">
            {cat.agentType && cat.kind === 'agent' ? `${cat.agentType} · ` : ''}
            {currentStep(cat)}
          </Text>
        </Box>
        {isOpen && shownTasks(cat).map(task => taskRow(cat, task))}
      </Box>
    )
  }

  const sections = shownSections.map(section => {
    const key = sectionKey(section.id)
    const isOpen = !shut.has(key)

    return (
      <Box key={`sec-${section.id}`} flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" gap={1}>
          <Button key={`head-${section.id}`} plain label={isOpen ? '▾' : '▸'} onPress={() => toggle(key, !isOpen)} />
          <Text color={SECTION_DOT[section.id]}>●</Text>
          {markedText(els, section.title, words, { bold: true })}
          <Text dimColor>{section.categories.length}</Text>
        </Box>
        {isOpen && section.categories.length === 0 && (
          <Box paddingLeft={2}>
            <Text dimColor>{section.empty}</Text>
          </Box>
        )}
        {isOpen && section.categories.map(agentRow)}
      </Box>
    )
  })

  const detail = (() => {
    if (!pick) return null
    const [catId, taskId] = pick.split('::')
    const cat = b.categories.find(c => c.id === catId)
    const task = cat?.tasks.find(t => t.id === taskId)
    if (!cat) return null
    if (!task) {
      const c = countTasks(cat.tasks)

      return (
        <Box key="detail" flexDirection="column" borderStyle="round" borderColor={C.gray} paddingX={1}>
          <Box flexDirection="row" gap={1}>
            <Box flexGrow={1}>
              <Text bold wrap="truncate-end">
                {cat.title}
              </Text>
            </Box>
            <Button key="detail-close" role="dismiss" label="Close" onPress={() => update($, selected, () => null)} />
          </Box>
          <Text dimColor>{[cat.agentType, cat.note].filter(Boolean).join(' · ') || cat.kind}</Text>
          <Text dimColor>
            {c.done}/{c.total} tasks · started {clock(cat.startedAt)} · last change {clock(cat.updatedAt)}
          </Text>
        </Box>
      )
    }
    const end = task.completedAt ?? (task.status === 'in_progress' ? now : undefined)

    return (
      <Box
        key="detail"
        flexDirection="column"
        borderStyle="round"
        borderColor={C.gray}
        paddingX={1}
      >
        <Box flexDirection="row" gap={1}>
          <Box flexGrow={1}>
            <Text bold wrap="truncate-end">
              {task.title}
            </Text>
          </Box>
          <Button key="detail-close" role="dismiss" label="Close" onPress={() => update($, selected, () => null)} />
        </Box>
        <Box flexDirection="row" gap={1}>
          {chip(task)}
          <Text dimColor>in {cat.title}</Text>
        </Box>
        {task.activeForm && task.activeForm !== task.title && <Text dimColor>Step: {task.activeForm}</Text>}
        {task.description && <Text wrap="wrap">{task.description}</Text>}
        <Text dimColor>
          Created {clock(task.createdAt)} · Started {clock(task.startedAt)} · Finished {clock(task.completedAt)}
        </Text>
        <Text dimColor>Time spent {duration(task.startedAt, end)}</Text>
      </Box>
    )
  })()

  return (
    <Box flexDirection="column">
      {summary}
      {b.categories.length === 0 ? (
        <Text dimColor>No agents have a todo list yet. They show up here as soon as one does.</Text>
      ) : isFiltered && sections.length === 0 ? (
        <Text dimColor>{nothing}</Text>
      ) : (
        sections
      )}
      {detail}
    </Box>
  )
}

/** A project tab: one checklist file in the board's design. */
const drawDoc = async ($: $, e: RenderInput<'Pane'>, pane: string) => {
  const raw = (await read($, docs))[pane]
  if (!raw) return undefined
  const doc = applyLive(raw, await read($, liveWork))
  const els = $.ui.resolve(e)
  const { Box, Text, Button } = els
  const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined

  await read($, tick)
  const now = await $.clock.now()
  const shut = new Set(await read($, collapsed))
  const flips = await read($, toggled)
  const pick = await read($, selected)
  const history = (await read($, docHistory))[pane] ?? []

  const all = doc.sections.flatMap(itemsOf)
  const asTask = itemAsTask(doc.updatedAt)
  const sum = { ...countTasks(all.map(asTask)), unit: 'tasks' as const }
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
  const sectionOpen = (sid: string, state: SectionId) => (isFiltered || state !== 'done') !== shut.has(sectionKey(sid))
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
  const toggle = async (key: string, open: boolean) => {
    const at = await $.clock.now()
    await update($, toggled, list => ({
      ...Object.fromEntries(Object.entries(list).filter(([, t]) => at - t.at < MOTION_MS)),
      [key]: { at, open },
    }))
    await update($, collapsed, list => (list.includes(key) ? list.filter(k => k !== key) : [...list, key]))
  }
  const motionOf = (key: string, isOpen: boolean): Motion => {
    const flip = flips[key]

    return flip && flip.open === isOpen && now - flip.at < MOTION_MS ? (isOpen ? 'open' : 'close') : undefined
  }
  const pickBy = (key: string) => update($, selected, cur => (cur === key ? null : key))
  const picked = pick?.startsWith(`${pane}::`) ? all.find(i => `${pane}::${i.id}` === pick) : undefined
  const subtitle = doc.error ?? `${doc.file} · updated ${relTime(doc.updatedAt, now) || 'just now'}`
  const steps = history.flatMap(([t, d], i) => {
    const prev = history[i - 1]?.[1] ?? d

    return d > prev ? Array.from({ length: Math.min(d - prev, 20) }, () => t) : []
  })

  const detail = picked && (
    <Box key="detail" flexDirection="column" borderStyle="round" borderColor={INK.border} paddingX={1} marginBottom={1}>
      <Box flexDirection="row" gap={1}>
        <Box flexGrow={1}>
          <Text bold wrap="truncate-end">
            {picked.title}
          </Text>
        </Box>
        <Button key="detail-close" role="dismiss" label="Close" onPress={() => update($, selected, () => null)} />
      </Box>
      <Text color={INK.sub}>
        {picked.status === 'completed' ? 'Done' : picked.status === 'in_progress' ? 'In progress' : 'Not started'}
      </Text>
      {picked.detail !== picked.title && <Text wrap="wrap">{picked.detail}</Text>}
    </Box>
  )

  if (Svg) {
    const Art = Svg
    const strip = (source: string, alt: string, left?: JSX.Element, right?: JSX.Element, cx = 37) => (
      <Box flexDirection="column">
        <Art source={source} alt={alt} />
        {left && (
          <Box
            position="absolute"
            left={0}
            top={0}
            bottom={0}
            width={hitWidth(cx)}
            overflow="hidden"
            flexDirection="row"
            alignItems="center"
            justifyContent="center"
          >
            <Box width={HIT_ROOM} flexShrink={0} flexDirection="row" alignItems="center" justifyContent="center">
              {left}
            </Box>
          </Box>
        )}
        {right && (
          <Box position="absolute" right={1} top={0} bottom={0} justifyContent="center">
            {right}
          </Box>
        )}
      </Box>
    )
    const more = (id: string) => (
      <Button key={`item-${pane}::${id}`} plain label="⋯" onPress={() => pickBy(`${pane}::${id}`)} />
    )

    return (
      <Box flexDirection="column">
        <Art source={headerSvg('', subtitle, steps, now, doc.title, DOC_SPAN)} alt={`${doc.title}. ${subtitle}`} />
        {summaryCard($, els, Art, pane, sum, filter)}
        {searchBox($, els, pane, query)}
        {detail}
        {isFiltered && shown.length === 0 && <Art source={emptyRowSvg(nothing)} alt={nothing} />}
        {shown.map(({ section, items: ownItems, groups }) => {
          const items = itemsOf(section)
          const state = stateOf(items, section.isLive)
          const key = sectionKey(section.id)
          const isOpen = sectionOpen(section.id, state)
          const sectionMotion = motionOf(key, isOpen)
          const c = countTasks(items.map(asTask))
          const rows: JSX.Element[] = []
          if (isOpen) {
            ownItems.forEach((item, j) =>
              rows.push(
                strip(
                  taskRowSvg(asTask(item), now, {
                    isLast: groups.length === 0 && j === ownItems.length - 1,
                    isPicked: pick === `${pane}::${item.id}`,
                    order: sectionMotion === 'open' ? j : undefined,
                    when: '',
                    flat: true,
                    mark: words,
                  }),
                  `${item.title}: ${item.status}`,
                  undefined,
                  more(item.id),
                ),
              ),
            )
            groups.forEach(({ group, items: groupItems }, j) => {
              const gkey = groupKey(group.id)
              const gOpen = groupOpen(group.id)
              const gMotion = motionOf(gkey, gOpen)
              const isLast = j === groups.length - 1
              const cat = groupAsCategory(group.id, group.title, group.items, doc.updatedAt, group.isLive)
              const gc = countTasks(cat.tasks)
              rows.push(
                strip(
                  agentRowSvg(cat, now, {
                    isLast,
                    isOpen: gOpen,
                    motion: gMotion,
                    order: sectionMotion === 'open' ? ownItems.length + j : undefined,
                    when: `${gc.percent}%`,
                    mark: words,
                  }),
                  `${group.title}: ${gc.done}/${gc.total}, ${gOpen ? 'expanded' : 'collapsed'}`,
                  <Button key={`group-${pane}:${group.id}`} plain label={hit(74 / 925)} onPress={() => toggle(gkey, !gOpen)} />,
                ),
              )
              if (gOpen) {
                groupItems.forEach((item, k) =>
                  rows.push(
                    strip(
                      taskRowSvg(asTask(item), now, {
                        isLast: isLast && k === groupItems.length - 1,
                        isPicked: pick === `${pane}::${item.id}`,
                        order: gMotion === 'open' ? k : undefined,
                        when: '',
                        mark: words,
                      }),
                      `${item.title}: ${item.status}`,
                      undefined,
                      more(item.id),
                    ),
                  ),
                )
              }
            })
            if (items.length === 0) rows.push(<Art source={emptyRowSvg('No checklist items.')} alt="No checklist items." />)
          }

          return (
            <Box key={`doc-${pane}-${section.id}`} flexDirection="column" marginBottom={1}>
              {strip(
                sectionHeadSvg(state, section.title, `${c.done}/${c.total}`, isOpen, sectionMotion, c, words),
                `${section.title}, ${c.done} of ${c.total} done, ${isOpen ? 'expanded' : 'collapsed'}`,
                <Button key={`head-${pane}:${section.id}`} plain label={hit(48 / 925)} onPress={() => toggle(key, !isOpen)} />,
                undefined,
                24,
              )}
              {rows}
            </Box>
          )
        })}
      </Box>
    )
  }

  const glyph = (status: string) =>
    status === 'completed' ? (
      <Text color={C.green}>☑</Text>
    ) : status === 'in_progress' ? (
      <Text color={C.blue}>◐</Text>
    ) : (
      <Text color={C.gray}>☐</Text>
    )
  const itemRow = (item: DocItem, indent: number) => (
    <Box key={`row-${pane}-${item.id}`} flexDirection="row" gap={1} paddingLeft={indent}>
      {glyph(item.status)}
      <Box flexGrow={1}>
        <Button
          key={`item-${pane}::${item.id}`}
          plain
          label={item.title}
          dimColor={item.status === 'completed'}
          onPress={() => pickBy(`${pane}::${item.id}`)}
        />
      </Box>
    </Box>
  )

  return (
    <Box flexDirection="column">
      <Text bold>{doc.title}</Text>
      <Text dimColor>{subtitle}</Text>
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Text bold>{sum.percent}%</Text>
        <Text color={C.green}>{bar(sum.percent / 100, 16)}</Text>
        <Text dimColor>
          {sum.done}/{sum.total} tasks
        </Text>
      </Box>
      <Box marginBottom={1}>{summaryPillsText($, els, pane, sum, filter)}</Box>
      {searchBox($, els, pane, query)}
      {isFiltered && shown.length === 0 && <Text dimColor>{nothing}</Text>}
      {shown.map(({ section, items: ownItems, groups }) => {
        const items = itemsOf(section)
        const state = stateOf(items, section.isLive)
        const key = sectionKey(section.id)
        const isOpen = sectionOpen(section.id, state)
        const c = countTasks(items.map(asTask))

        return (
          <Box key={`doc-${pane}-${section.id}`} flexDirection="column">
            <Box flexDirection="row" gap={1}>
              <Button
                key={`head-${pane}:${section.id}`}
                plain
                label={isOpen ? '▾' : '▸'}
                onPress={() => toggle(key, !isOpen)}
              />
              <Text color={SECTION_DOT[state]}>●</Text>
              <Box flexGrow={1}>{markedText(els, section.title, words, { bold: true, wrap: 'truncate-end' })}</Box>
              <Text dimColor>
                {c.done}/{c.total}
              </Text>
            </Box>
            {isOpen && ownItems.map(item => itemRow(item, 4))}
            {isOpen &&
              groups.map(({ group, items: groupItems }) => {
                const gkey = groupKey(group.id)
                const gOpen = groupOpen(group.id)
                const gc = countTasks(group.items.map(asTask))

                return (
                  <Box key={`grp-${pane}-${group.id}`} flexDirection="column" paddingLeft={2}>
                    <Box flexDirection="row" gap={1}>
                      <Button
                        key={`group-${pane}:${group.id}`}
                        plain
                        label={gOpen ? '▾' : '▸'}
                        onPress={() => toggle(gkey, !gOpen)}
                      />
                      <Box flexGrow={1}>{markedText(els, group.title, words, { wrap: 'truncate-end' })}</Box>
                      <Text color={gc.done === gc.total ? C.green : C.blue}>
                        {ringGlyph(gc.total ? gc.done / gc.total : 0)}
                      </Text>
                      <Text>
                        {gc.done}/{gc.total}
                      </Text>
                    </Box>
                    {gOpen && groupItems.map(item => itemRow(item, 4))}
                  </Box>
                )
              })}
          </Box>
        )
      })}
      {detail}
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
  <els.Text color={INK.sub}>
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
    await loadDocConfig($)
    await refreshDocs($, true)
    await closeOldTabs($)
    if (docCtx.tabs.length > 0) await autoOpen($)
    // An unload (the next reload) ends its waits: nothing is left to draw then.
    void redrawAfterLoad($).catch(() => undefined)
    $.clock.every(3_000, () => {
      void refreshDocs($)
      void refreshLive($)
    })
    $.clock.every(2_000, () => {
      if (ctx.isSyncing) return
      ctx.isSyncing = true
      void syncRun($).finally(() => {
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
    const sum = summarize(await shownBoard($))
    const live = await read($, liveWork)
    const tabs = Object.entries(await read($, docs)).flatMap(([id, raw]) => {
      const tab = docCtx.tabs.find(t => tabPaneId(t) === id)
      if (!tab || raw.error) return []
      const c = countTasks(applyLive(raw, live).sections.flatMap(itemsOf).map(itemAsTask(raw.updatedAt)))

      return [`${tab.title} ${c.percent}%`]
    })
    const parts = [...tabs, ...(sum.total > 0 ? [`${TITLE} ${sum.percent}%`] : [])]
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
        <Text color={INK.sub} wrap="truncate-end">
          {parts.length > 0 ? parts.join(' · ') : 'No tasks yet'}
        </Text>
      </Box>
    )
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
    await reread($, JSON.stringify(e))

    return ran
  })
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    await reread($, JSON.stringify(e))

    return ran
  })
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    await reread($, JSON.stringify(e))

    return ran
  })
  on('tool.call', { tool: 'PowerShell' }, async ($, e, next) => {
    const ran = await next(e)
    await reread($, JSON.stringify(e))

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

/** The board pane's drawing: the tab bar, and the picked tab below it. */
const drawBoard = async ($: $, e: RenderInput<'Pane'>) => {
  paneColumns = e.props.bodyColumns
  const els = $.ui.resolve(e)
  const { Box, Text } = els
  const Svg = e.surface !== 'terminal' && 'Svg' in els ? els.Svg : undefined
  const tabs = await tabList($)
  const shownTab = await read($, view)
  const active = tabs.find(t => t.id === shownTab) ?? tabs[0]!
  const body =
    active.id === PANE
      ? await drawAgents($, e)
      : ((await drawDoc($, e, active.id)) ?? <Text dimColor>Loading {active.title}…</Text>)
  const picked = await read($, scope)

  return (
    <Box flexDirection="column">
      {Svg ? tabStrip($, els, Svg, tabs, active.id, picked) : tabRowText($, els, tabs, active.id, picked)}
      {body}
    </Box>
  )
}
