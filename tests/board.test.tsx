import { describe, expect, mock, test } from 'claude-code/testing'

import { applyLive, columnCounts, columnsOf, itemsOf, parseDoc, splitFacets, tabPaneId } from '../hooks/docs'
import { partial, sameWork } from '../hooks/match'
import { claudeArgv, compareVersions, findInstalled, installedVersion, lastLine, marketplaceDir, offered, outcomeText, pluginsDirOf, versionOf } from '../hooks/update'
import { matches, runs, terms } from '../hooks/search'
import { applyTodoWrite, emptyBoard, ensureCategory, grouped, inProject, isBlank, mergePeers, peerWork, projectKey, relTime, rowCheck, scopedPeers, summarize, syncAgents } from '../hooks/board'

const PANE = { component: 'Pane', requestId: 'agent-track' } as const

const paneProps = {
  title: 'Agent progress',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30, totalRows: 30 },
} as const

describe('board model', () => {
  test('a search matches every word in any case and marks each occurrence', async () => {
    expect(terms('  Engine  GL ')).toEqual(['engine', 'gl'])
    expect(matches(['Q.11 Engine GL helper', 'general-purpose'], terms('gl engine'))).toBe(true)
    expect(matches(['Q.11 Engine GL helper'], terms('engine webgpu'))).toBe(false)
    expect(matches(['anything'], [])).toBe(true)
    expect(runs('Glow GL', ['gl'])).toEqual([
      { text: 'Gl', isHit: true },
      { text: 'ow ', isHit: false },
      { text: 'GL', isHit: true },
    ])
    expect(runs('abc', ['ab', 'bc'])).toEqual([{ text: 'abc', isHit: true }])
  })

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
    expect(relTime(5_000, 125_000)).toBe('2m')
    // No time is no pill text (the pill shows a dash), and a very old one stays short.
    expect(relTime(0, 125_000)).toBe('')
    expect(relTime(1, 200 * 86_400_000)).toBe('99d+')
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


test('Check updates from a copy loaded from a folder says to pull that folder, and runs nothing', async ($, on) => {
  const ran: string[] = []
  const toasts: string[] = []
  on('process.run', ($, e) => {
    ran.push(e.argv.join(' '))
    const stdout = JSON.stringify([{ id: 'agent-track@agent-track', scope: 'user', installPath: '/home/k/.claude/plugins/cache/agent-track/agent-track/1.2.0' }])

    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  const ui = await $.ui.mount({
    plugin: 'agent-track',
    surface: 'desktop',
    component: 'AbovePrompt',
    props: { hasSurvey: false, maxRows: 4, bodyColumns: 80, scroll: { offset: 0, bodyRows: 4, totalRows: 1 } } as never,
  })
  expect(await ui.find({ key: 'check-updates' })).toBeDefined()
  await ui.press({ key: 'check-updates' })
  await ui.unmount()
  expect(ran).toEqual([])
  expect(toasts.some(t => /runs from a folder/.test(t))).toBe(true)
})

test('updates read what is installed and offered from the plugin files of Claude Code', async () => {
  const root = 'C:\\Users\\k\\.claude\\plugins\\cache\\agent-track\\agent-track\\1.2.0'
  const plugins = pluginsDirOf(root)!
  expect(plugins).toBe('C:/Users/k/.claude/plugins')
  expect(pluginsDirOf('/home/k/dev/agent-track')).toBeUndefined()

  const installed = JSON.stringify({
    version: 2,
    plugins: { 'agent-track@mine': [{ scope: 'user', installPath: root, version: '1.2.0' }] },
  })
  expect(findInstalled(installed, root)).toEqual({ id: 'agent-track@mine', name: 'agent-track', marketplace: 'mine', scope: 'user', version: '1.2.0' })
  // No entry for this folder: the cache path still names it.
  expect(findInstalled('{}', root)).toEqual({ id: 'agent-track@agent-track', name: 'agent-track', marketplace: 'agent-track', version: '1.2.0' })
  expect(findInstalled('{}', '/home/k/dev/agent-track')).toBeUndefined()
  expect(installedVersion(installed, 'agent-track@mine', 'user')).toBe('1.2.0')

  const known = JSON.stringify({ mine: { installLocation: 'C:\\Users\\k\\.claude\\plugins\\marketplaces\\mine' } })
  const dir = marketplaceDir(known, 'mine', plugins)
  expect(dir).toBe('C:/Users/k/.claude/plugins/marketplaces/mine')
  expect(marketplaceDir('{}', 'other', plugins)).toBe('C:/Users/k/.claude/plugins/marketplaces/other')
  expect(offered('{"plugins":[{"name":"agent-track","source":"./","version":"1.3.1"}]}', 'agent-track', dir)).toEqual({
    version: '1.3.1',
    pluginDir: 'C:/Users/k/.claude/plugins/marketplaces/mine',
  })
  expect(versionOf('{"version":"1.3.2"}')).toBe('1.3.2')
  expect(outcomeText({ kind: 'updated', from: '1.3.3', to: '1.4.0' }, true)).toBe('Agent Track updated from 1.3.3 to 1.4.0. Reloading plugins…')
  expect(outcomeText({ kind: 'updated', from: '1.3.3', to: '1.4.0' })).toMatch(/Run \/reload-plugins/)

  expect(compareVersions('1.10.0', '1.9.9')).toBeGreaterThan(0)
  expect(compareVersions('1.3.1', '1.3.1')).toBe(0)
  expect(compareVersions('v1.2.0', '1.3.0')).toBeLessThan(0)
  expect(lastLine('', 'Refreshing…\nerror: unknown option\n')).toBe('error: unknown option')
  expect(claudeArgv('C:\\Users\\k', ['plugin', 'update', 'agent-track@mine'])).toEqual(['cmd.exe', '/d', '/s', '/c', 'claude', 'plugin', 'update', 'agent-track@mine'])
  expect(claudeArgv('/home/k', ['plugin', 'update', 'agent-track@mine'])).toEqual(['claude', 'plugin', 'update', 'agent-track@mine'])
})

test('the summary pills filter the board by status, with All as the way back', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('tool.call', () => ({ result: null, text: 'ok' }))
  on('agent.list', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Read', status: 'completed' },
      { content: 'Draw', status: 'in_progress' },
      { content: 'Test', status: 'pending' },
    ],
  } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-track', surface, ...PANE, props: paneProps as never })
    expect(await ui.find({ key: 'filter-agent-track:all' })).toBeDefined()
    expect(await ui.find({ key: 'task-main::t1' })).toBeUndefined()

    await ui.press({ key: 'filter-agent-track:completed' })
    expect(await ui.find({ key: 'task-main::t1' })).toBeDefined()
    expect(await ui.find({ key: 'task-main::t2' })).toBeUndefined()

    await ui.press({ key: 'filter-agent-track:pending' })
    expect(await ui.find({ key: 'task-main::t3' })).toBeDefined()
    expect(await ui.find({ key: 'task-main::t1' })).toBeUndefined()

    await ui.press({ key: 'filter-agent-track:all' })
    expect(await ui.find({ key: 'task-main::t1' })).toBeUndefined()
    expect(await ui.find({ key: 'head-working' })).toBeDefined()

    // The search opens the rows and keeps only the tasks it finds, marking what it found.
    await ui.input({ key: 'search-agent-track', text: 'dra', kind: 'change' })
    expect(await ui.find({ key: 'task-main::t2' })).toBeDefined()
    expect(await ui.find({ key: 'task-main::t1' })).toBeUndefined()
    expect(await ui.find({ key: 'task-main::t3' })).toBeUndefined()
    if (surface === 'desktop') {
      const art = (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.source)).join('')
      expect(art).toContain('fill="#d9480f">Dra</tspan>w')
    }
    await ui.input({ key: 'search-agent-track', text: 'nothing like it', kind: 'change' })
    expect(await ui.find({ key: 'task-main::t2' })).toBeUndefined()
    await ui.press({ key: 'search-clear-agent-track' })
    expect(await ui.find({ key: 'search-clear-agent-track' })).toBeUndefined()
    expect(await ui.find({ key: 'task-main::t2' })).toBeUndefined()
    if (surface === 'desktop') {
      // Each invisible click target is laid out in a room far wider than its cell, so a desktop never cuts its label with an ellipsis.
      const hits = (await ui.findAll({ type: 'Button' })).filter(el => /^\u2007+$/.test(String(el.props.label)))
      const rooms = (await ui.findAll({ type: 'Box' })).filter(el => el.props.width === 400 && el.props.flexShrink === 0)
      expect(hits.length).toBeGreaterThan(0)
      expect(rooms.length).toBe(hits.length)
    }
    await ui.unmount()
  }

})

