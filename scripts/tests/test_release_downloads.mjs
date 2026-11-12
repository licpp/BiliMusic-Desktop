import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const run = promisify(execFile)

async function fixture(t, corrupt, harmony = false) {
  const root = await mkdtemp(join(tmpdir(), 'bilimusic-download-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sha256 = createHash('sha256').update('package').digest('hex')
  const platforms = ['mac', 'windows', 'android', 'ios', ...(harmony ? ['ohos'] : [])].map(id => ({ id, file: `${id}.bin`, size: 7, sha256, channels: ['github', 'gitee'].map(source => ({ id: source, url: `https://example.test/${source}/${id}` })) }))
  const plan = join(root, 'plan.json'), report = join(root, 'report.json'), preload = join(root, 'fetch.mjs')
  await writeFile(plan, JSON.stringify({ manifest: { platforms } }))
  await writeFile(preload, `globalThis.fetch=async url=>{const response=new Response(${JSON.stringify(corrupt ? 'changed' : 'package')});Object.defineProperty(response,'url',{value:url});return response}`)
  return { plan, report, preload }
}

test('download workflow reports all eight hashes before activation', async t => {
  const { plan, report, preload } = await fixture(t, false)
  await run(process.execPath, ['--import', preload, resolve('scripts/verify_release_downloads.mjs'), plan, report, 'a'.repeat(64)])
  const data = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(data.results.length, 8)
  assert.equal(new Set(data.results.map(r => r.url)).size, 8)
  assert.ok(data.results.every(r => r.size === 7))
})

test('four-platform releases also verify both retained Harmony downloads', async t => {
  const { plan, report, preload } = await fixture(t, false, true)
  await run(process.execPath, ['--import', preload, resolve('scripts/verify_release_downloads.mjs'), plan, report, 'a'.repeat(64)])
  const data = JSON.parse(await readFile(report, 'utf8'))
  assert.equal(data.results.length, 10)
  assert.equal(data.results.filter(r => r.platform === 'ohos').length, 2)
})

test('a same-size corrupted download prevents the activation proof', async t => {
  const { plan, report, preload } = await fixture(t, true)
  await assert.rejects(run(process.execPath, ['--import', preload, resolve('scripts/verify_release_downloads.mjs'), plan, report, 'a'.repeat(64)]), /SHA-256 mismatch/)
  await assert.rejects(access(report))
})

test('metadata backups reuse locally verified originals without network requests', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bilimusic-metadata-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const original = join(root, 'build-info.json'), report = join(root, 'release-report.json'), preload = join(root, 'offline.mjs')
  const sha256 = createHash('sha256').update('package').digest('hex')
  await writeFile(original, 'package')
  await writeFile(preload, 'globalThis.fetch=()=>{throw new Error("Network must not be used") }')
  await writeFile(report, JSON.stringify({ planDigest: 'a'.repeat(64), originalMetadata: [{ channel: 'github', name: 'build-info.json', size: 7, sha256, id: 123, url: 'https://example.test/build-info.json' }] }))
  await run(process.execPath, ['--import', preload, resolve('scripts/backup_release_metadata.mjs'), report, root, root])
  const proof = JSON.parse(await readFile(join(root, 'metadata-backup-proof.json'), 'utf8'))
  assert.equal(proof.results[0].sha256, sha256)
  assert.equal(await readFile(join(root, 'original-assets/github/build-info.json'), 'utf8'), 'package')
})
