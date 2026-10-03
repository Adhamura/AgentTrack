// Checks the plugin's version: plugin.json and the marketplace manifest must agree,
// and, given a base commit, a change to what the plugin ships must raise it.
// Usage: node scripts/check-version.mjs [base-commit]
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const PLUGIN = '.claude-plugin/plugin.json'
const MARKET = '.claude-plugin/marketplace.json'
const SHIPPED = ['hooks/', 'types/', '.claude-plugin/']

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' })
const versionsAt = read => {
  const plugin = JSON.parse(read(PLUGIN))
  const listed = JSON.parse(read(MARKET)).plugins.find(p => p.name === plugin.name)

  return { name: plugin.name, plugin: plugin.version, market: listed?.version }
}
const parse = v => (v ?? '').split('.').map(Number)
const newer = (a, b) => {
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)

  return false
}

const now = versionsAt(path => readFileSync(path, 'utf8'))
const fail = message => {
  console.error(`✗ ${message}`)
  process.exit(1)
}
if (!/^\d+\.\d+\.\d+$/.test(now.plugin ?? '')) fail(`${PLUGIN} version "${now.plugin}" is not x.y.z`)
if (now.market !== now.plugin) fail(`${MARKET} lists ${now.name} ${now.market}, but ${PLUGIN} says ${now.plugin}`)

const base = process.argv[2]
if (base && !/^0+$/.test(base)) {
  const changed = git('diff', '--name-only', base, 'HEAD').split('\n').filter(f => SHIPPED.some(d => f.startsWith(d)))
  if (changed.length > 0) {
    const before = versionsAt(path => git('show', `${base}:${path}`))
    if (!newer(now.plugin, before.plugin)) {
      fail(`${changed.length} shipped file(s) changed since ${base.slice(0, 7)} but the version is still ${now.plugin}: bump it (see CLAUDE.md)`)
    }
  }
}
console.log(`✓ ${now.name} ${now.plugin}`)
