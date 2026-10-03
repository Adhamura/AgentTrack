/**
 * Project progress read from Markdown checklists: each `##` heading is a
 * section, each `###` under it a group, and each `- [x]` / `- [ ]` line an
 * item (`[~]`, `[-]` or `[/]` mark one in progress). A group's or section's
 * progress is its items'.
 */
import type { Category, DocBoard, DocItem, DocSection, Facet, Task } from '../types'
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

/** Words that say a part is not done yet. */
const NOT_DONE = /\b(no|not|none|missing|without|todo|tbd|pending|needs?|wip)\b|\bn\/a\b|(^|\()\s*0\b/i
/** What a part says, without the words that say it is not done and without counts: its column. */
const facetKey = (label: string) =>
  label
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(no|not|none|missing|without|todo|tbd|pending|needs?|wip|yet)\b|\bn\/a\b/g, ' ')
    .replace(/\b\d+\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || label.toLowerCase().trim()

/** A line's name and its parts, when it reads `name — part, part`; the parts are short. */
export const splitFacets = (body: string): { name: string; facets: Facet[] } | undefined => {
  const at = /\s+[\u2014\u2013]\s+|\s+--?\s+/.exec(body)
  if (!at) return undefined
  const name = body.slice(0, at.index).trim()
  const parts = body
    .slice(at.index + at[0].length)
    .replace(/\.$/, '')
    .split(/\s*[,;]\s*/)
    .map(p => p.trim())
    .filter(Boolean)
  if (!name || parts.length === 0 || parts.length > 6 || parts.some(p => p.length > 40 || p.split(/\s+/).length > 6)) return undefined

  return { name, facets: parts.map(label => ({ key: facetKey(label), label, isDone: !NOT_DONE.test(label) })) }
}

/**
 * Gives a list's items their parts as columns, when the list is written that
 * way: at least one of its lines has two parts or more (so a lone `— note`
 * stays part of the name).
 */
const withFacets = (items: DocItem[], bodies: ReadonlyMap<string, string>): DocItem[] => {
  const split = items.map(i => ({ item: i, parts: splitFacets(bodies.get(i.id) ?? '') }))
  if (!split.some(s => (s.parts?.facets.length ?? 0) >= 2)) return items

  return split.map(({ item, parts }) => (parts ? { ...item, title: nameOf(parts.name), facets: parts.facets } : item))
}

/** The columns a list's items have, in the order they first come. */
export const columnsOf = (items: readonly DocItem[]): string[] => [...new Set(items.flatMap(i => i.facets?.map(f => f.key) ?? []))]

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
  const bodies = new Map<string, string>()

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
    bodies.set(entry.id, body.replace(/\*\*/g, '').replace(/`/g, ''))
    ;(group ?? section).items.push(entry)
  }

  const kept = sections
    .map(s => ({
      ...s,
      items: withFacets(s.items, bodies),
      groups: s.groups.filter(g => g.items.length > 0).map(g => ({ ...g, items: withFacets(g.items, bodies) })),
    }))
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
