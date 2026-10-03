/**
 * Project progress read from Markdown checklists: each `##` heading is a
 * section, each `###` under it a group, and each `- [x]` / `- [ ]` line an
 * item (`[~]`, `[-]` or `[/]` mark one in progress). A group's or section's
 * progress is its items'.
 */
import type { Category, DocBoard, DocItem, DocSection, Task } from '../types'
import { sameWork } from './match'

export type DocTab = {
  /** The tab's label. */
  title: string
  /** The checklist, relative to the project folder. */
  file: string
  /** Keep `##` sections that have no checkboxes (as headers with nothing under them). */
  keepEmptySections?: boolean
  /** Regular expressions removed from every heading, such as `\s*\(outside request[^)]*\)`. */
  strip?: string[]
}

export type DocConfig = { tabs: DocTab[] }

/** Where a project lists its tabs, relative to the project folder. */
export const CONFIG_FILE = '.claude/agent-track.json'

export const parseConfig = (text: string): DocConfig => {
  const raw = JSON.parse(text) as { tabs?: unknown }
  const tabs = Array.isArray(raw.tabs) ? raw.tabs : []

  return {
    tabs: tabs.flatMap((t): DocTab[] => {
      const tab = t as Partial<DocTab>
      if (typeof tab.title !== 'string' || typeof tab.file !== 'string') return []

      return [
        {
          title: tab.title,
          file: tab.file,
          keepEmptySections: tab.keepEmptySections === true,
          strip: Array.isArray(tab.strip) ? tab.strip.filter((s): s is string => typeof s === 'string') : [],
        },
      ]
    }),
  }
}

/** A short, stable id for a tab's pane: letters, digits and dashes. */
export const tabPaneId = (tab: DocTab) =>
  `agent-track-${tab.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'doc'}`

const ITEM = /^\s*[-*]\s+\[([ xX~/-])\]\s+(.*)$/

/** The item's name: its bold part when it has one, else its first 70 characters. */
const nameOf = (text: string) => {
  const bold = /\*\*(.+?)\*\*/.exec(text)?.[1]
  const plain = (bold ?? text).replace(/`/g, '').replace(/\s+/g, ' ').trim().replace(/\.$/, '')

  return plain.length > 70 ? `${plain.slice(0, 69).trimEnd()}…` : plain
}

export const parseDoc = (text: string, tab: DocTab): DocBoard => {
  const strips = (tab.strip ?? []).flatMap(p => {
    try {
      return [new RegExp(p, 'g')]
    } catch {
      return []
    }
  })
  const clean = (s: string) => strips.reduce((acc, re) => acc.replace(re, ''), s).trim()
  let title = tab.title
  const sections: DocSection[] = []
  let section: DocSection | undefined
  let group: DocSection['groups'][number] | undefined
  let n = 0

  for (const line of text.split(/\r?\n/)) {
    const head = /^(#{1,3})\s+(.*)$/.exec(line)
    if (head) {
      const level = head[1]?.length ?? 0
      const name = clean(head[2] ?? '')
      if (level === 1) title = name
      else if (level === 2) {
        section = { id: `s${sections.length}`, title: name, items: [], groups: [] }
        group = undefined
        sections.push(section)
      } else if (section) {
        group = { id: `${section.id}g${section.groups.length}`, title: name, items: [] }
        section.groups.push(group)
      }
      continue
    }
    const item = ITEM.exec(line)
    if (!item || !section) continue
    const mark = item[1] ?? ' '
    const body = (item[2] ?? '').trim()
    const entry: DocItem = {
      id: `i${n++}`,
      title: nameOf(body),
      detail: body.replace(/\*\*/g, '').replace(/`/g, ''),
      status: /x/i.test(mark) ? 'completed' : mark === ' ' ? 'pending' : 'in_progress',
    }
    ;(group ?? section).items.push(entry)
  }

  const kept = sections
    .map(s => ({ ...s, groups: s.groups.filter(g => g.items.length > 0) }))
    .filter(s => tab.keepEmptySections || s.items.length + s.groups.length > 0)

  return { title, file: tab.file, sections: kept, updatedAt: 0 }
}

/**
 * Marks open items in progress when something running matches them by code
 * or by 80% of their title, and groups and sections live when their own title
 * matches. Done items stay done.
 */
export const applyLive = (doc: DocBoard, running: readonly string[]): DocBoard => {
  if (running.length === 0) return doc
  const live = (item: DocItem): DocItem => {
    if (item.status === 'completed') return item
    const by = running.find(r => sameWork(item.title, r) || (item.detail !== item.title && sameWork(item.detail, r)))

    return by ? { ...item, status: 'in_progress', liveBy: by } : item
  }
  const isLive = (title: string) => running.some(r => sameWork(title, r))

  return {
    ...doc,
    sections: doc.sections.map(s => ({
      ...s,
      isLive: isLive(s.title),
      items: s.items.map(live),
      groups: s.groups.map(g => ({ ...g, isLive: isLive(g.title), items: g.items.map(live) })),
    })),
  }
}

export const itemsOf = (s: DocSection) => [...s.items, ...s.groups.flatMap(g => g.items)]

/** A group drawn as a board row: the group's items are its tasks. */
export const groupAsCategory = (
  id: string,
  title: string,
  items: readonly DocItem[],
  updatedAt: number,
  isLive = false,
): Category => ({
  id,
  title,
  kind: 'session',
  isLive: isLive || items.some(i => i.liveBy !== undefined),
  isFinished: false,
  startedAt: updatedAt,
  updatedAt,
  tasks: items.map(itemAsTask(updatedAt)),
})

export const itemAsTask =
  (at: number) =>
  (item: DocItem): Task => ({
    id: item.id,
    title: item.title,
    description: item.detail !== item.title ? item.detail : undefined,
    status: item.status,
    createdAt: at,
    updatedAt: at,
  })
