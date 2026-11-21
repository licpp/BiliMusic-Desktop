import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'

async function load(file, plugins = []) {
  const { outputFiles: [output] } = await build({ entryPoints: [file], bundle: true, format: 'esm', write: false, plugins })
  return import('data:text/javascript;base64,' + Buffer.from(output.text).toString('base64'))
}

const { trackSwipeDirection, dragDismissDirection, navigationSwipeDirection, swipeAxis, edgeSwipeOffset, edgeBackTiming, edgeBackDirection } = await load('src/shared/gestureRelease.ts')
const { afterListMotion, holdListUpdates, listUpdatesHeld } = await load('src/shared/navigationListMotion.ts')
const { listPlaceholderDelay, listRevealDelay } = await load('src/shared/listLoadingTiming.ts')
const { animatePage } = await load('src/shared/pageMotion.ts')
const { slideNavigation } = await load('src/shared/slideNavigation.ts')
const { captureStagePreview } = await load('src/app/stageBackPreview.ts')
const { dispatchBack, installOverlayBack, isTopOverlay, registerOverlay, lockDialogBackground } = await load('src/shared/overlayStack.ts')
const { installMobileGestures } = await load('src/shared/mobileGestures.ts', [{
  name: 'mobile-platform',
  setup(builder) {
    builder.onResolve({ filter: /^\.\.\/services\/platform$/ }, () => ({ path: 'mobile', namespace: 'test' }))
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const isMobile=true, isIOS=false' }))
  },
}])

test('a gesture commits only after release distance or release velocity passes its threshold', () => {
  assert.equal(trackSwipeDirection(-53, 500), 0)
  assert.equal(trackSwipeDirection(-54, 500), -1)
  assert.equal(trackSwipeDirection(27, 50), 1)
  assert.equal(trackSwipeDirection(23, 10), 0)
  assert.equal(dragDismissDirection(63, 500), 0)
  assert.equal(dragDismissDirection(64, 500), 1)
  assert.equal(dragDismissDirection(-30, 50), -1)
  assert.equal(dragDismissDirection(-10, 1), 0)
})

test('only a rightward release can pop a page and a dock drag has a single axis', () => {
  assert.equal(navigationSwipeDirection(-120, 80, true), 0)
  assert.equal(navigationSwipeDirection(23, 30, true), 0)
  assert.equal(navigationSwipeDirection(38, 30, true), 1)
  assert.equal(navigationSwipeDirection(45, 65, true), 1)
  assert.equal(navigationSwipeDirection(-92, 400, false, 393), -1)
  assert.equal(navigationSwipeDirection(-92, 400, false, 768), 0)
  assert.equal(navigationSwipeDirection(-48, 40, false, 768), -1)
  assert.equal(swipeAxis(22, -22), undefined)
  assert.equal(swipeAxis(32, -20), 'horizontal')
  assert.equal(swipeAxis(20, -32), 'vertical')
})

test('edge tracking is linear beyond touch slop and release timing follows the remaining distance', () => {
  assert.deepEqual([0, 10, 40, 80, 130, 600].map(distance => edgeSwipeOffset(distance, 393)), [0, 0, 30, 70, 120, 393])
  assert.equal(edgeBackDirection(65, 393, 0), 0)
  assert.equal(edgeBackDirection(65, 393, -.8), 0)
  assert.equal(edgeBackDirection(65, 393, .8), 1)
  assert.equal(edgeBackDirection(100, 393, 0), 1)
  const slow = edgeBackTiming(270, 393)
  assert.ok(slow.duration > 310)
  assert.ok(edgeBackTiming(270, 393, 1.4).duration < slow.duration)
  assert.ok(edgeBackTiming(-270, 393, -1.4).duration < slow.duration)
  assert.equal(edgeBackTiming(-270, 393, 1.4).duration, slow.duration)
})

test('list results wait across the handoff from touch tracking to the release animation', () => {
  const original = globalThis.requestAnimationFrame
  const frames = []
  globalThis.requestAnimationFrame = callback => frames.push(callback)
  try {
    const doneDragging = holdListUpdates()
    const calls = []
    const remove = afterListMotion(() => calls.push('unmounted'))
    afterListMotion(() => calls.push('ready'))
    const doneSettling = holdListUpdates()
    doneDragging()
    remove()
    assert.equal(listUpdatesHeld(), true)
    assert.equal(frames.length, 0)
    doneSettling()
    doneSettling()
    assert.equal(listUpdatesHeld(), true)
    assert.deepEqual(calls, [])
    frames.shift()()
    assert.deepEqual(calls, [])
    const interrupt = holdListUpdates()
    frames.shift()()
    assert.deepEqual(calls, [])
    interrupt()
    frames.shift()()
    assert.deepEqual(calls, [])
    frames.shift()()
    assert.deepEqual(calls, ['ready'])
    assert.equal(listUpdatesHeld(), false)
  } finally { globalThis.requestAnimationFrame = original }
})