test('project checklists are tabs inside the one board pane, each filtering on its own', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  const roadmap = ['## Hunt', '### Keys', '- [x] HU.1 First', '- [ ] HU.2 Second', '## Done part', '- [x] HU.0 Zero'].join('\n')
  on('fs.read', ($, e) => ({
    value: e.path.endsWith('agent-track.json') ? JSON.stringify({ tabs: [{ title: 'Roadmap', file: 'r.md' }] }) : roadmap,
  }))
  on('fs.stat', () => ({ value: { kind: 'file', mtimeMs: 1000, size: 1, realPath: '/p' } as never }))
  on('fs.list', () => ({ value: [] }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: { tool: 'mcp__agent-track__todo' } }))
  on('command.register', () => ({ value: { command: 'agent-track' } }))
  on('session.start', ($, e) => e as never)
  on('env.get', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'me' }))
  await $.session.start({ cwd: '/p', surface: 'terminal', isInteractive: true } as never)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-track', surface, ...PANE, props: paneProps as never })
    // Agents is the last tab.
    const tabKeys = (await ui.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => k.startsWith('tab-'))
    expect(tabKeys).toEqual(['tab-agent-track-roadmap', 'tab-agent-track'])
    await ui.press({ key: 'tab-agent-track-roadmap' })
    expect(await ui.find({ key: 'filter-agent-track-roadmap:all' })).toBeDefined()
    expect(await ui.find({ key: 'filter-agent-track:all' })).toBeUndefined()
    const ids = async () => (await ui.findAll({ type: 'Button' })).map(b => String(b.key)).filter(k => k.startsWith('item-'))
    expect(await ids()).toEqual([])
    await ui.press({ key: 'filter-agent-track-roadmap:pending' })
    expect((await ids()).length).toBe(1)
    expect(await ui.find({ key: 'head-agent-track-roadmap:done-part' })).toBeUndefined()
    await ui.press({ key: 'filter-agent-track-roadmap:pending' })
    expect(await ids()).toEqual([])
    // The search opens what it finds; words may span a section, a group and an item.
    await ui.input({ key: 'search-agent-track-roadmap', text: 'keys second', kind: 'change' })
    expect(await ids()).toEqual(['item-agent-track-roadmap::i1'])
    await ui.input({ key: 'search-agent-track-roadmap', text: 'zero', kind: 'change' })
    expect((await ids()).length).toBe(1)
    expect(await ui.find({ key: 'head-agent-track-roadmap:hunt' })).toBeUndefined()
    await ui.press({ key: 'search-clear-agent-track-roadmap' })
    expect(await ids()).toEqual([])
    await ui.press({ key: 'tab-agent-track' })
    // Nothing on Agents yet: one empty-state card (with the scope switch), no summary.
    expect(await ui.find({ key: 'filter-agent-track:all' })).toBeUndefined()
    expect(await ui.find({ key: 'scope-project' })).toBeDefined()
    await ui.unmount()
  }
})

