import { describe, expect, mock, test } from 'claude-code/testing'

import { applyLive, itemsOf, parseDoc, tabPaneId } from '../hooks/docs'
import { partial, sameWork } from '../hooks/match'
import { applyTodoWrite, emptyBoard, grouped, mergePeers, relTime, rowCheck, summarize } from '../hooks/board'

const PANE = { component: 'Pane', requestId: 'agent-track' } as const

const paneProps = {
  title: 'Agent progress',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30, totalRows: 30 },
} as const

describe('board model', () => {
  test('todo writes keep times and count progress', async () => {
    let b = applyTodoWrite(
      emptyBoard(),
      'main',
      [
        { content: 'Read', status: 'in_progress', activeForm: 'Reading' },
        { content: 'Write', status: 'pending' },
      ],
      1000,
    )
    b = applyTodoWrite(
      b,
      'main',
      [
        { content: 'Read', status: 'completed' },
        { content: 'Write', status: 'in_progress' },
      ],
      5000,
    )
    const [read, write] = b.categories[0]!.tasks
    expect(read?.startedAt).toBe(1000)
    expect(read?.completedAt).toBe(5000)
    expect(write?.startedAt).toBe(5000)
    expect(summarize(b).percent).toBe(50)
    expect(grouped(b).find(s => s.id === 'working')?.categories.length).toBe(1)
    expect(relTime(0, 125_000)).toBe('2m')
  })

  test('the summary counts what the rows show, and parents check by their children', async () => {
    let b = applyTodoWrite(emptyBoard(), 'main', [
      { content: 'A', status: 'completed' },
      { content: 'B', status: 'in_progress' },
    ], 1000)
    const merged = mergePeers(b, '', [
      { sessionId: 's1', name: 'Idle one', cwd: '/x', status: 'idle', isRunning: true, updatedAt: 1000 },
    ])
    const sum = summarize(merged)
    expect([sum.done, sum.inProgress, sum.notStarted, sum.total, sum.unit]).toEqual([1, 1, 1, 3, 'items'])
    expect(sum.percent).toBe(33)
    expect(rowCheck(b.categories[0]!)).toBe('mixed')
    b = applyTodoWrite(b, 'main', [{ content: 'A', status: 'completed' }, { content: 'B', status: 'completed' }], 2000)
    expect(rowCheck(b.categories[0]!)).toBe('done')
    expect(rowCheck(merged.categories[1]!)).toBe('empty')
  })

  test('project checklists become sections, groups and items', async () => {
    const text = [
      '# Art progress',
      'Intro text.',
      '## Prologue (outside request)',
      '### P — The Chapel',
      '- [x] `pr-nave` — dressed',
      '- [ ] **Lost and found.** not dressed',
      '## Roadmap',
      '- [~] Half way',
      '  - [ ] nested one',
      '## Notes only',
      'No boxes here.',
    ].join('\n')
    const tab = { title: 'Art', file: 'docs/art-progress.md', strip: ['\\s*\\(outside request[^)]*\\)'] }
    const doc = parseDoc(text, tab)
    expect(doc.title).toBe('Art progress')
    expect(doc.sections.map(s => s.title)).toEqual(['Prologue', 'Roadmap'])
    expect(doc.sections[0]?.groups[0]?.items.map(i => [i.title, i.status])).toEqual([
      ['pr-nave — dressed', 'completed'],
      ['Lost and found', 'pending'],
    ])
    expect(itemsOf(doc.sections[1]!).map(i => i.status)).toEqual(['in_progress', 'pending'])
    expect(parseDoc(text, { ...tab, keepEmptySections: true }).sections.length).toBe(3)
    expect(tabPaneId(tab)).toBe('agent-track-art')
  })

  test('running work marks matching checklist items in progress, by code or 80% of the title', async () => {
    expect(sameWork('HU.5 — The trail', 'HU.5 trail and Night (Fable)')).toBe(true)
    expect(sameWork('HU.4 — Affixes', 'HU.5 trail and Night (Fable)')).toBe(false)
    expect(sameWork('Night pass', 'Trail and night pass, second try')).toBe(true)
    expect(sameWork('Act I room art generation', 'Act I room art generation')).toBe(true)
    expect(sameWork('Write the verdict', 'Write integration tests')).toBe(false)
    expect(sameWork('Docs', 'Docs agent')).toBe(false)
    expect(partial('room art', 'Act I room art generation')).toBe(1)

    const doc = parseDoc(['## Hunt', '- [x] **HU.4 — Affixes.**', '- [ ] **HU.5 — The trail.** ...', '- [ ] **HU.6 — Night.**'].join('\n'), {
      title: 'Roadmap',
      file: 'r.md',
    })
    const live = applyLive(doc, ['HU.5 trail and Night (Fable)'])
    expect(itemsOf(live.sections[0]!).map(i => i.status)).toEqual(['completed', 'in_progress', 'pending'])
  })

  test('other sessions join the board, with or without the mod', async () => {
    const theirs = applyTodoWrite(emptyBoard(), 'main', [{ content: 'Ship', status: 'in_progress' }], 1000)
    const merged = mergePeers(emptyBoard(), 'Me', [
      { sessionId: 's1', name: 'Game build', cwd: 'C:/Projects/game', status: 'busy', isRunning: true, updatedAt: 1000, board: theirs },
      { sessionId: 's2', name: 'Docs', cwd: 'C:/Projects/docs', status: 'idle', isRunning: true, updatedAt: 1000 },
    ])
    expect(merged.categories.map(c => c.title)).toEqual(['Game build', 'Docs'])
    expect(merged.categories[0]?.tasks.length).toBe(1)
    expect(merged.categories[1]?.note).toBe('docs · idle · no board (mod not loaded there)')
    expect(grouped(merged).find(s => s.id === 'working')?.categories[0]?.title).toBe('Game build')
  })
})

