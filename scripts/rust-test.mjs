import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
export function rustTestEnv(base = process.env) {
  const config = JSON.parse(base.TAURI_CONFIG || '{}')
  if (process.platform === 'darwin') config.app = {...config.app, macOSPrivateApi:false}
  return {...base, TAURI_CONFIG:JSON.stringify(config)}
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = spawnSync('cargo', ['test','--locked','--manifest-path','src-tauri/Cargo.toml','--lib',...process.argv.slice(2)], {cwd:fileURLToPath(new URL('..',import.meta.url)),env:rustTestEnv(),stdio:'inherit'})
  if(result.error) throw result.error
  process.exit(result.status ?? 1)
}