test('a board left open over a reload is seated and drawn again', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  const opened: string[] = []
  const invalidated: string[] = []
  on('agent.list', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [{ id: 'agent-track', title: 'Progress', isShown: true, isFocused: false, isPlaced: true }] as never }))
  on('ui.open', ($, e) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.invalidate', ($, e) => {
    invalidated.push(String(e.event))

    return { value: undefined }
  })
  on('fs.read', () => ({ value: '' }))
  on('fs.stat', () => ({ value: undefined as never }))
  on('fs.list', () => ({ value: [] }))
  on('store.get', () => ({ value: undefined }))
  on('store.set', () => ({ value: undefined }) as never)
  on('tool.register', () => ({ value: { tool: 'mcp__agent-track__todo' } }))
  on('command.register', () => ({ value: { command: 'agent-track' } }))
  on('session.start', ($, e) => e as never)
  on('env.get', () => ({ value: undefined }))
  on('session.id', () => ({ value: 'me' }))
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true } as never)
  for (let i = 0; i < 20 && invalidated.length === 0; i++) await Promise.resolve()
  expect(opened).toContain('agent-track')
  expect(invalidated).toContain('ui.render')
})

test('the scope picks the sessions shown: this one, this project, or all', async () => {
  expect(inProject('/p', '/p')).toBe(true)
  expect(inProject('/p/sub/', '/p')).toBe(true)
  expect(inProject('/pp', '/p')).toBe(false)
  expect(inProject('C:\\Work\\Game', 'c:/work/game')).toBe(true)
  expect(inProject('', '/p')).toBe(false)
  const board = (title: string) => ({
    seq: 1,
    categories: [
      {
        id: 'main',
        title: 'Main',
        kind: 'session' as const,
        isLive: true,
        isFinished: false,
        startedAt: 0,
        updatedAt: 0,
        tasks: [{ id: 't1', title, activeForm: `Doing ${title}`, status: 'in_progress' as const, createdAt: 0, updatedAt: 0 }],
      },
    ],
  })
  const peers = [
    { sessionId: 'a', name: 'Here', cwd: '/p/sub', status: 'busy', isRunning: true, updatedAt: 0, board: board('HU.5 Keys') },
    { sessionId: 'b', name: 'There', cwd: '/q', status: 'busy', isRunning: true, updatedAt: 0, board: board('Other') },
  ]
  expect(scopedPeers('session', peers, '/p')).toEqual([])
  expect(scopedPeers('project', peers, '/p').map(p => p.name)).toEqual(['Here'])
  expect(scopedPeers('all', peers, '/p').length).toBe(2)
  expect(peerWork(scopedPeers('project', peers, '/p'))).toEqual(['HU.5 Keys', 'Doing HU.5 Keys'])
  expect(peerWork([{ ...peers[0]!, isRunning: false }])).toEqual([])
})

