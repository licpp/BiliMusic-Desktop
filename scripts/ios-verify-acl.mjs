import { readFile } from 'node:fs/promises'
import assert from 'node:assert/strict'
const manifest = JSON.parse(await readFile('src-tauri/gen/schemas/acl-manifests.json', 'utf8'))['ios-player']
assert.ok(manifest, 'iOS player missing from compiled ACL manifest')
const granted = new Set(manifest.default_permission.permissions.flatMap(id => manifest.permissions[id]?.commands.allow || []))
for (const command of ['play','control','snapshot','queue','register_listener','remove_listener']) assert.ok(granted.has(command), `Compiled iOS ACL denies ${command}`)
assert.ok(!granted.has('secret'), 'Keychain command must remain Rust-only')
const capabilities = JSON.parse(await readFile('src-tauri/gen/schemas/capabilities.json', 'utf8'))
assert.ok(Object.values(capabilities).some(c => c.windows?.includes('main') && c.platforms?.includes('iOS') && c.permissions.includes('ios-player:default')))
console.log('Compiled iOS playback, listener and queue permissions verified')
