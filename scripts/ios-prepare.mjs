// Keep the ignored Xcode scaffold reproducible; do not keep private signing settings in Git.
import { readdir, cp, writeFile } from 'node:fs/promises'
const root = new URL('../src-tauri/gen/apple/', import.meta.url)
const matches = []
async function find(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'build' || entry.name.startsWith('.')) continue
    const child = new URL(`${entry.name}/`, dir)
    if (entry.name === 'AppIcon.appiconset') matches.push(child)
    else await find(child)
  }
}
await find(root)
if (matches.length !== 1) throw new Error(`Expected one iOS app icon set, found ${matches.length}`)
await cp(new URL('../src-tauri/.ios-icons/ios/', import.meta.url), matches[0], { recursive: true })
const entries = [
  ['iphone','20x20','2x','20x20@2x'], ['iphone','20x20','3x','20x20@3x'],
  ['iphone','29x29','2x','29x29@2x'], ['iphone','29x29','3x','29x29@3x'],
  ['iphone','40x40','2x','40x40@2x'], ['iphone','40x40','3x','40x40@3x'],
  ['iphone','60x60','2x','60x60@2x'], ['iphone','60x60','3x','60x60@3x'],
  ['ipad','20x20','1x','20x20@1x'], ['ipad','20x20','2x','20x20@2x-1'],
  ['ipad','29x29','1x','29x29@1x'], ['ipad','29x29','2x','29x29@2x-1'],
  ['ipad','40x40','1x','40x40@1x'], ['ipad','40x40','2x','40x40@2x-1'],
  ['ipad','76x76','1x','76x76@1x'], ['ipad','76x76','2x','76x76@2x'],
  ['ipad','83.5x83.5','2x','83.5x83.5@2x'], ['ios-marketing','1024x1024','1x','512@2x'],
]
await writeFile(new URL('Contents.json', matches[0]), JSON.stringify({
  images: entries.map(([idiom,size,scale,name]) => ({idiom,size,scale,filename:`AppIcon-${name}.png`})),
  info: {author:'xcode',version:1},
}, null, 2))
console.log('iOS app icons prepared; signing is performed separately on your own device account.')