test('the switch at the top right shows this session, this project or every session', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const kept: Record<string, unknown> = {}
  on('store.get', ($, e) => ({ value: kept[e.key] }))
  on('store.set', ($, e) => {
    kept[e.key] = e.value

    return { value: undefined } as never
  })
  on('agent.list', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/h' : undefined }))
  on('session.id', () => ({ value: 'me' }))
  const files: Record<string, string> = {
    '/h/.claude/sessions/1.json': JSON.stringify({ sessionId: 'me', name: 'Mine', cwd: '/p', status: 'busy' }),
    '/h/.claude/sessions/2.json': JSON.stringify({ sessionId: 'a', name: 'Same project', cwd: '/p/sub', status: 'busy' }),
    '/h/.claude/sessions/3.json': JSON.stringify({ sessionId: 'b', name: 'Elsewhere', cwd: '/q', status: 'idle' }),
  }
  on('fs.read', ($, e) => {
    const text = files[e.path]
    if (text === undefined) throw new Error('ENOENT')

    return { value: text }
  })
  on('fs.write', () => ({ value: undefined }) as never)
  on('fs.stat', ($, e) => {
    if (e.path === '.') return { value: { kind: 'dir', mtimeMs: 0, size: 0, realPath: '/p' } as never }
    throw new Error('ENOENT')
  })
  on('fs.list', ($, e) => ({
    value: e.path.endsWith('/sessions')
      ? ['1.json', '2.json', '3.json'].map(name => ({ name, kind: 'file', mtimeMs: 1_000_000, size: 1 }) as never)
      : [],
  }))
  on('tool.register', () => ({ value: { tool: 'mcp__agent-track__todo' } }))
  on('command.register', () => ({ value: { command: 'agent-track' } }))
  on('session.start', ($, e) => e as never)
  await $.session.start({ cwd: '/p', surface: 'desktop', isInteractive: true } as never)
  await clock.advance(2_100)

  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-track', surface, ...PANE, props: paneProps as never })
    const shows = async (re: RegExp) =>
      surface === 'desktop'
        ? (await ui.findAll({ type: 'Svg' })).some(el => re.test(String(el.props.alt)))
        : (await ui.find({ text: re })) !== undefined
    await ui.press({ key: 'scope-project' })
    expect(await shows(/Same project/)).toBe(true)
    expect(await shows(/Elsewhere/)).toBe(false)
    await ui.press({ key: 'scope-all' })
    expect(await shows(/Elsewhere/)).toBe(true)
    await ui.press({ key: 'scope-session' })
    expect(await shows(/Same project/)).toBe(false)
    expect(await shows(/Elsewhere/)).toBe(false)
    await ui.unmount()
  }
  expect(kept.scope).toBe('session')
})

