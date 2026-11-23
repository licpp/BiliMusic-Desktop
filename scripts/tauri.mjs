import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const build = process.env.BILIMUSIC_BUILD_NUMBER ?? process.env.TAURI_BILIMUSIC_BUILD_NUMBER ?? '1'
const env = { ...process.env, TAURI_BILIMUSIC_BUILD_NUMBER: build }
// Tauri forwards TAURI-prefixed variables to the Rust compiler launched by Xcode and Gradle.
const result = spawnSync(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), ...process.argv.slice(2)], { env, stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
