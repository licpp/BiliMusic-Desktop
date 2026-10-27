// Run after `tauri android init`. Keep generated Gradle scaffolding reproducible.
import { readFile, writeFile, mkdir } from 'node:fs/promises'
const base = new URL('../src-tauri/gen/android/app/src/main/', import.meta.url)
const manifest = new URL('AndroidManifest.xml', base)
let xml = await readFile(manifest, 'utf8')
xml = xml.replace(/ android:networkSecurityConfig="[^"]*"/g, '')
xml = xml.replace(/<application\b/, '<application android:networkSecurityConfig="@xml/bilimusic_network_security"')
await writeFile(manifest, xml)
await mkdir(new URL('res/xml/', base), { recursive: true })
await writeFile(new URL('res/xml/bilimusic_network_security.xml', base), `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="system" /></trust-anchors></base-config>
  <domain-config cleartextTrafficPermitted="true"><domain>127.0.0.1</domain><domain>localhost</domain></domain-config>
</network-security-config>
`)
console.log('Android: cleartext allowed only for the on-device media proxy.')
