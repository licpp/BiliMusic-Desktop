import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const load = async path => {
  const { outputFiles } = await build({ entryPoints: [path], bundle: true, write: false, format: 'esm' })
  return import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
}
const { installDirectionalFocus, focusable } = await load('src/large-screen/focus.ts')
const { progressKeyAction } = await load('src/large-screen/playerNavigation.ts')

function fixture(run, wide = false) {
  const saved = { document: globalThis.document, window: globalThis.window, getComputedStyle: globalThis.getComputedStyle }
  const handlers = new Map()
  const region = name => ({ name, matches: selector => selector.split(',').includes(`.${name}`), contains: el => el.region?.name === name })
  const header = region('large-player-header'), info = region('large-player-info'), lyrics = region('large-lyrics'), footer = region('large-player-footer')
  const main = { contains: () => true, getBoundingClientRect: () => ({ top: 0, bottom: 700 }) }
  const el = (id, region, left, top, width = 80, height = 44) => ({
    id, region, tabIndex: 0, isConnected: true, dataset: { focus: id },
    matches: selector => selector === 'input[type="range"]' && id === 'playback-seek',
    closest: selector => {
      if (selector === '.large-main') return main
      if (selector === '.large-player[data-wide-media]') return wide ? main : null
      if (selector === '.large-progress' && id === 'playback-seek' ||
          selector.includes('.large-player-info>.large-progress') && ['playback-seek', 'play'].includes(id)) return {}
      return selector.split(',').includes(`.${region.name}`) ? region : null
    },
    getAttribute: () => null, hasAttribute: () => false, getClientRects: () => [{}],
    getBoundingClientRect: () => ({ left, top, width, height }),
    focus() { document.activeElement = this; handlers.get('focusin')?.({ target: this }) },
  })
  const back = el('player-back', header, 20, 20), video = el('player-video', header, 800, 20), queue = el('queue', header, 900, 20)
  const progress = el('playback-seek', info, 100, 440, 400), play = el('play', info, 270, 520)
  const first = el('first-lyric', lyrics, 570, 160, 450), last = el('last-lyric', lyrics, 570, 220, 450), tools = el('tools', footer, 800, 640)
  let elements = [back, video, queue, progress, play, first, last, tools], scopes = []
  const shell = { querySelectorAll: () => elements }
  globalThis.document = { activeElement: null, querySelectorAll: () => scopes, querySelector: selector => selector === '.large-shell' ? shell : selector === '.large-main' ? main : null, addEventListener: (name, fn) => handlers.set(name, fn), removeEventListener() {} }
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  globalThis.getComputedStyle = () => ({ visibility: 'visible' })
  const cleanup = installDirectionalFocus()
  const press = (target, key) => {
    target.focus()
    handlers.get('keydown')({ target, key, defaultPrevented: false, preventDefault() {} })
    return document.activeElement.id
  }
  try { run({ back, video, queue, progress, play, first, last, tools, press, el, info, setElements: value => { elements = value }, setScopes: value => { scopes = value } }) }
  finally { cleanup(); Object.assign(globalThis, saved) }
}

