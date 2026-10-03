import type { Board, Category, Peer, Task, TaskStatus } from '../types'

export const MAIN = 'main'

export const emptyBoard = (): Board => ({ seq: 0, categories: [] })

export type TodoItem = { content: string; status: string; activeForm?: string }

export type Meta = {
  title: string
  kind: Category['kind']
  agentType?: string
  parentId?: string
}

const asStatus = (s: string): TaskStatus =>
  s === 'completed' || s === 'in_progress' ? s : 'pending'

const withCategory = (
  board: Board,
  id: string,
  now: number,
  fn: (cat: Category) => Category,
  meta?: Meta,
): Board => {
  const found = board.categories.find(c => c.id === id)
  const base: Category = found ?? {
    id,
    title: meta?.title ?? (id === MAIN ? 'Main session' : `Agent ${id.slice(0, 6)}`),
    kind: meta?.kind ?? (id === MAIN ? 'session' : 'agent'),
    agentType: meta?.agentType,
    parentId: meta?.parentId,
    isLive: id !== MAIN,
    isFinished: false,
    startedAt: now,
    updatedAt: now,
    tasks: [],
  }
  const next = { ...fn(base), updatedAt: now }

  return {
    ...board,
    categories: found
      ? board.categories.map(c => (c.id === id ? next : c))
      : [...board.categories, next],
  }
}

export const ensureCategory = (board: Board, id: string, meta: Meta, now: number): Board =>
  withCategory(
    board,
    id,
    now,
    cat => ({
      ...cat,
      title: meta.title || cat.title,
      agentType: meta.agentType ?? cat.agentType,
      parentId: meta.parentId ?? cat.parentId,
    }),
    meta,
  )

export const hasCategory = (board: Board, id: string) => board.categories.some(c => c.id === id)

export const setLive = (board: Board, id: string, isLive: boolean, now: number): Board =>
  withCategory(board, id, now, cat => ({
    ...cat,
    isLive,
    isFinished: cat.kind === 'agent' && !isLive ? true : cat.isFinished,
  }))

const stamp = (task: Task, status: TaskStatus, now: number): Task => ({
  ...task,
  status,
  updatedAt: status === task.status ? task.updatedAt : now,
  startedAt: status === 'in_progress' ? (task.startedAt ?? now) : task.startedAt,
  completedAt: status === 'completed' ? (task.completedAt ?? now) : undefined,
})

/** TodoWrite replaces the whole list; items keep their times by matching text. */
export const applyTodoWrite = (board: Board, catId: string, todos: readonly TodoItem[], now: number): Board => {
  let seq = board.seq
  const next = withCategory(board, catId, now, cat => {
    const pool = [...cat.tasks]
    const tasks = todos.map(todo => {
      const at = pool.findIndex(t => t.title === todo.content)
      const old = at >= 0 ? pool.splice(at, 1)[0] : undefined
      const base: Task = old ?? {
        id: `t${++seq}`,
        title: todo.content,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      }

      return stamp({ ...base, activeForm: todo.activeForm }, asStatus(todo.status), now)
    })

    return { ...cat, tasks }
  })

  return { ...next, seq }
}

export const applyTaskCreate = (
  board: Board,
  catId: string,
  task: { id?: string; subject: string; description?: string; activeForm?: string },
  now: number,
): Board => {
  const seq = board.seq + 1
  const id = task.id ?? `t${seq}`

  return {
    ...withCategory(board, catId, now, cat => ({
      ...cat,
      tasks: [
        ...cat.tasks.filter(t => t.id !== id),
        {
          id,
          title: task.subject,
          description: task.description,
          activeForm: task.activeForm,
          status: 'pending',
          createdAt: now,
          updatedAt: now,
        },
      ],
    })),
    seq,
  }
}

