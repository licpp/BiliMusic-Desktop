import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const result = await build({ entryPoints: ['src/features/player/resumePolicy.ts'], bundle: true, write: false, platform: 'node', format: 'cjs' })
const module = { exports: {} }
new Function('require', 'module', 'exports', result.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
const policy = module.exports
const cases = JSON.parse(await readFile('tests/fixtures/resume-policy.json', 'utf8'))

test('single-video resume shares boundary, disabled and collection semantics with native playback', () => {
  for (const row of cases) assert.equal(policy.shouldResumeVideo(row.threshold, row.duration, row.collection), row.resume, JSON.stringify(row))
  assert.equal(policy.shouldResumeVideo(600, NaN), false)
  assert.equal(policy.shouldResumeVideo(600, Infinity), false)
})

test('slider runs from disabled through decreasing 60–1 minute thresholds to resume all', () => {
  assert.equal(policy.resumeThresholdAt(0), null)
  assert.equal(policy.resumeThresholdAt(policy.RESUME_SLIDER_MAX), 0)
  let previous = Infinity
  for (let step = 0; step <= policy.RESUME_SLIDER_MAX; step++) {
    const threshold = policy.resumeThresholdAt(step)
    assert.equal(policy.resumeSliderValue(threshold), step)
    if (threshold !== null) { assert.ok(threshold < previous); previous = threshold }
  }
  assert.equal(policy.resumeThresholdAt(-10), null)
  assert.equal(policy.resumeThresholdAt(1000), 0)
  assert.equal(policy.resumeThresholdAt(1), 3600)
})

test('stored resume thresholds normalize to valid minute steps and preserve both endpoints', () => {
  for (const [input, expected] of [[null,null],[0,0],[600,600],[599,600],[1,60],[99999,3600],[NaN,0],[-10,0],['600',0]]) {
    assert.equal(policy.normalizeResumeThreshold(input), expected)
  }
})

test('collections and multipart video identity remain exempt without exempting ordinary song queues', () => {
  const one = { id:'one',source:{bvid:'BV1',page:1} }
  const other = { id:'other',source:{bvid:'BV2',page:1} }
  assert.equal(policy.isCollectionPlayback(one, [one,other]), false)
  assert.equal(policy.isCollectionPlayback(one, [one], {kind:'season'}), true)
  assert.equal(policy.isCollectionPlayback(one, [one], {kind:'video',collectionRef:'BV1'}), true)
  assert.equal(policy.isCollectionPlayback({...one,partCount:2}, [one]), true)
  assert.equal(policy.isCollectionPlayback({...one,source:{...one.source,page:2}}, []), true)
  assert.equal(policy.isCollectionPlayback(one, [one,{...one,id:'part2'}]), true)
})
