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

export type Summary = Counts & { unit: 'tasks' | 'items' }

const add = (a: Counts, b: Omit<Counts, 'percent'>) => ({
  total: a.total + b.total,
  done: a.done + b.done,
  inProgress: a.inProgress + b.inProgress,
  notStarted: a.notStarted + b.notStarted,
  percent: 0,
})

/**
 * What one row adds to the summary: its tasks, or, for a row with no todo
 * list, the row itself as one item in the state its section shows.
 */
export const rowItems = (cat: Category): Omit<Counts, 'percent'> => {
  if (cat.tasks.length > 0) return countTasks(cat.tasks)
  const section = sectionOf(cat)

  return {
    total: 1,
    done: section === 'done' ? 1 : 0,
    inProgress: section === 'working' ? 1 : 0,
    notStarted: section === 'waiting' ? 1 : 0,
  }
}

/** The header's numbers, counted from exactly the rows the board shows. */
export const summarize = (board: Board): Summary => {
  const sum = board.categories.reduce((acc, cat) => add(acc, rowItems(cat)), countTasks([]))

  return {
    ...sum,
    percent: sum.total === 0 ? 0 : Math.round((sum.done / sum.total) * 100),
    unit: board.categories.every(c => c.tasks.length > 0) ? 'tasks' : 'items',
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
  { id: 'waiting', title: 'Not started', empty: 'Nothing is waiting to start.' },
  { id: 'done', title: 'Done', empty: 'Finished agents and lists land here.' },
]

export const sectionOf = (cat: Category): SectionId => {
  const c = countTasks(cat.tasks)
  if (c.total > 0 && c.done === c.total) return 'done'
  if (cat.isFinished) return 'done'
  if (cat.isLive || c.inProgress > 0) return 'working'
  if (c.done > 0) return 'working'

  return 'waiting'
}

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

export const relTime = (at: number | undefined, now: number): string => {
  if (at === undefined || !Number.isFinite(at)) return ''
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`

  return `${Math.floor(s / 86400)}d`
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