export const applyTaskUpdate = (
  board: Board,
  catId: string,
  id: string,
  patch: { status?: string; subject?: string; description?: string; activeForm?: string },
  now: number,
): Board =>
  withCategory(board, catId, now, cat => ({
    ...cat,
    tasks:
      patch.status === 'deleted'
        ? cat.tasks.filter(t => t.id !== id)
        : cat.tasks.map(t =>
            t.id !== id
              ? t
              : stamp(
                  {
                    ...t,
                    title: patch.subject ?? t.title,
                    description: patch.description ?? t.description,
                    activeForm: patch.activeForm ?? t.activeForm,
                  },
                  patch.status ? asStatus(patch.status) : t.status,
                  now,
                ),
          ),
  }))

export type Counts = { total: number; done: number; inProgress: number; notStarted: number; percent: number }

export const countTasks = (tasks: readonly Task[]): Counts => {
  const done = tasks.filter(t => t.status === 'completed').length
  const inProgress = tasks.filter(t => t.status === 'in_progress').length
  const total = tasks.length

  return {
    total,
    done,
    inProgress,
    notStarted: total - done - inProgress,
    percent: total === 0 ? 0 : Math.round((done / total) * 100),
  }
}

export type Summary = Counts & { unit: 'items' }

const add = (a: Counts, b: Omit<Counts, 'percent'>) => ({
  total: a.total + b.total,
  done: a.done + b.done,
  inProgress: a.inProgress + b.inProgress,
  notStarted: a.notStarted + b.notStarted,
  percent: 0,
})

/**
 * What one row adds to the summary: its tasks. A row with no todo list (an
 * idle session, an agent that keeps none) adds nothing; it shows a dash.
 */
export const rowItems = (cat: Category): Omit<Counts, 'percent'> => countTasks(cat.tasks)

/**
 * This session's own row before it wrote a todo list: not an item of work
 * yet, so it adds nothing to the counts (another session's row says where it
 * runs in its note, and an agent's row is work under way).
 */
export const isBare = (cat: Category) => cat.tasks.length === 0 && cat.kind === 'session' && !cat.note

/** A board with nothing on it yet but this session's bare row: the board shows its empty state. */
export const isBlank = (board: Board) => board.categories.every(isBare)

/** The header's numbers, counted from exactly the rows the board shows; one unit, items, on every tab. */
export const summarize = (board: Board): Summary => {
  const sum = board.categories.reduce((acc, cat) => add(acc, rowItems(cat)), countTasks([]))

  return {
    ...sum,
    percent: sum.total === 0 ? 0 : Math.round((sum.done / sum.total) * 100),
    unit: 'items',
  }
}

/** A row's checkbox: checked when all of it is done, a dash when part is, empty otherwise. */
export const rowCheck = (cat: Category): 'done' | 'mixed' | 'empty' => {
  const c = rowItems(cat)
  if (c.total > 0 && c.done === c.total) return 'done'

  return c.done > 0 ? 'mixed' : 'empty'
}

export type SectionId = 'working' | 'waiting' | 'done'

export const SECTIONS: readonly { id: SectionId; title: string; empty: string }[] = [
  { id: 'working', title: 'Working', empty: 'No agent is working right now.' },
  { id: 'waiting', title: 'Idle', empty: 'No idle sessions.' },
  { id: 'done', title: 'Done', empty: 'Finished agents land here.' },
]

export const sectionOf = (cat: Category): SectionId => {
  const c = countTasks(cat.tasks)
  if (c.total > 0 && c.done === c.total) return 'done'
  if (cat.isFinished) return 'done'
  if (cat.isLive || c.inProgress > 0) return 'working'
  if (c.done > 0) return 'working'

  return 'waiting'
}

/** Which status the summary's pills narrow the board to; `all` shows everything. */
export type Filter = 'all' | TaskStatus

export const FILTERS: readonly Filter[] = ['all', 'completed', 'in_progress', 'pending']

/** The status a row without a todo list stands for: the state its section shows. */
const rowStatus = (cat: Category): TaskStatus => {
  const section = sectionOf(cat)

  return section === 'done' ? 'completed' : section === 'working' ? 'in_progress' : 'pending'
}

/** Whether a row stays on the board under the filter: it has a matching task, or is itself in that state. */
export const keepsRow = (cat: Category, filter: Filter) =>
  filter === 'all' || (cat.tasks.length > 0 ? cat.tasks.some(t => t.status === filter) : rowStatus(cat) === filter)

