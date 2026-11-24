import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { verifyFrontendBuild } from '../scripts/verify-frontend-build.mjs'

test('frontend verification checks the edition, target and the bytes passed to the packager', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'bilimusic-frontend-build-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const manifest = { edition: 'standard', platform: 'android', target: 'chrome105', files: {} }
  await mkdir(join(directory, 'assets'))
  for (const file of ['index.html', 'boot.js', 'boot.css', 'assets/app.js']) {
    await writeFile(join(directory, file), file)
    manifest.files[file] = createHash('sha256').update(file).digest('hex')
  }
  const manifestPath = join(directory, 'frontend-build.json')
  await writeFile(manifestPath, JSON.stringify(manifest))
  assert.deepEqual(await verifyFrontendBuild(directory, 'standard', 'chrome105', 'android'), manifest)
  await assert.rejects(verifyFrontendBuild(directory, 'large-screen', 'chrome105'), /Unexpected frontend edition/)
  await assert.rejects(verifyFrontendBuild(directory, 'standard', 'chrome66'), /Unexpected Vite target/)
  await assert.rejects(verifyFrontendBuild(directory, 'standard', 'chrome105', 'windows'), /Unexpected frontend platform/)
  await writeFile(join(directory, 'boot.js'), 'changed')
  await assert.rejects(verifyFrontendBuild(directory, 'standard', 'chrome105'), /checksum mismatch for boot.js/)
  delete manifest.files['boot.js']
  await writeFile(manifestPath, JSON.stringify(manifest))
  await assert.rejects(verifyFrontendBuild(directory, 'standard', 'chrome105'), /Missing frontend asset boot.js/)
})
