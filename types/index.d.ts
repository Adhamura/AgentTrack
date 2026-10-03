export type TaskStatus = 'pending' | 'in_progress' | 'completed'

/** One todo item of an agent's list. Times are epoch milliseconds. */
export type Task = {
  id: string
  title: string
  activeForm?: string
  description?: string
  status: TaskStatus
  createdAt: number
  updatedAt: number
  startedAt?: number
  completedAt?: number
}

/** One loop of the session: the main conversation or a subagent. */
export type Category = {
  id: string
  title: string
  kind: 'session' | 'agent'
  agentType?: string
  parentId?: string
  isLive: boolean
  isFinished: boolean
  startedAt: number
  updatedAt: number
  tasks: Task[]
  /** Set on rows that come from another session: why it has no tasks, or where it runs. */
  note?: string
}

export type Board = { seq: number; categories: Category[] }

/** Another Claude Code session on this machine, as the sync last read it. */
export type Peer = {
  sessionId: string
  name: string
  cwd: string
  status: string
  isRunning: boolean
  updatedAt: number
  /** Present when that session runs this mod and published its board. */
  board?: Board
}

/** One checklist line of a project document. */
export type DocItem = {
  id: string
  title: string
  detail: string
  status: TaskStatus
  /** The running work this open item was matched to, which marks it in progress. */
  liveBy?: string
}

/** A `##` section: items right under it, and its `###` groups. */
export type DocSection = {
  id: string
  title: string
  items: DocItem[]
  groups: { id: string; title: string; items: DocItem[]; isLive?: boolean }[]
  /** Something running in the session matches this section's title. */
  isLive?: boolean
}

/** A project checklist file as one tab shows it. */
export type DocBoard = {
  title: string
  file: string
  sections: DocSection[]
  /** The file's last change, epoch ms. */
  updatedAt: number
  /** Why the file could not be read, when it could not. */
  error?: string
}

/** What each session writes to the shared folder. */
export type Snapshot = { sessionId: string; name: string; cwd: string; updatedAt: number; board: Board }

declare module 'claude-code' {
  interface PluginState {
    'agent-track': {
      board: Board
      collapsed: string[]
      selected: string | null
      tick: number
      dismissed: boolean
      peers: Peer[]
      selfName: string
      /** When each section or agent was last opened or closed, for the chevron's turn. */
      toggled: Record<string, { at: number; open: boolean }>
      /** Each project tab's parsed checklist, by pane id. */
      docs: Record<string, DocBoard>
      /** Done-count history per pane id, for the header line: [epoch ms, done]. */
      docHistory: Record<string, [number, number][]>
      /** Titles of what runs in this session now: agents, and todo items in progress. */
      liveWork: string[]
    }
  }
}
