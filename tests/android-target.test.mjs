import test from 'node:test'
import assert from 'node:assert/strict'
import { androidLargeScreenTarget, androidTarget } from '../scripts/android-target.mjs'

test('ARM64 stays the default and ARMv7 names the 32-bit Rust target and APK ABI', () => {
  assert.deepEqual(androidTarget(), { targets: ['aarch64'], rust: ['aarch64-linux-android'], abis: ['arm64-v8a'], label: 'arm64', args: [] })
  for (const args of [['--target', 'armv7'], ['-t', 'armv7'], ['--target=armv7']]) {
    assert.deepEqual(androidTarget(args), { targets: ['armv7'], rust: ['armv7-linux-androideabi'], abis: ['armeabi-v7a'], label: 'armv7', args: [] })
  }
})

test('the car build defaults to one APK with both ARM ABIs and retains single-ABI diagnostics', () => {
  assert.deepEqual(androidLargeScreenTarget(['--ci']), {
    targets: ['aarch64', 'armv7'],
    rust: ['aarch64-linux-android', 'armv7-linux-androideabi'],
    abis: ['arm64-v8a', 'armeabi-v7a'],
    label: 'universal',
    args: ['--ci'],
  })
  assert.deepEqual(androidLargeScreenTarget(['--target=armv7']), androidTarget(['--target=armv7']))
  assert.throws(() => androidLargeScreenTarget(['--split-per-abi']))
})

test('build flags survive while duplicate or unsupported targets fail before building', () => {
  assert.deepEqual(androidTarget(['--debug', '--target', 'armv7', '--ci']).args, ['--debug', '--ci'])
  assert.deepEqual(androidTarget(['--', '--target', 'gradle-option']).args, ['--', '--target', 'gradle-option'])
  for (const args of [['--target'], ['--target', 'x86_64'], ['--target='], ['-t', 'armv7', '--target=aarch64']]) {
    assert.throws(() => androidTarget(args))
  }
})
