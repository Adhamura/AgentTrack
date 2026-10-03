// Packs Agent Track into a release zip: dist/agent-track-<version>.zip, and
// the release's notes beside it (dist/notes.md). The zip holds one folder,
// agent-track/, that is both the plugin and its own marketplace, so it can be
// installed with /plugin marketplace add <folder>. The same as pack.bat, on any platform.
// Usage: node scripts/pack.mjs
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const NAME = 'agent-track'
const { version } = JSON.parse(readFileSync('.claude-plugin/plugin.json', 'utf8'))
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw new Error(`.claude-plugin/plugin.json version "${version}" is not x.y.z`)

const stage = join('dist', NAME)
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
// .claude-plugin/types is written by Claude Code on each load; it is not shipped.
cpSync('.claude-plugin', join(stage, '.claude-plugin'), { recursive: true, filter: src => !/[\\/]types([\\/]|$)/.test(src) })
for (const dir of ['hooks', 'types', 'tests', 'docs']) cpSync(dir, join(stage, dir), { recursive: true })
for (const file of ['README.md', 'LICENSE', 'tsconfig.json']) if (existsSync(file)) cpSync(file, join(stage, file))

const zip = join('dist', `${NAME}-${version}.zip`)
rmSync(zip, { force: true })
if (process.platform === 'win32') {
  execFileSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${stage}' -DestinationPath '${zip}'`], { stdio: 'inherit' })
} else {
  execFileSync('zip', ['-qr', `${NAME}-${version}.zip`, NAME], { cwd: 'dist', stdio: 'inherit' })
}

writeFileSync(
  join('dist', 'notes.md'),
  [
    '## Install',
    '',
    'From the marketplace, in Claude Code:',
    '',
    '```',
    '/plugin marketplace add Adhamura/AgentTrack',
    `/plugin install ${NAME}@${NAME}`,
    '```',
    '',
    `Already installed? Press **↻ Check updates** above the message box, or run \`/agent-track update\`.`,
    '',
    `Or download \`${NAME}-${version}.zip\` below, unzip it, and run \`/plugin marketplace add <unzipped folder>/${NAME}\`.`,
    '',
  ].join('\n'),
)
console.log(`Packed ${zip}`)