/** The tasks a row shows under the filter. */
export const tasksFor = (cat: Category, filter: Filter) =>
  filter === 'all' ? cat.tasks : cat.tasks.filter(t => t.status === filter)

export const grouped = (board: Board) =>
  SECTIONS.map(section => ({
    ...section,
    categories: board.categories
      .filter(cat => sectionOf(cat) === section.id)
      .sort((a, b) => b.updatedAt - a.updatedAt),
  }))

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/**
 * This session's board plus every other session's: a peer that publishes its
 * board brings its categories (prefixed with its name), one that does not is
 * a single row with its running state.
 */
export const mergePeers = (local: Board, selfName: string, peers: readonly Peer[]): Board => {
  const own = local.categories.map(cat => (cat.id === MAIN && selfName ? { ...cat, title: selfName } : cat))
  const remote = peers.flatMap((peer): Category[] => {
    const where = baseName(peer.cwd)
    if (peer.board && peer.board.categories.length > 0) {
      return peer.board.categories.map(cat => ({
        ...cat,
        id: `${peer.sessionId}~${cat.id}`,
        title: cat.kind === 'session' ? peer.name : `${peer.name} › ${cat.title}`,
        isLive: peer.isRunning && cat.isLive,
        isFinished: cat.isFinished || (!peer.isRunning && cat.kind === 'agent'),
        note: where,
      }))
    }

    return [
      {
        id: peer.sessionId,
        title: peer.name,
        kind: 'session',
        isLive: peer.isRunning && peer.status !== 'idle',
        isFinished: !peer.isRunning,
        startedAt: peer.updatedAt,
        updatedAt: peer.updatedAt,
        tasks: [],
        note: `${where} · ${peer.isRunning ? peer.status : 'closed'} · no board (mod not loaded there)`,
      },
    ]
  })

  return { ...local, categories: [...own, ...remote] }
}

/** Which sessions the board shows: this one, every one in this project's folder, or every one on this machine. */
export type Scope = 'session' | 'project' | 'all'
export const SCOPES: readonly Scope[] = ['session', 'project', 'all']
export const isScope = (v: unknown): v is Scope => typeof v === 'string' && (SCOPES as readonly string[]).includes(v)

/**
 * A folder as a project key: forward slashes, no `\\?\` prefix or trailing
 * slash, any case on Windows, and a worktree Claude Code made for a session
 * (`<project>/.claude/worktrees/<name>`) counted as its project.
 */