test('lyric left exits to media controls even when no controls overlap the selected row', () => {
  fixture(h => {
    assert.equal(h.press(h.first, 'ArrowLeft'), 'playback-seek')
    assert.equal(h.press(h.last, 'ArrowLeft'), 'playback-seek')
  })
})
test('lyric right returns to the remembered header button; a missing one falls back safely', () => {
  fixture(h => {
    h.queue.focus()
    assert.equal(h.press(h.first, 'ArrowRight'), 'queue')
    h.queue.isConnected = false; h.setElements([h.back, h.video, h.progress, h.first])
    assert.equal(h.press(h.first, 'ArrowRight'), 'player-video')
    h.setElements([h.back, h.video, h.first])
    assert.equal(h.press(h.first, 'ArrowLeft'), 'player-video')
  })
})
test('progress up and lyric boundaries connect to header/footer without a geometric dead end', () => {
  fixture(h => {
    h.video.focus()
    assert.equal(h.press(h.progress, 'ArrowUp'), 'player-video')
    assert.equal(h.press(h.first, 'ArrowUp'), 'player-video')
    assert.equal(h.press(h.last, 'ArrowDown'), 'tools')
    assert.equal(h.press(h.progress, 'ArrowDown'), 'play')
  })
})
test('fullscreen or modal scopes do not escape into the background player header', () => {
  fixture(h => {
    h.video.focus()
    const close = h.el('modal-close', h.info, 100, 100)
    const modal = { closest: () => null, getClientRects: () => [{}], querySelectorAll: () => [close, h.progress] }
    h.setScopes([modal])
    assert.equal(h.press(h.progress, 'ArrowUp'), 'modal-close')
  })
})
test('video progress up visits fullscreen before the header, while cover mode has no extra stop', () => {
  fixture(h => {
    const fullscreen = h.el('video-fullscreen', h.info, 470, 350)
    fullscreen.getAttribute = name => name === 'data-focus-up' ? 'player-back' : null
    h.setElements([h.back, h.video, h.queue, fullscreen, h.progress, h.play, h.first])
    assert.equal(h.press(h.progress, 'ArrowUp'), 'video-fullscreen')
    assert.equal(h.press(fullscreen, 'ArrowUp'), 'player-back')
    h.setElements([h.back, h.video, h.queue, h.progress, h.play, h.first])
    assert.equal(h.press(h.progress, 'ArrowUp'), 'player-back')
    h.video.focus()
    assert.equal(h.press(h.progress, 'ArrowUp'), 'player-video')
  })
})
test('the short player navigates between transport and the tools in its single horizontal row', () => {
  fixture(h => {
    assert.equal(h.press(h.progress, 'ArrowRight'), 'play')
    assert.equal(h.press(h.play, 'ArrowRight'), 'tools')
    assert.equal(h.press(h.tools, 'ArrowLeft'), 'play')
  }, true)
})
test('closed settings disclosures exclude retained rectangles, including nested summaries', () => {
  fixture(h => {
    const disclosure = (parentElement = null) => ({
      open: false, parentElement, children: [],
      closest() { return this.open ? this.parentElement?.closest() : this },
    })
    const outer = disclosure(), inner = disclosure(outer)
    const summary = h.el('resume-summary', h.info, 100, 100)
    const nested = h.el('nested-summary', h.info, 100, 150)
    const range = h.el('resume-range', h.info, 100, 210)
    const system = h.el('system-title', h.info, 100, 270)
    const cache = h.el('cache-summary', h.info, 100, 330)
    const hiddenClear = h.el('cache-clear', h.info, 100, 370)
    const theme = h.el('theme', h.info, 700, 420)
    summary.parentElement = outer; nested.parentElement = inner; range.parentElement = inner
    outer.children = [{ tagName: 'SUMMARY', contains: el => el === summary }]
    inner.children = [{ tagName: 'SUMMARY', contains: el => el === nested }]
    const cacheDetails = disclosure(); cache.parentElement = cacheDetails; hiddenClear.parentElement = cacheDetails
    cacheDetails.children = [{ tagName: 'SUMMARY', contains: el => el === cache }]
    const controls = [summary, nested, range, system, cache, hiddenClear, theme]
    const visible = () => focusable({ querySelectorAll: () => controls })
    assert.deepEqual(visible().map(el => el.id), ['resume-summary', 'system-title', 'cache-summary', 'theme'])
    h.setElements(controls)
    assert.equal(h.press(summary, 'ArrowDown'), 'system-title')
    assert.equal(h.press(system, 'ArrowDown'), 'cache-summary')
    assert.equal(h.press(cache, 'ArrowDown'), 'theme')
    assert.equal(h.press(theme, 'ArrowUp'), 'cache-summary')
    outer.open = true
    assert.ok(visible().includes(nested)); assert.ok(!visible().includes(range))
    inner.open = true
    assert.ok(visible().includes(range))
    outer.open = false
    assert.ok(!visible().includes(nested)); assert.ok(!visible().includes(range))
  })
})
test('progress editing consumes left/right but releases up/down without committing a seek', () => {
  assert.deepEqual(progressKeyAction('Enter', null, 60, 300), { kind: 'draft', value: 60 })
  assert.deepEqual(progressKeyAction('ArrowRight', 60, 60, 300), { kind: 'draft', value: 65 })
  assert.deepEqual(progressKeyAction('ArrowRight', 60, 60, 300, true), { kind: 'draft', value: 75 })
  assert.deepEqual(progressKeyAction('ArrowLeft', 2, 60, 300), { kind: 'draft', value: 0 })
  assert.deepEqual(progressKeyAction('ArrowRight', 299, 60, 300), { kind: 'draft', value: 300 })
  for (const key of ['ArrowUp', 'ArrowDown']) {
    assert.equal(progressKeyAction(key, null, 60, 300), undefined)
    assert.deepEqual(progressKeyAction(key, 65, 60, 300), { kind: 'leave' })
  }
  assert.deepEqual(progressKeyAction('Enter', 65, 60, 300), { kind: 'seek', value: 65 })
  assert.deepEqual(progressKeyAction('Escape', 65, 60, 300), { kind: 'draft', value: null })
})
