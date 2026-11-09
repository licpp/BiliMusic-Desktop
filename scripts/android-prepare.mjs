// Run after `tauri android init`. Keep generated Gradle scaffolding reproducible.
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises'
const base = new URL('../src-tauri/gen/android/app/src/main/', import.meta.url)
const manifest = new URL('AndroidManifest.xml', base)
let xml = await readFile(manifest, 'utf8')
xml = xml.replace(/ android:networkSecurityConfig="[^"]*"/g, '')
xml = xml.replace(/<application\b/, '<application android:networkSecurityConfig="@xml/bilimusic_network_security"')
// Keep the current WebView and video when the app requests landscape.
xml = xml.replace(/<activity\b[^>]*>/g, activity => {
  if (!/android:name="[^"]*MainActivity"/.test(activity)) return activity
  const existing = activity.match(/android:configChanges="([^"]*)"/)
  const changes = new Set([...(existing?.[1].split('|') || []), 'orientation', 'screenSize', 'screenLayout', 'smallestScreenSize'])
  const attribute = `android:configChanges="${[...changes].join('|')}"`
  return existing ? activity.replace(existing[0], attribute) : activity.replace('<activity', `<activity ${attribute}`)
})
await writeFile(manifest, xml)
await mkdir(new URL('res/xml/', base), { recursive: true })
await writeFile(new URL('res/xml/bilimusic_network_security.xml', base), `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false"><trust-anchors><certificates src="system" /></trust-anchors></base-config>
  <domain-config cleartextTrafficPermitted="true"><domain includeSubdomains="false">127.0.0.1</domain><domain includeSubdomains="false">localhost</domain></domain-config>
</network-security-config>
`)
console.log('Android: cleartext allowed only for the on-device media proxy.')

await cp(new URL('../src-tauri/.android-icons/android/', import.meta.url), new URL('res/', base), { recursive: true })
