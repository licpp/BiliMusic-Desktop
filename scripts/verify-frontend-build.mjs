import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export async function verifyFrontendBuild(directory, edition, target, platform) {
  assert.ok(directory && edition && target, 'Expected output directory, edition and frontend target')
  const root = resolve(directory)
  const manifest = JSON.parse(await readFile(resolve(root, 'frontend-build.json'), 'utf8'))
  assert.equal(manifest.edition, edition, 'Unexpected frontend edition')
  assert.equal(manifest.target, target, 'Unexpected Vite target')
  if (platform) assert.equal(manifest.platform, platform, 'Unexpected frontend platform')
  for (const required of ['index.html', 'boot.js', 'boot.css']) {
    assert.ok(Object.hasOwn(manifest.files, required), `Missing frontend asset ${required}`)
  }
  assert.ok(Object.keys(manifest.files).some(name => /^assets\/.+\.js$/.test(name)), 'Missing application bundle')
  await Promise.all(Object.entries(manifest.files).map(async ([name, expected]) => {
    const path = resolve(root, name)
    const within = relative(root, path)
    assert.ok(within && !isAbsolute(within) && within !== '..' && !within.startsWith('..' + sep), `Invalid asset path ${name}`)
    const actual = createHash('sha256').update(await readFile(path)).digest('hex')
    assert.equal(actual, expected, `Frontend asset checksum mismatch for ${name}`)
  }))
  return manifest
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { edition, platform, target, files } = await verifyFrontendBuild(...process.argv.slice(2))
  console.log(`${edition} · ${platform} · ${target} · ${Object.keys(files).length} assets verified`)
}
