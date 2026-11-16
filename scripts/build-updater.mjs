// Desktop builds opt into signed updater artifacts without exposing the key to logs.
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
const env = { ...process.env }
const fallback = join(homedir(), '.config/BiliMusic/keys/updater.key')
if (!env.TAURI_SIGNING_PRIVATE_KEY && existsSync(fallback)) env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(fallback, 'utf8').trim()
if (!env.TAURI_SIGNING_PRIVATE_KEY) throw new Error('Set TAURI_SIGNING_PRIVATE_KEY to the updater key (or its file path).')
env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD ??= ''
const bundles = process.platform === 'darwin' ? 'app,dmg' : process.platform === 'win32' ? 'nsis' : undefined
if (!bundles) throw new Error('Desktop updater builds require macOS or Windows.')
const args = process.argv.slice(2)
const command = args[0] === '--bundle-only' ? (args.shift(), 'bundle') : 'build'
const result = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'tauri', '--', command, '--config', 'src-tauri/tauri.updater.conf.json', '--bundles', bundles, ...args], { env, stdio: 'inherit', shell: process.platform === 'win32' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