test('worktrees of a project count as the project, and running agents get rows without a todo', async () => {
  expect(projectKey('C:\\Work\\Mewsic\\.claude\\worktrees\\festive-ant')).toBe('c:/work/mewsic')
  expect(projectKey('\\\\?\\C:\\Work\\Mewsic\\')).toBe('c:/work/mewsic')
  expect(inProject('C:\\Work\\Mewsic\\.claude\\worktrees\\a', 'C:\\Work\\Mewsic\\.claude\\worktrees\\b')).toBe(true)
  expect(inProject('/w/Mewsic', '/w/Mewsic/.claude/worktrees/b')).toBe(true)
  expect(inProject('/w/Other/.claude/worktrees/a', '/w/Mewsic')).toBe(false)

  const listed = [
    { id: 'a1', description: 'HU.9 Apex beasts', type: 'general-purpose', status: 'running' },
    { id: 'a2', description: 'Old', type: 'Explore', status: 'completed' },
  ]
  const once = syncAgents(emptyBoard(), listed, 10)
  expect(once.categories.map(c => [c.id, c.title, c.isLive, c.isFinished])).toEqual([['a1', 'HU.9 Apex beasts', true, false]])
  expect(syncAgents(once, listed, 20)).toBe(once)
  const done = syncAgents(once, [{ ...listed[0]!, status: 'completed' }], 30)
  expect(done.categories[0]).toMatchObject({ isLive: false, isFinished: true })
})