test('a cached pane waits for a fresh painted frame when a swipe starts before it mounts', () => {
  const original = globalThis.requestAnimationFrame
  const frames = []
  globalThis.requestAnimationFrame = callback => frames.push(callback)
  try {
    let mounts = 0
    afterListMotion(() => mounts++)
    frames.shift()()
    const finishSwipe = holdListUpdates()
    frames.shift()()
    assert.equal(mounts, 0)

    finishSwipe()
    frames.shift()()
    assert.equal(mounts, 0)
    frames.shift()()
    assert.equal(mounts, 1)
  } finally { globalThis.requestAnimationFrame = original }
})

test('fast list loads skip the placeholder and a visible placeholder has time to settle', () => {
  const start = 1000
  const appears = start + listPlaceholderDelay
  assert.equal(listRevealDelay(undefined, appears), 0)
  assert.equal(listRevealDelay(start, appears - 1), 0)
  assert.equal(listRevealDelay(start, appears), 180)
  assert.equal(listRevealDelay(start, appears + 60), 120)
  assert.equal(listRevealDelay(start, appears + 180), 0)
  assert.equal(listRevealDelay(start, appears + 900), 0)
})

test('new navigation interrupts an earlier animation and respects reduced motion', async () => {
  const original = globalThis.window
  const media = Object.assign(new EventTarget(), { matches: false })
  globalThis.window = { matchMedia: () => media }
  const calls = []
  const target = { animate(frames, options) {
    const { promise: finished, resolve, reject } = Promise.withResolvers()
    const animation = { finished, cancel: () => reject(Error('cancelled')), finish: () => resolve() }
    calls.push({ frames, options, animation })
    return animation
  } }
  try {
    const incoming = animatePage(target, 'forward', true)
    const returning = animatePage(target, 'back', true)
    assert.match(calls[0].frames[0].transform, /\(34px/)
    assert.match(calls[1].frames[0].transform, /\(-34px/)
    assert.deepEqual(calls[1].frames.map(frame => frame.opacity), [1, 1])
    await assert.rejects(incoming.finished)
    media.matches = true
    media.dispatchEvent(new Event('change'))
    await returning.finished
    assert.equal(animatePage(target, 'player', true), undefined)
    assert.equal(calls.length, 2)
  } finally { globalThis.window = original }
})

test('an interactive back preview can reuse loaded covers before the drag begins', () => {
  const original = globalThis.HTMLImageElement
  class Cover {
    loading = 'lazy'
    removeAttribute() {}
  }
  const visible = Object.assign(new Cover(), { complete: true, naturalWidth: 320 })
  const unloaded = Object.assign(new Cover(), { complete: false, naturalWidth: 0 })
  const copies = [new Cover(), new Cover()]
  const preview = { append() {} }
  const visibleCopy = { removeAttribute() {}, querySelectorAll: selector => selector === '*' ? copies : [] }
  const activeStage = { matches: () => false, cloneNode: () => visibleCopy, querySelectorAll: () => [visible, unloaded] }
  const hiddenStage = { matches: () => true, cloneNode: () => assert.fail('Hidden pages must not be cloned') }
  globalThis.HTMLImageElement = Cover
  try {
    captureStagePreview({ cloneNode: () => preview, children: [activeStage, hiddenStage] })
    assert.deepEqual(copies.map(copy => copy.loading), ['eager', 'lazy'])
    assert.equal(visible.loading, 'lazy')
  } finally { globalThis.HTMLImageElement = original }
})

test('interactive navigation holds the release frame until the route is committed', async () => {
  const original = globalThis.window
  const reduced = Object.assign(new EventTarget(), { matches: false })
  globalThis.window = { matchMedia: () => reduced }
  const { promise: finished, resolve } = Promise.withResolvers()
  let frames, timing
  const calls = []
  const target = { isConnected: true, animate(value, options) {
    frames = value; timing = options
    return { finished, cancel: () => calls.push('release frame'), finish: resolve }
  } }
  try {
    slideNavigation(target, 217, 393, 215, () => calls.push('commit route'))
    assert.equal(frames[0].transform, 'translate3d(217px,0,0)')
    assert.equal(frames[1].transform, 'translate3d(393px,0,0)')
    assert.equal(timing.fill, 'forwards')
    assert.deepEqual(calls, [])
    resolve()
    await finished
    assert.deepEqual(calls, ['commit route', 'release frame'])
    reduced.matches = true
    slideNavigation(target, 80, 393, 215, () => calls.push('commit without animation'))
    assert.equal(calls.at(-1), 'commit without animation')
  } finally { globalThis.window = original }
})

test('a swipe keeps the selected indicator and the panel in step through release', async () => {
  const original = globalThis.window
  const reduced = Object.assign(new EventTarget(), { matches: false })
  globalThis.window = { matchMedia: () => reduced }
  const calls = []
  const target = label => ({
    ...Promise.withResolvers(),
    isConnected: true,
    animate(frames, timing) {
      calls.push({ label, frames, timing })
      return { finished: this.promise, cancel: () => calls.push(label), finish: this.resolve }
    },
  })
  const panel = target('panel')
  const indicator = target('indicator')
  try {
    slideNavigation(panel, -180, -393, 215, () => calls.push('commit'), {
      element: indicator, from: 53, to: 117,
    })
    assert.equal(calls[1].frames[0].transform, 'translate3d(53px,0,0)')
    assert.equal(calls[1].frames[1].transform, 'translate3d(117px,0,0)')
    assert.deepEqual(calls[1].timing, calls[0].timing)
    panel.resolve()
    await panel.promise
    assert.equal(calls.length, 2)
    indicator.resolve()
    await Promise.all([panel.promise, indicator.promise])
    assert.deepEqual(calls.slice(2), ['commit', 'indicator', 'panel'])
  } finally { globalThis.window = original }
})

test('releasing a swipe starts at the painted frame and arrives at the next fixed pane', async () => {
  const callbacks = new Map()
  const animations = []
  const { promise: finished, resolve } = Promise.withResolvers()
  class Surface extends EventTarget {
    attributes = new Set()
    style = { transform: '', getPropertyValue: () => '1', removeProperty: key => { this.style[key] = '' } }
    isConnected = true
    getBoundingClientRect() { return { width: this.width } }
    hasAttribute(name) { return this.attributes.has(name) }
    setAttribute(name) { this.attributes.add(name) }
    removeAttribute(name) { this.attributes.delete(name) }
    animate(frames) {
      animations.push(frames.map(frame => frame.transform))
      return { finished, cancel() {}, finish: resolve }
    }
  }
  const pager = Object.assign(new Surface(), { dataset: {}, matches: () => false })
  const track = Object.assign(new Surface(), { width: 393 })
  const indicator = Object.assign(new Surface(), { width: 118 })
  pager.querySelector = selector => selector.includes('track') ? track : indicator
  pager.setAttribute('data-swipe-next')
  pager.setAttribute('data-animate-tab-tap')
  const row = Object.assign(new Surface(), { closest: selector => selector === '[data-swipe-tabs]' ? pager : null })
  const doc = new EventTarget()
  const send = (type, distance) => {
    const point = { clientX: 320 + distance, clientY: 300 }
    const event = new Event(type, { cancelable: true })
    Object.defineProperties(event, {
      target: { value: row }, touches: { value: [point] }, changedTouches: { value: [point] },
    })
    doc.dispatchEvent(event)
  }
  const original = {}
  const reduced = Object.assign(new EventTarget(), { matches: false })
  let nextFrame = 0
  for (const [key, value] of Object.entries({ document: doc, Element: Surface, window: { matchMedia: () => reduced },
    requestAnimationFrame: callback => { callbacks.set(++nextFrame, callback); return nextFrame },
    cancelAnimationFrame: frame => callbacks.delete(frame) })) {
    original[key] = globalThis[key]
    globalThis[key] = value
  }
  let selected = 1
  pager.addEventListener('bilimusic-tab-swipe', event => { selected += event.detail })
  try {
    installMobileGestures()
    send('touchstart', 0)
    send('touchmove', -35)
    send('touchmove', -120)
    assert.equal(pager.hasAttribute('data-animate-tab-tap'), false)
    assert.equal(callbacks.size, 1)
    const [[frame, paint]] = callbacks
    callbacks.delete(frame)
    paint()
    assert.equal(track.style.transform, 'translate3d(-513px,0,0)')
    const paintedIndicator = indicator.style.transform
    send('touchmove', -160)
    send('touchend', -160)
    assert.equal(callbacks.size, 0)
    assert.deepEqual(animations, [
      ['translate3d(-513px,0,0)', 'translate3d(-786px,0,0)'],
      [paintedIndicator, 'translate3d(236px,0,0)'],
    ])
    assert.equal(selected, 1)
    resolve()
    await Promise.all([finished])
    assert.equal(selected, 2)
    assert.equal(track.style.transform, '')
    assert.equal(pager.hasAttribute('data-navigation-drag'), false)
  } finally { Object.assign(globalThis, original) }
})

test('native back lets the keyboard consume first, then closes one overlay at a time', () => {
  const original = globalThis.window
  globalThis.window = new EventTarget()
  try {
    const closed = []
    let keyboard = true
    window.addEventListener('bilimusic-back', event => {
      if (!keyboard) return
      keyboard = false
      event.preventDefault()
      event.stopImmediatePropagation()
    })
    installOverlayBack()
    window.addEventListener('bilimusic-back', () => closed.push('page'))
    const queue = {}, menu = {}
    const removeQueue = registerOverlay(queue, () => { closed.push('queue'); removeQueue() })
    const removeMenu = registerOverlay(menu, () => { closed.push('menu'); removeMenu() })
    assert.equal(isTopOverlay(menu), true)
    assert.equal(dispatchBack(), true)
    assert.deepEqual(closed, [])
    assert.equal(dispatchBack(), true)
    assert.deepEqual(closed, ['menu'])
    assert.equal(isTopOverlay(queue), true)
    assert.equal(dispatchBack(), true)
    assert.deepEqual(closed, ['menu', 'queue'])
    assert.equal(dispatchBack(), false)
    assert.deepEqual(closed, ['menu', 'queue', 'page'])
  } finally {
    globalThis.window = original
  }
})

test('overlapping modal lifetimes release background only after the last dialog', () => {
  const attributes = new Set()
  const root = { inert: false, hasAttribute: name => attributes.has(name), toggleAttribute: (name, force) => force ? attributes.add(name) : attributes.delete(name) }
  const releaseOuter = lockDialogBackground(root)
  const releaseInner = lockDialogBackground(root)
  releaseOuter()
  releaseOuter()
  assert.equal(root.inert, true)
  assert.equal(root.hasAttribute('inert'), true)
  releaseInner()
  assert.equal(root.inert, false)
  assert.equal(root.hasAttribute('inert'), false)
})

test('iOS left-edge swipe returns to previous tab before popping the page', async () => {
  const { installMobileGestures: installIOSGestures } = await load('src/shared/mobileGestures.ts', [{
    name: 'ios-platform',
    setup(builder) {
      builder.onResolve({ filter: /^\.\.\/services\/platform$/ }, () => ({ path: 'ios', namespace: 'test' }))
      builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const isMobile=true, isIOS=true' }))
    },
  }])
  class Surface extends EventTarget {
    attributes = new Set()
    style = { transform: '', props: {}, getPropertyValue: k => this.style.props[k] || '1', setProperty: (k, v) => { this.style.props[k] = v }, removeProperty: k => { delete this.style.props[k]; this.style[k] = '' } }
    isConnected = true
    width = 393
    dataset = { stageRoute: 'creator' }
    getBoundingClientRect() { return { width: this.width } }
    hasAttribute(name) { return this.attributes.has(name) }
    setAttribute(name) { this.attributes.add(name) }
    removeAttribute(name) { this.attributes.delete(name) }
    matches() { return false }
  }
  const page = new Surface()
  const pageTrack = new Surface()
  page.querySelector = () => pageTrack
  const pager = new Surface()
  const tabTrack = new Surface()
  pager.querySelector = selector => selector.includes('track') ? tabTrack : null
  pager.setAttribute('data-swipe-previous')
  const row = Object.assign(new Surface(), {
    closest: selector => selector === '[data-edge-back]' ? page : selector === '[data-swipe-tabs]' ? pager : null,
  })
  const doc = new EventTarget()
  const win = Object.assign(new EventTarget(), {
    innerWidth: 393,
    matchMedia: () => Object.assign(new EventTarget(), { matches: true }),
  })
  const events = []
  pager.addEventListener('bilimusic-tab-swipe', event => events.push(`tab:${event.detail}`))
  win.addEventListener('bilimusic-back', () => events.push('back'))
  const original = {}
  for (const [key, value] of Object.entries({ document: doc, Element: Surface, window: win,
    requestAnimationFrame: cb => { cb(0); return 0 }, cancelAnimationFrame: () => {} })) {
    original[key] = globalThis[key]
    globalThis[key] = value
  }
  const swipeFromLeftEdge = () => {
    for (const [type, x, timeStamp] of [['touchstart', 10, 0], ['touchmove', 160, 40], ['touchend', 160, 80]]) {
      const point = { clientX: x, clientY: 260 }
      const event = new Event(type, { cancelable: true })
      Object.defineProperties(event, {
        target: { value: row }, touches: { value: [point] }, changedTouches: { value: [point] }, timeStamp: { value: timeStamp },
      })
      doc.dispatchEvent(event)
    }
  }
  try {
    installIOSGestures()
    swipeFromLeftEdge()
    assert.deepEqual(events, ['tab:-1'])
    pager.removeAttribute('data-swipe-previous')
    swipeFromLeftEdge()
    assert.deepEqual(events, ['tab:-1', 'back'])
  } finally { Object.assign(globalThis, original) }
})