export const projectKey = (path: string): string => {
  let p = path.replace(/^\\\\\?\\/, '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-z]:\//i.test(p) || p.startsWith('//')) p = p.toLowerCase()
  const tree = p.search(/\/\.claude\/worktrees\//i)

  return tree >= 0 ? p.slice(0, tree) : p
}

/** Whether a session working in `cwd` works on the project in `project`: that folder, one inside it, or a worktree of it. */
export const inProject = (cwd: string, project: string): boolean => {
  if (!cwd || !project) return false
  const [c, p] = [projectKey(cwd), projectKey(project)]

  return c === p || c.startsWith(`${p}/`)
}

/** The other sessions the board shows at a scope; `project` is this session's folder. */
export const scopedPeers = (scope: Scope, peers: readonly Peer[], project: string): Peer[] =>
  scope === 'session' ? [] : scope === 'project' ? peers.filter(p => inProject(p.cwd, project)) : [...peers]

/**
 * What other running sessions are working on now, from their published
 * boards: their live agents' titles and their todo items in progress.
 */
export const peerWork = (peers: readonly Peer[]): string[] =>
  peers
    .filter(p => p.isRunning && p.board)
    .flatMap(p =>
      p.board!.categories
        .filter(c => !c.isFinished)
        .flatMap(c => [
          ...(c.kind === 'agent' && c.isLive ? [c.title] : []),
          ...c.tasks.filter(t => t.status === 'in_progress').flatMap(t => [t.title, t.activeForm ?? '']),
        ]),
    )

/** A subagent of this session as the engine lists it (`$.agent.list()`). */
export type ListedAgent = { id: string; description: string; type: string; status: string; parentId?: string; name?: string }

/**
 * Brings the board's agent rows in line with the engine's list: a running
 * agent gets a live row (even one that never wrote a todo, or started before
 * this mod loaded), and a listed agent that stopped running is finished.
 * Rows the list does not name are left as they are.
 */
export const syncAgents = (board: Board, agents: readonly ListedAgent[], now: number): Board => {
  let next = board
  for (const a of agents) {
    const cat = next.categories.find(c => c.id === a.id)
    const isRunning = a.status === 'running'
    if (!cat && !isRunning) continue
    if (cat && cat.isLive === isRunning && cat.isFinished === !isRunning) continue
    const title = a.description || a.name || `${a.type} agent`
    next = withCategory(
      next,
      a.id,
      now,
      c => ({ ...c, title: c.title || title, isLive: isRunning, isFinished: !isRunning }),
      { title, kind: 'agent', agentType: a.type, parentId: a.parentId },
    )
  }

  return next
}

/** What the agent is doing now: the active todo's present-tense form. */
export const currentStep = (cat: Category): string => {
  const active = cat.tasks.find(t => t.status === 'in_progress')
  if (active) return active.activeForm ?? active.title
  const c = countTasks(cat.tasks)
  if (c.total === 0 && cat.note) return cat.note
  if (c.total === 0) return cat.isFinished ? 'Finished' : 'No todo list yet'
  if (c.done === c.total) return 'All tasks done'
  if (cat.isFinished) return `Stopped with ${c.total - c.done} left`

  return cat.tasks.find(t => t.status === 'pending')?.title ?? ''
}

/** How long ago, in a pill's few characters: '' for no time (the pill shows a dash), at most "99d+". */
export const relTime = (at: number | undefined, now: number): string => {
  if (at === undefined || !Number.isFinite(at) || at <= 0) return ''
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  const d = Math.floor(s / 86400)

  return d > 99 ? '99d+' : `${d}d`
}

/** How long ago, as words: "18m ago", "just now". */
export const ago = (at: number | undefined, now: number): string => {
  const t = relTime(at, now)

  return t === '' ? '' : t === 'now' ? 'just now' : `${t} ago`
}

/** A task's times as one line of words: when it started or finished, and how long it took. */
export const taskTimes = (task: Task, now: number): string => {
  const spent = duration(task.startedAt, task.completedAt ?? (task.status === 'in_progress' ? now : undefined))
  if (task.status === 'completed') {
    return [`Finished ${ago(task.completedAt, now) || '—'}`, task.startedAt ? `took ${spent}` : ''].filter(Boolean).join(' · ')
  }
  if (task.status === 'in_progress') return `Started ${ago(task.startedAt, now) || '—'} · ${spent} so far`

  return `Added ${ago(task.createdAt, now) || '—'} · not started`
}

/** A group's second line: what is under way in it, else what comes next. */
export const nextStep = (cat: Category): string => {
  const active = cat.tasks.find(t => t.status === 'in_progress')
  if (active) return `Now: ${active.activeForm ?? active.title}`
  const c = countTasks(cat.tasks)
  if (c.total > 0 && c.done === c.total) return 'All done'
  const next = cat.tasks.find(t => t.status === 'pending')

  return next ? `Next: ${next.title}` : ''
}

export const clock = (at: number | undefined): string => {
  if (at === undefined) return '-'
  const d = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

export const duration = (from: number | undefined, to: number | undefined): string => {
  if (from === undefined || to === undefined) return '-'
  const s = Math.max(0, Math.round((to - from) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`

  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
}

/** Quarter-step ring glyph for the terminal. */
export const ringGlyph = (fraction: number): string =>
  fraction <= 0 ? '○' : fraction < 0.375 ? '◔' : fraction < 0.625 ? '◑' : fraction < 1 ? '◕' : '●'

export const bar = (fraction: number, width: number): string => {
  const full = Math.round(Math.max(0, Math.min(1, fraction)) * width)

  return '█'.repeat(full) + '░'.repeat(Math.max(0, width - full))
}
