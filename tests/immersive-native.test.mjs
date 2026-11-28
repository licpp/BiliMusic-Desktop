import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

// These platforms cannot be compiled on a Windows checkout. The contract is
// kept by the native sources themselves so a renamed action or a dropped
// restore path fails here before it reaches a device build.
const swift = await readFile('native/ios-player/ios/Sources/PlayerPlugin.swift', 'utf8')
const harmony = await readFile('native/ohos-player/ohos/PlayerPlugin.ets', 'utf8')
const android = await readFile('native/android-player/android/src/main/java/PlayerPlugin.kt', 'utf8')

test('the shared frontend and every mobile engine expose the same immersive action', () => {
  assert.match(swift, /case "immersive":\s*setImmersive\(args\.value == 1, keepSystemInsets: args\.keepSystemInsets == true\)/)
  assert.match(harmony, /'immersive'/)
  assert.match(harmony, /setWindowSystemBarEnable/)
  assert.match(android, /args\.action == "immersive"/)
  assert.match(android, /keepSystemInsets/)
})

test('iOS restores the status bar and home indicator it captured for immersion', () => {
  assert.match(swift, /private func setImmersive\(_ enabled: Bool, keepSystemInsets: Bool\)/)
  assert.match(swift, /chromeBase = \(controller\.prefersStatusBarHidden, controller\.prefersHomeIndicatorAutoHidden\)/)
  assert.match(swift, /setPrefersStatusBarHidden:/)
  assert.match(swift, /setPrefersHomeIndicatorAutoHidden:/)
  assert.match(swift, /setNeedsStatusBarAppearanceUpdate\(\)/)
  assert.match(swift, /setNeedsUpdateOfHomeIndicatorAutoHidden\(\)/)
  // Video fullscreen shares the same flags: both overrides compose from one
  // capture, and fullscreen restores through the same helper.
  assert.match(swift, /let overridden = fullscreenState != nil \|\| immersive/)
  assert.match(swift, /let hidden = fullscreenState != nil \|\| \(immersive && !immersiveKeepsStatusBar\)/)
  assert.match(swift, /if !overridden \{ chromeBase = nil \}/)
  assert.match(swift, /if !enabled \{ fullscreenState = nil \}\s*\n\s*applySystemBars\(controller\)/)
})

test('Harmony hides and restores both system bars around immersive lyrics', () => {
  assert.match(harmony, /private async setImmersive\(active: boolean, keepSystemInsets: boolean\)/)
  assert.match(harmony, /setWindowSystemBarEnable\(hidden \? \[\] : bars\)/)
  assert.match(harmony, /const hidden = active && !keepSystemInsets;/)
  assert.match(harmony, /args\.action === 'immersive'/)
})
