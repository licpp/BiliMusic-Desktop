// Publish an existing Git tag and its artifacts using the local Gitee CLI login.
import { execFileSync } from 'node:child_process'
import { openAsBlob } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'

const [tag, notesPath, ...files] = process.argv.slice(2)
if (!/^v\d+\.\d+\.\d+$/.test(tag ?? '') || !notesPath || !files.length) {
  throw new Error('Usage: node scripts/gitee-release.mjs v0.2.4 release-notes.md <files...>')
}

const repo = 'yoaker/BiliMusic-Desktop'
const endpoint = `https://gitee.com/api/v5/repos/${repo}`
const token = execFileSync('gitee', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const body = await readFile(notesPath, 'utf8')
const title = body.split('\n').find(line => line.startsWith('# '))?.slice(2).trim() || `BiliMusic ${tag}`
const assets = await Promise.all(files.map(async path => {
  const info = await stat(path)
  if (!info.isFile() || !info.size) throw new Error(`Invalid asset: ${path}`)
  return { path, name: basename(path), size: info.size }
}))
if (new Set(assets.map(asset => asset.name)).size !== assets.length) {
  throw new Error('Asset names must be unique')
}

async function api(path, { method = 'GET', payload, optional = false } = {}) {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' }
  let body
  if (payload instanceof FormData || payload instanceof URLSearchParams) body = payload
  else if (payload !== undefined) {
    headers['content-type'] = 'application/json'
    body = JSON.stringify(payload)
  }
  const response = await fetch(endpoint + path, { method, headers, body, signal: AbortSignal.timeout(180_000) })
  if (optional && response.status === 404) return null
  if (!response.ok) throw new Error(`Gitee ${method} ${path} returned HTTP ${response.status}`)
  return response.status === 204 ? null : response.json()
}

const tagRef = `/releases/tags/${tag}`
let release = await api(tagRef, { optional: true })
if (!release) {
  const commit = execFileSync('git', ['rev-parse', `${tag}^{commit}`], { encoding: 'utf8' }).trim()
  release = await api('/releases', {
    method: 'POST',
    payload: new URLSearchParams({ tag_name: tag, name: title, body, target_commitish: commit, prerelease: "true" }),
  })
}
const releasePath = `/releases/${release.id}`
const existing = await api(`${releasePath}/attach_files?per_page=100`)
for (const asset of assets) {
  const uploaded = existing.find(entry => entry.name === asset.name)
  if (uploaded) {
    if (uploaded.size !== asset.size) throw new Error(`Existing attachment has a different size: ${asset.name}`)
  } else {
    const form = new FormData()
    form.append('file', await openAsBlob(asset.path), asset.name)
    await api(`${releasePath}/attach_files`, { method: 'POST', payload: form })
  }
  console.log(`Gitee ${tag}: ${asset.name}`)
}
const verified = await api(`${releasePath}/attach_files?per_page=100`)
for (const asset of assets) {
  if (!verified.some(entry => entry.name === asset.name && entry.size === asset.size)) {
    throw new Error(`Attachment was not verified: ${asset.name}`)
  }
}
if (release.prerelease || release.name !== title || release.body !== body) {
  await api(releasePath, {
    method: 'PATCH',
    payload: new URLSearchParams({ tag_name: tag, name: title, body, prerelease: 'false' }),
  })
  if ((await api(tagRef)).prerelease) throw new Error('Gitee release is still marked as a prerelease')
}
console.log(`https://gitee.com/${repo}/releases/tag/${tag}`)
