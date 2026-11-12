import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const run = promisify(execFile)

async function fixture(t, corrupt) {
  const root = await mkdtemp(join(tmpdir(), 'bilimusic-download-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const sha256 = createHash('sha256').update('package').digest('hex')
  const platforms = ['mac', 'windows', 'android', 'ios'].map(id => ({ id, file: `${id}.bin`, size: 7, sha256, channels: ['github', 'gitee'].map(source => ({ id: source, url: `https://example.test/${source}/${id}` })) }))
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

test('a same-size corrupted download prevents the activation proof', async t => {
  const { plan, report, preload } = await fixture(t, true)
  await assert.rejects(run(process.execPath, ['--import', preload, resolve('scripts/verify_release_downloads.mjs'), plan, report, 'a'.repeat(64)]), /SHA-256 mismatch/)
  await assert.rejects(access(report))
})
