// Replay the checked-out and two historical engines against one disposable WebDAV.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { rustTestEnv } from './rust-test.mjs'

const repository = fileURLToPath(new URL('..', import.meta.url))
const target = resolve(repository, process.env.CARGO_TARGET_DIR ?? 'src-tauri/target')
const fixture = join(repository, 'tests/fixtures/sync-v2-historical.rs')
const test = 'sync::history_replay::replay'
const candidate = process.argv[2] ?? 'HEAD'
const reportPath = process.argv[3]
if (process.argv.length > 4) throw new Error('Usage: node scripts/test-sync-history.mjs [candidate-ref] [report.json]')
if (reportPath) mkdirSync(dirname(resolve(reportPath)), { recursive: true })

function checked(command, args, options) {
  const result = spawnSync(command, args, options)
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} returned ${result.status}`)
  return result.stdout
}

function build(ref, workspace, keepBinary) {
  const commit = checked('git', ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], {
    cwd: repository, encoding: 'utf8',
  }).trim()
  mkdirSync(workspace)
  const archive = checked('git', ['archive', commit], { cwd: repository, maxBuffer: 128 * 1024 * 1024 })
  checked('tar', ['-xf', '-'], { cwd: workspace, input: archive })
  copyFileSync(fixture, join(workspace, 'src-tauri/src/sync/history_replay.rs'))
  appendFileSync(join(workspace, 'src-tauri/src/sync/mod.rs'), '\n#[cfg(test)]\nmod history_replay;\n')
  const env = rustTestEnv({ ...process.env, CARGO_TARGET_DIR: target })
  if (process.platform === 'darwin') {
    const manifest = readFileSync(join(workspace, 'src-tauri/Cargo.toml'), 'utf8')
    const dependencies = manifest.split(/^\[dependencies\]\s*$/m)[1].split(/^\[/m)[0]
    const config = JSON.parse(env.TAURI_CONFIG)
    config.app.macOSPrivateApi = /^tauri\s*=.*"macos-private-api"/m.test(dependencies)
    env.TAURI_CONFIG = JSON.stringify(config)
  }
  console.log(`Compiling ${ref} (${commit})`)
  const messages = checked('cargo', [
    'test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--lib', '--no-run', '--message-format=json',
  ], { cwd: workspace, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 32 * 1024 * 1024 })
  const executable = messages.trim().split('\n').map(line => JSON.parse(line))
    .find(item => item.reason === 'compiler-artifact' && item.target.name === 'bilimusic_lib' && item.profile.test)
    ?.executable
  if (!executable) throw new Error(`Missing historical test executable for ${ref}`)
  // The three builds share a target cache. Keep independent binaries so a
  // compiler fingerprint or symlink refresh cannot replace an earlier build.
  const binary = keepBinary ? resolve(keepBinary) : join(workspace, process.platform === 'win32' ? 'history-test.exe' : 'history-test')
  if (keepBinary) mkdirSync(dirname(binary), { recursive: true })
  copyFileSync(executable, binary)
  if (keepBinary) console.log(`Candidate test executable: ${binary}`)
  return { ref, commit, binary }
}

function roleEnv(root, mode) {
  return { ...process.env, NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
    BILIMUSIC_SYNC_HISTORY_ROOT: root, BILIMUSIC_SYNC_HISTORY_MODE: mode }
}

const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex')
async function replay(previous, current, root) {
  mkdirSync(root)
  writeFileSync(join(root, 'history-test-marker'), '')
  const testArgs = ['--exact', test, '--nocapture']
  const server = spawn(current.binary, testArgs, { stdio: 'inherit', env: roleEnv(root, 'serve') })
  const exit = new Promise((yes, no) => {
    server.once('error', no)
    server.once('close', yes)
  })
  // Install the rejection handler before waiting for a readiness marker.
  exit.catch(() => {})
  const steps = []
  const ready = join(root, 'ready.json')
  const done = join(root, 'done')
  const complete = outcome => {
    writeFileSync(`${done}.tmp`, outcome)
    renameSync(`${done}.tmp`, done)
  }
  const run = (build, mode) => {
    console.log(`\n${build.ref}: ${mode}`)
    checked(build.binary, testArgs, { env: roleEnv(root, mode), stdio: 'inherit', timeout: 45_000 })
    steps.push(mode)
  }
  try {
    const deadline = Date.now() + 8_000
    while (!existsSync(ready)) {
      if (server.exitCode !== null || Date.now() >= deadline) throw new Error('Local WebDAV did not start')
      await pause(40)
    }
    const db = join(root, 'app-data/profile-42.sqlite3')
    const preUpgrade = join(root, 'pre-upgrade.sqlite3')
    const upgraded = join(root, 'upgraded.sqlite3')
    run(previous, 'seed')
    copyFileSync(db, preUpgrade)
    run(current, 'upgrade')
    const beforeBlockedDowngrade = hash(db)
    run(previous, 'reject')
    if (hash(db) !== beforeBlockedDowngrade) throw new Error('Old engine modified the upgraded database')
    copyFileSync(db, upgraded)
    copyFileSync(preUpgrade, db)
    run(previous, 'rollback')
    copyFileSync(upgraded, db)
    run(current, 'rejoin')
    complete('passed')
    if (await exit !== 0) throw new Error('Local WebDAV test server failed')
    return { historical: previous.ref, historicalCommit: previous.commit, candidate: current.commit, steps }
  } finally {
    if (server.exitCode === null && server.signalCode === null) {
      if (existsSync(ready) && !existsSync(done)) complete('failed')
      else server.kill()
    }
    await exit.catch(() => {})
  }
}

const workspace = mkdtempSync(join(tmpdir(), 'bilimusic-sync-history-'))
try {
  const current = build(candidate, join(workspace, 'current'), process.env.BILIMUSIC_SYNC_HISTORY_CANDIDATE_BINARY)
  const report = []
  const historical = join(workspace, 'historical')
  for (const version of ['v0.3.2', 'v0.3.3']) {
    try {
      const previous = build(version, historical)
      report.push(await replay(previous, current, join(workspace, `data-${version}`)))
      if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    } finally {
      rmSync(historical, { recursive: true, force: true })
    }
  }
  console.log('\nBoth historical engines passed upgrade, guarded downgrade, rollback and rejoin.')
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
