/** One installed plugin as `claude plugin list --json` reports it. */
export type Installed = { id: string; version?: string; scope?: string; installPath?: string }

/** What a press of Check updates came to, as one line for a toast. */
export type UpdateOutcome =
  | { kind: 'updated'; from?: string; to?: string }
  | { kind: 'current'; version?: string }
  | { kind: 'local' }
  | { kind: 'failed'; reason: string }

const NAME = 'agent-track'
/** A marketplace refresh clones from GitHub: give it the CLI's own two minutes and some room. */
export const REFRESH_MS = 150_000
export const UPDATE_MS = 180_000
/** The scopes `claude plugin update --scope` takes. */
export const SCOPES = ['user', 'project', 'local', 'managed']

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** Whether a plugin folder is one Claude Code installed from a marketplace (its plugin cache). */
const isInstalledCopy = (root: string) => norm(root).includes('/plugins/cache/')

/**
 * The entry this copy of the plugin was installed as: by its folder, or else
 * by name when this copy is an installed one; a copy loaded from a folder of
 * its own (`--plugin-dir`) has none, even when another copy is installed.
 */
export const findInstalled = (listJson: string, root: string): Installed | undefined => {
  let list: unknown
  try {
    list = JSON.parse(listJson)
  } catch {
    return undefined
  }
  if (!Array.isArray(list)) return undefined
  const all = list.filter((p): p is Installed => !!p && typeof p === 'object' && typeof (p as Installed).id === 'string')
  const mine = all.filter(p => p.id.split('@')[0] === NAME && p.id.includes('@'))

  const exact = mine.find(p => p.installPath && norm(p.installPath) === norm(root))

  return exact ?? (isInstalledCopy(root) ? mine[0] : undefined)
}

/** The last line of the output that parses as a JSON object: where `--json` puts its result. */
export const lastJson = (out: string): Record<string, unknown> | undefined => {
  const lines = out.split(/\r?\n/).filter(l => l.trim().startsWith('{'))
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i]!)
      if (v && typeof v === 'object') return v as Record<string, unknown>
    } catch {
      // not this line
    }
  }

  return undefined
}

/** Reads `claude plugin update --json`'s result line. */
export const readUpdate = (out: string, exitCode: number): UpdateOutcome => {
  const r = lastJson(out)
  const str = (k: string) => (typeof r?.[k] === 'string' ? (r[k] as string) : undefined)
  if (!r || exitCode !== 0 || str('outcome') !== 'ok') {
    return { kind: 'failed', reason: str('message') ?? str('error') ?? (out.trim().split(/\r?\n/).pop() || `exit code ${exitCode}`) }
  }
  const from = str('oldVersion')
  const to = str('newVersion')
  if (str('updateOutcome') === 'up_to_date' || (from && from === to)) return { kind: 'current', version: to ?? from }

  return { kind: 'updated', from, to }
}

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

/** Why a refresh of the marketplace failed, or nothing when it worked. */
export const refreshFailure = (out: string, err: string, exitCode: number, marketplace: string): string | undefined => {
  const r = lastJson(out)
  if (exitCode === 0 && (!r || r.outcome === 'ok')) return undefined
  const why = typeof r?.message === 'string' ? r.message : err.trim()

  return why || `could not refresh the ${marketplace} marketplace`
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
