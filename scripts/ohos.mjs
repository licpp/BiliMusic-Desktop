import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const candidates = process.env.BILIMUSIC_PYTHON ? [process.env.BILIMUSIC_PYTHON] : ['python3', 'python3.14', 'python3.13', 'python3.12']
const python = candidates.find(command => spawnSync(command, ['-c', 'import sys; sys.exit(0 if sys.version_info >= (3,12) else 1)']).status === 0)
if (!python) throw new Error('Harmony builds require Python 3.12+. Install it or set BILIMUSIC_PYTHON.')
const result = spawnSync(python, [fileURLToPath(new URL('./ohos.py', import.meta.url)), ...process.argv.slice(2)], { stdio: 'inherit' })
if (result.error) throw result.error
process.exit(result.status ?? 1)
