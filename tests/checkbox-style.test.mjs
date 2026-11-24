import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('checked inputs paint their mark directly and keep the checked fill in light mode', async () => {
  const css = await readFile('src/styles/controls.css', 'utf8')
  const input = 'input[type="checkbox"]:not([data-native])'
  const layout = ':not([data-layout="large"])'
  const normal = `:root[data-theme="light"]${layout} ${input} {`
  const checked = `:root${layout} ${input}:checked {`
  const start = css.indexOf(checked)
  const rule = css.slice(start, css.indexOf('}', start))

  assert.ok(css.indexOf(normal) >= 0 && css.indexOf(normal) < start)
  assert.match(rule, /background-color:\s*var\(--checkbox-accent,\s*var\(--cyan\)\)/)
  assert.match(rule, /background-image:\s*linear-gradient\(/)
  assert.match(css, /input\[type="checkbox"\]\.track-select\s*\{\s*--checkbox-accent:\s*var\(--coral\)/)
})

test('matching song information uses the shared mark without its own input styles', async () => {
  const css = await readFile('src/styles/components/lyrics.css', 'utf8')
  assert.doesNotMatch(css, /\.lyric-match-option\s+input\b/)
})