test('a line written as name — part, part gets a column per part, done unless it says no', async () => {
  expect(splitFacets('cg-alms-vault — not dressed (0 props), no art')).toEqual({
    name: 'cg-alms-vault',
    facets: [
      { key: 'dressed', label: 'not dressed (0 props)', isDone: false },
      { key: 'art', label: 'no art', isDone: false },
    ],
  })
  expect(splitFacets('cg-x — dressed (3 props), art')?.facets.map(f => f.isDone)).toEqual([true, true])
  expect(splitFacets('Plain line without parts')).toBeUndefined()
  const text = [
    '## Act I',
    '### 1.1 Chapel Gate',
    '- [ ] cg-alms-vault — not dressed (0 props), no art',
    '- [ ] cg-choir — not built, no art',
    '## Notes',
    '- [ ] Story — draft the intro',
  ].join('\n')
  const doc = parseDoc(text, { title: 'Art', file: 'a.md' })
  const group = doc.sections[0]!.groups[0]!
  expect(group.items.map(i => i.title)).toEqual(['cg-alms-vault', 'cg-choir'])
  expect(columnsOf(group.items)).toEqual(['dressed', 'art', 'built'])
  expect(columnCounts(group.items)).toEqual([
    { key: 'dressed', done: 0, total: 1 },
    { key: 'art', done: 0, total: 2 },
    { key: 'built', done: 0, total: 1 },
  ])
  // A list with no line of two parts keeps its names whole.
  expect(doc.sections[1]!.items[0]).toMatchObject({ title: 'Story — draft the intro' })
  expect(doc.sections[1]!.items[0]!.facets).toBeUndefined()
})

test('a bold name keeps its own dash, and a list gets columns only when most of its lines have parts', async () => {
  const roadmap = [
    '## Hunt',
    '- [x] **HU.4 — Affixes.** Prefix and suffix rolls for every beast.',
    '- [ ] **HU.5 — The trail.** Tracks, scent and the night pass.',
    '- [ ] **HU.6 — Night.** Lighting and the moon cycle.',
  ].join('\n')
  const doc = parseDoc(roadmap, { title: 'Roadmap', file: 'r.md' })
  const items = doc.sections[0]!.items
  expect(items.map(i => i.title)).toEqual(['HU.4 — Affixes', 'HU.5 — The trail', 'HU.6 — Night'])
  expect(items.every(i => i.facets === undefined)).toBe(true)
  expect(splitFacets('**HU.5 — The trail.** Tracks, scent and the night pass.')).toBeUndefined()
  // A bold name followed by real parts still splits after the bold span.
  expect(splitFacets('**cg-gate** — dressed, no art')?.name).toBe('cg-gate')
  // A part of more than three words is prose, not a column.
  expect(splitFacets('Story — draft the whole intro chapter, art')).toBeUndefined()
  // One line of parts among three plain ones is not a list of parts.
  const few = parseDoc(['## Notes', '- [ ] a — dressed, art', '- [ ] b', '- [ ] c', '- [ ] d'].join('\n'), { title: 'N', file: 'n.md' })
  expect(few.sections[0]!.items[0]!.facets).toBeUndefined()
  expect(few.sections[0]!.items[0]!.title).toBe('a — dressed, art')
})

test('an empty board shows one empty-state card, not a summary of nothing', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  on('agent.list', () => ({ value: [] }))
  on('ui.panes', () => ({ value: [] }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // This session's own row before any todo list is no item of work.
  const bare = ensureCategory(emptyBoard(), 'main', { title: 'Main session', kind: 'session' }, 1000)
  expect(isBlank(bare)).toBe(true)
  expect(summarize(bare).total).toBe(0)
  await $.prompt.submit({ prompt: 'hi' } as never).catch(() => undefined)
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'agent-track', surface, ...PANE, props: paneProps as never })
    const said = async (re: RegExp) =>
      surface === 'desktop'
        ? (await ui.findAll({ type: 'Svg' })).some(el => re.test(String(el.props.alt)))
        : (await ui.find({ text: re })) !== undefined
    expect(await said(/No tasks yet/)).toBe(true)
    expect(await said(/0\/1/)).toBe(false)
    expect(await ui.find({ key: 'filter-agent-track:all' })).toBeUndefined()
    expect(await ui.find({ key: 'head-working' })).toBeUndefined()
    expect(await ui.find({ key: 'scope-session' })).toBeDefined()
    await ui.unmount()
  }
})