test('a subagent and its todos show on the board on every surface', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('tool.call', () => ({ result: null, text: 'ok' }))
  on('tool.register', ($, e) => ({ value: { tool: `mcp__agent-track__${e.name}` } }))
  on('agent.list', () => ({ value: [{ id: 'agent-1', description: 'Explore agent', type: 'Explore', status: 'running' }] }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('classic.SubagentStart', () => ({}))
  on('classic.SubagentStop', () => ({}))

  await $.classic.SubagentStart({ agent_id: 'agent-1', agent_type: 'Explore' })
  await $.tool.call({
    tool: 'TodoWrite',
    agentId: 'agent-1',
    todos: [
      { content: 'Map the hooks API', status: 'completed', activeForm: 'Mapping the hooks API' },
      { content: 'Draw the board', status: 'in_progress', activeForm: 'Drawing the board' },
      { content: 'Write tests', status: 'pending', activeForm: 'Writing tests' },
    ],
  } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-track', surface, ...PANE, props: paneProps as never })
    const said = async (re: RegExp) =>
      surface === 'desktop'
        ? (await ui.findAll({ type: 'Svg' })).some(el => re.test(String(el.props.alt)))
        : (await ui.find({ text: re })) !== undefined
    expect(await said(/33%/)).toBe(true)
    expect(await said(/Explore agent/)).toBe(true)
    expect(await said(/Drawing the board/)).toBe(true)
    expect(await ui.find({ key: 'head-working' })).toBeDefined()

    await ui.press({ key: 'fold-agent-1' })
    await ui.press({ key: 'task-agent-1::t2' })
    expect(await ui.find({ key: 'detail-close' })).toBeDefined()
    await ui.press({ key: 'detail-close' })
    expect(await ui.find({ key: 'detail-close' })).toBeUndefined()

    await ui.press({ key: 'fold-agent-1' })
    expect(await ui.find({ key: 'task-agent-1::t2' })).toBeUndefined()
    await ui.unmount()
  }

  await $.tool.call({
    tool: 'mcp__agent-track__todo',
    agentId: 'agent-2',
    todos: [{ content: 'Plan', status: 'in_progress', activeForm: 'Planning' }],
  } as never)
  const two = await $.ui.mount({ plugin: 'agent-track', surface: 'desktop', ...PANE, props: paneProps as never })
  expect((await two.findAll({ type: 'Svg' })).some(el => /Planning/.test(String(el.props.alt)))).toBe(true)
  await two.unmount()

  await $.classic.SubagentStop({
    agent_id: 'agent-1',
    agent_type: 'Explore',
    stop_hook_active: false,
    agent_transcript_path: '',
  } as never)
  const ui = await $.ui.mount({ plugin: 'agent-track', surface: 'terminal', ...PANE, props: paneProps as never })
  expect(await ui.find({ key: 'head-done' })).toBeDefined()
  await ui.unmount()
})

test('the Progress button above the message box opens the board', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const opened: string[] = []
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('agent.list', () => ({ value: [] }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'agent-track',
      surface,
      component: 'AbovePrompt',
      props: { hasSurvey: false, maxRows: 4, bodyColumns: 80, scroll: { offset: 0, bodyRows: 4, totalRows: 1 } } as never,
    })
    expect(await ui.find({ key: 'board-toggle' })).toBeDefined()
    await ui.press({ key: 'board-toggle' })
    await ui.unmount()
  }
  expect(opened.filter(id => id === 'agent-track').length).toBe(2)
})

