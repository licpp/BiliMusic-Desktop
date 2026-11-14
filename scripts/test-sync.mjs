// Offline correctness tests only: no installer build, release, credentials or cloud endpoint.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const options = new Map()
for (let i = 2; i < process.argv.length; i++) {
  const flag = process.argv[i]
  if (['--stress', '--all'].includes(flag)) options.set(flag, true)
  else if (['--seeds', '--seed', '--filter'].includes(flag) && process.argv[i + 1]) options.set(flag, process.argv[++i])
  else throw new Error(`Unknown option: ${flag}`)
}
const env = { ...process.env }
for (const [flag, name] of [['--seeds', 'BILIMUSIC_SYNC_SIM_SEEDS'], ['--seed', 'BILIMUSIC_SYNC_SIM_START']]) {
  if (!options.has(flag)) continue
  const value = String(options.get(flag))
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || (flag === '--seeds' && (+value < 1 || +value > 4096))) throw new Error(`Invalid ${flag}`)
  env[name] = value
}
if (options.has('--stress')) env.BILIMUSIC_SYNC_SIM_SEEDS ??= '128'
if (options.has('--seed') && !options.has('--seeds')) env.BILIMUSIC_SYNC_SIM_SEEDS = '1'
const filter = options.get('--filter') ?? (options.has('--all') ? null : options.has('--stress') ? 'random_' : 'sync::simulation')
if (filter && !/^[\w:]+$/.test(filter)) throw new Error('Invalid test filter')
const args = ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', ...(filter ? [filter] : []), '--', '--nocapture']
console.log(`Offline sync tests${filter ? `: ${filter}` : ': all Rust unit tests'}`)
if (env.BILIMUSIC_SYNC_SIM_SEEDS) console.log(`Seeds: ${env.BILIMUSIC_SYNC_SIM_START || 0} + ${env.BILIMUSIC_SYNC_SIM_SEEDS}`)
const result = spawnSync('cargo', args, { cwd: fileURLToPath(new URL('..', import.meta.url)), env, stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
