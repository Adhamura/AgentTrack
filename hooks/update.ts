/**
 * Check updates, without depending on the `claude` command line's newer
 * options (`--json` is missing from older builds): what is installed and what
 * the marketplace offers are read from the files Claude Code keeps under
 * `~/.claude/plugins/`, and only `claude plugin marketplace update <name>` and
 * `claude plugin update <id>`, which every build with plugins has, are run.
 */

/** The installed copy of this plugin, as `installed_plugins.json` and its own folder name it. */
export type Installed = { id: string; name: string; marketplace: string; scope?: string; version?: string }

/** What a press of Check updates came to, as one line for a toast. */
export type UpdateOutcome =
  | { kind: 'updated'; from?: string; to?: string }
  | { kind: 'current'; version?: string }
  | { kind: 'local' }
  | { kind: 'failed'; reason: string }

/** A marketplace refresh clones from GitHub: give it the CLI's own two minutes and some room. */
export const REFRESH_MS = 150_000
export const UPDATE_MS = 180_000

const slashes = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const norm = (p: string) => slashes(p).toLowerCase()
const CACHE = '/plugins/cache/'

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const strOf = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

/**
 * The `~/.claude/plugins` folder an installed copy lives under, with forward
 * slashes; nothing for a copy loaded from a folder of its own (`--plugin-dir`).
 */
export const pluginsDirOf = (root: string): string | undefined => {
  const path = slashes(root)
  const at = path.toLowerCase().lastIndexOf(CACHE)

  return at < 0 ? undefined : path.slice(0, at + '/plugins'.length)
}

/**
 * This copy as installed: its entry in `installed_plugins.json` whose
 * `installPath` is `root`, or else what its cache path
 * (`cache/<marketplace>/<plugin>/<version>`) says.
 */
export const findInstalled = (installedJson: string, root: string): Installed | undefined => {
  const plugins = parse(installedJson)
  const table = isObj(plugins) && isObj(plugins.plugins) ? plugins.plugins : {}
  for (const [id, entries] of Object.entries(table)) {
    if (!Array.isArray(entries) || !id.includes('@')) continue
    const hit = entries.find(en => isObj(en) && strOf(en.installPath) && norm(en.installPath as string) === norm(root))
    if (isObj(hit)) {
      const at = id.lastIndexOf('@')

      return { id, name: id.slice(0, at), marketplace: id.slice(at + 1), scope: strOf(hit.scope), version: strOf(hit.version) }
    }
  }
  const path = slashes(root)
  const at = path.toLowerCase().lastIndexOf(CACHE)
  if (at < 0) return undefined
  const [marketplace, name, version] = path.slice(at + CACHE.length).split('/')
  if (!marketplace || !name) return undefined

  return { id: `${name}@${marketplace}`, name, marketplace, version }
}

/** The version `installed_plugins.json` holds for `id` now (the entry of `scope`, else the first). */
export const installedVersion = (installedJson: string, id: string, scope?: string): string | undefined => {
  const plugins = parse(installedJson)
  const entries = isObj(plugins) && isObj(plugins.plugins) ? plugins.plugins[id] : undefined
  if (!Array.isArray(entries)) return undefined
  const all = entries.filter(isObj)
  const mine = all.find(en => scope && en.scope === scope) ?? all[0]

  return mine ? strOf(mine.version) : undefined
}

/** Where a marketplace's checkout is: `known_marketplaces.json`'s `installLocation`, or the default folder. */
export const marketplaceDir = (knownJson: string, marketplace: string, pluginsDir: string): string => {
  const known = parse(knownJson)
  const entry = isObj(known) ? known[marketplace] : undefined

  return slashes(strOf(isObj(entry) ? entry.installLocation : undefined) ?? `${pluginsDir}/marketplaces/${marketplace}`)
}

/**
 * The plugin's entry in a marketplace's `marketplace.json`: its own version,
 * and the folder its `plugin.json` is in when its source is a relative path.
 */
export const offered = (marketplaceJson: string, name: string, dir: string): { version?: string; pluginDir?: string } => {
  const m = parse(marketplaceJson)
  const list = isObj(m) && Array.isArray(m.plugins) ? m.plugins : []
  const entry = list.find(p => isObj(p) && p.name === name)
  if (!isObj(entry)) return {}
  const source = strOf(entry.source)
  const isLocal = source === '.' || source?.startsWith('./')
  const pluginDir = isLocal ? slashes(`${dir}/${source}`).replace(/\/\.(?=\/|$)/g, '') : undefined

  return { version: strOf(entry.version), pluginDir }
}

/** The `version` of a `plugin.json`. */
export const versionOf = (pluginJson: string): string | undefined => {
  const p = parse(pluginJson)

  return isObj(p) ? strOf(p.version) : undefined
}

/** Compares two semver versions by their numbers: negative when `a` is older, 0 when equal, positive when newer. */
export const compareVersions = (a: string, b: string): number => {
  const nums = (v: string) => v.replace(/^v/, '').split(/[.+-]/).slice(0, 3).map(n => Number.parseInt(n, 10) || 0)
  const [x, y] = [nums(a), nums(b)]
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }

  return 0
}

/** The last non-empty line of a command's output: what it said went wrong. */
export const lastLine = (...outs: string[]): string | undefined =>
  outs
    .join('\n')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(Boolean)
    .pop()

export const outcomeText = (o: UpdateOutcome): string => {
  switch (o.kind) {
    case 'updated':
      return `Agent Track updated${o.from ? ` from ${o.from}` : ''}${o.to ? ` to ${o.to}` : ''}. Run /reload-plugins or start a new session to use it.`
    case 'current':
      return `Agent Track is up to date${o.version ? ` (${o.version})` : ''}.`
    case 'local':
      return 'Agent Track runs from a folder, not a marketplace: pull that folder to update it.'
    case 'failed':
      return `Could not check for updates: ${o.reason}`
  }
}

/** A thrown error from running `claude`, as the reason shown. */
export const runFailure = (err: unknown): UpdateOutcome => {
  const reason = err instanceof Error ? err.message : String(err)

  return { kind: 'failed', reason: /ENOENT|not found|cannot start/i.test(reason) ? 'the claude command is not on PATH' : reason }
}

/** Whether a plugin folder is a Windows path: there `claude` may be a `.cmd` shim, which runs only through cmd. */
export const isWindowsPath = (root: string) => /^[a-z]:[\\/]/i.test(root) || root.startsWith('\\\\')

/** The argument vector that runs `claude` with `args` on the platform the plugin folder is on. */
export const claudeArgv = (root: string, args: readonly string[]): string[] =>
  isWindowsPath(root) ? ['cmd.exe', '/d', '/s', '/c', 'claude', ...args] : ['claude', ...args]
