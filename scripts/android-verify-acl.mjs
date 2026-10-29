import { readFile, writeFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const manifest = JSON.parse(await readFile('src-tauri/gen/schemas/acl-manifests.json', 'utf8'))['android-player']
assert.ok(manifest, 'Android player missing from compiled ACL manifest')
const required = ['play', 'control', 'snapshot', 'register_listener', 'remove_listener']
const granted = new Set(manifest.default_permission.permissions.flatMap(id => manifest.permissions[id]?.commands.allow || []))
for (const name of required) assert.ok(granted.has(name), `Compiled Android ACL denies ${name}`)
const capabilities = JSON.parse(await readFile('src-tauri/gen/schemas/capabilities.json', 'utf8'))
assert.ok(Object.values(capabilities).some(c => c.windows?.includes('main') && c.platforms?.includes('android') && c.permissions.includes('android-player:default')))
await writeFile('android-bridge-acl.json', JSON.stringify({ verified: true, plugin: 'android-player', commands: required }, null, 2))
console.log('Compiled Android playback and listener permissions verified')
