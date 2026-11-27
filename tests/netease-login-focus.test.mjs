// The QR-centring script runs inside the NetEase login page, far from the rest
// of the app, so it is tested against a small DOM stand-in: the page classes are
// build-hashed and cannot be asserted, but the heuristics, the user hand-over
// and the "no-op outside 163.com" guard can be.
//
// Every fake document carries its own viewport and `getComputedStyle`, and a
// foreign node resolves as visible in the top window's stub. The login view has
// been rendered in a same-origin frame before, so measuring, visibility and the
// final nudge must all happen in the document the QR lives in; a stub sharing
// the top window's metrics would let a regression back to top-window
// measurements pass unnoticed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

test('Android restores the app page on every exit from embedded login', async () => {
  const source = await readFile('src-tauri/src/interface/recommendation.rs', 'utf8')
  const android = source.split('#[cfg(target_os = "android")]\n#[tauri::command]\npub async fn netease_web_login(')[1]
  const login = android?.split('\n/// One decision per poll')[0]
  assert.ok(login)
  const loop = login.split('let result = loop {')[1]
  assert.ok(loop)
  assert.match(loop, /AppLoginTick::Left => break Err\(CommandError::netease_login_cancelled\(\)\)/)
  assert.doesNotMatch(loop, /\breturn\b/)
  assert.match(loop, /};\s+restore_app_page\(&window, &app_url\);\s+result\s+}/)
})

const source = await readFile(new URL('../src-tauri/src/interface/netease_login_focus.js', import.meta.url), 'utf8')

const VISIBLE = { visibility: 'visible', display: 'block', opacity: '1' }

function element(tag, { width = 0, height = 0, top = 0, left = 0 } = {}) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    parentElement: null,
    childNodes: [],
    textContent: '',
    style: { ...VISIBLE },
    ownerDocument: undefined,
    scrolls: [],
    width,
    height,
    top,
    left,
    getBoundingClientRect() {
      return { top: node.top, left: node.left, width: node.width, height: node.height, right: node.left + node.width, bottom: node.top + node.height }
    },
    scrollIntoView(options) { node.scrolls.push(options ?? null) },
  }
  return node
}

function label(text) {
  const node = element('div', { width: 120, height: 20 })
  node.textContent = text
  // The script only accepts a node whose own text is the label.
  node.childNodes = [{ nodeType: 3 }]
  return node
}

function frame(contents) {
  const node = element('iframe')
  Object.defineProperty(node, 'contentDocument', { get: () => contents, configurable: true })
  return node
}

function blockedFrame() {
  const node = element('iframe')
  Object.defineProperty(node, 'contentDocument', { get() { throw new Error('cross-origin') }, configurable: true })
  return node
}

function makeDocument({ width = 460, height = 720, nodes = [], frames = [] } = {}) {
  const doc = {
    width,
    height,
    nodes,
    frames,
    scrolled: [],
    listeners: new Map(),
    querySelectorAll(selector) {
      if (selector === 'iframe') return frames
      const tags = selector.split(',').map(part => part.trim().toUpperCase())
      return nodes.filter(node => tags.includes(node.tagName))
    },
  }
  // `document.defaultView` is the window object, as in a browser, so the
  // script's listener setup and its `window` global are the same target.
  doc.defaultView = {
    innerWidth: width,
    innerHeight: height,
    addEventListener(type, listener, options) {
      if (!doc.listeners.has(type)) doc.listeners.set(type, [])
      doc.listeners.get(type).push({ listener, options })
    },
    scrollBy(x, y) { doc.scrolled.push([x, y]) },
    // Only this document's own nodes resolve here. A node from another
    // document reads as visible, so a fallback to the top window is observable
    // rather than silently correct.
    getComputedStyle(node) {
      return node.ownerDocument === doc ? node.style : { ...VISIBLE }
    },
  }
  for (const node of [...nodes, ...frames]) node.ownerDocument = doc
  return doc
}

function session(doc, { hostname = 'music.163.com' } = {}) {
  let clock = 0
  const window = doc.defaultView
  const context = vm.createContext({ window, document: doc, location: { hostname }, Date: { now: () => clock }, Math })
  return {
    window,
    doc,
    listeners: doc.listeners,
    advance(ms) { clock += ms },
    tick() { vm.runInContext(source, context) },
    fire(type) {
      for (const entry of doc.listeners.get(type) || []) entry.listener()
    },
  }
}

test('does nothing outside a 163.com document', () => {
  // The guard has to be anchored: a substring or suffix check would run the
  // script on a lookalike host, and Android samples the URL before the eval.
  for (const hostname of ['tauri.localhost', 'evil163.com', 'not163.com', '163.com.evil.example', 'music.163.com.evil.example']) {
    const canvas = element('canvas', { width: 152, height: 152, top: 600, left: 154 })
    const run = session(makeDocument({ nodes: [canvas] }), { hostname })
    run.tick()
    assert.equal(canvas.scrolls.length, 0, hostname)
    assert.equal(run.window.__bilimusicQrTick, undefined, hostname)
    // No listeners either: the app page must not be instrumented at all.
    assert.equal(run.listeners.size, 0, hostname)
  }
})

test('runs on 163.com and its subdomains', () => {
  for (const hostname of ['163.com', 'music.163.com']) {
    const canvas = element('canvas', { width: 152, height: 152, top: 600, left: 154 })
    const run = session(makeDocument({ nodes: [canvas] }), { hostname })
    run.tick()
    assert.equal(canvas.scrolls.length, 1, hostname)
  }
})

test('centres the square QR canvas once it exists below the fold', () => {
  const canvas = element('canvas', { width: 152, height: 152, top: 600, left: 154 })
  const run = session(makeDocument({ nodes: [canvas] }))
  run.tick()
  assert.equal(canvas.scrolls.length, 1)
  // The options object comes from the page's realm, so compare its fields.
  assert.equal(canvas.scrolls[0].block, 'center')
  assert.equal(canvas.scrolls[0].inline, 'center')
  assert.deepEqual(run.doc.scrolled, [])
})

test('leaves a QR that is already fully visible alone', () => {
  const canvas = element('canvas', { width: 152, height: 152, top: 284, left: 154 })
  const run = session(makeDocument({ nodes: [canvas] }))
  run.tick()
  assert.equal(canvas.scrolls.length, 0)
})

test('brings a sideways-clipped QR into view', () => {
  // The motivating case: in a narrow window the login card overflows
  // horizontally, so the QR's right edge sits outside the viewport.
  const clipped = element('canvas', { width: 152, height: 152, top: 100, left: 430 })
  const run = session(makeDocument({ nodes: [clipped] }))
  run.tick()
  assert.equal(clipped.scrolls.length, 1)
})

test('treats a QR touching the viewport edge as out of view', () => {
  const flush = element('canvas', { width: 152, height: 152, top: 8, left: 8 })
  const run = session(makeDocument({ nodes: [flush] }))
  run.tick()
  assert.equal(flush.scrolls.length, 0)
  const edge = element('canvas', { width: 152, height: 152, top: 8, left: 0 })
  const other = session(makeDocument({ nodes: [edge] }))
  other.tick()
  assert.equal(edge.scrolls.length, 1)
})

test('re-centres after a late layout shift pushes the QR out again', () => {
  const canvas = element('canvas', { width: 152, height: 152, top: 284, left: 154 })
  const run = session(makeDocument({ nodes: [canvas] }))
  run.tick()
  assert.equal(canvas.scrolls.length, 0)
  canvas.top = 900
  run.advance(500)
  run.tick()
  assert.equal(canvas.scrolls.length, 1)
})

test('stops for good once the user scrolls, clicks or types', () => {
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    const canvas = element('canvas', { width: 152, height: 152, top: 600, left: 154 })
    const run = session(makeDocument({ nodes: [canvas] }))
    run.tick()
    assert.equal(canvas.scrolls.length, 1, type)
    assert.equal(run.listeners.get(type)?.length, 1, `${type} listener registered once`)
    // Capture phase: an element handler calling stopPropagation must not hide
    // the user's input from this listener.
    assert.equal(run.listeners.get(type)[0].options.capture, true, `${type} captures`)
    run.fire(type)
    canvas.top = 900
    run.advance(1000)
    run.tick()
    assert.equal(canvas.scrolls.length, 1, `${type} stops the script`)
    // Ticks keep coming; they must not register duplicate listeners.
    run.tick()
    assert.equal(run.listeners.get(type).length, 1, `${type} listener not duplicated`)
  }
})

test('stops once the user interacts inside the login frame', () => {
  const innerCanvas = element('canvas', { width: 152, height: 152, top: 600, left: 154 })
  const inner = makeDocument({ nodes: [innerCanvas] })
  const run = session(makeDocument({ frames: [frame(inner)] }))
  run.tick()
  assert.equal(innerCanvas.scrolls.length, 1)
  // The form lives in the frame; its events never reach the top window.
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    assert.equal(inner.listeners.get(type)?.length, 1, `${type} listener registered in the frame`)
  }
  inner.listeners.get('keydown')[0].listener()
  innerCanvas.top = 900
  run.advance(1000)
  run.tick()
  assert.equal(innerCanvas.scrolls.length, 1)
})

test('picks the largest square canvas', () => {
  const small = element('canvas', { width: 120, height: 120, top: 600, left: 20 })
  const qr = element('canvas', { width: 200, height: 200, top: 620, left: 150 })
  const run = session(makeDocument({ nodes: [small, qr] }))
  run.tick()
  assert.equal(small.scrolls.length, 0)
  assert.equal(qr.scrolls.length, 1)
})

test('ignores a canvas too small or too large to be the QR', () => {
  for (const [width, height] of [[80, 80], [500, 500]]) {
    const canvas = element('canvas', { width, height, top: 600, left: 20 })
    const run = session(makeDocument({ nodes: [canvas] }))
    run.tick()
    assert.equal(canvas.scrolls.length, 0, `${width}x${height}`)
  }
})

test('ignores an in-size canvas that is not square', () => {
  // A banner passes the size band, so only the aspect-ratio check rejects it.
  const banner = element('canvas', { width: 220, height: 152, top: 600, left: 20 })
  const wide = element('canvas', { width: 400, height: 30, top: 700, left: 30 })
  const run = session(makeDocument({ nodes: [banner, wide] }))
  run.tick()
  assert.equal(banner.scrolls.length, 0)
  assert.equal(wide.scrolls.length, 0)
})

test('does not chase a square image or icon', () => {
  const avatar = element('img', { width: 152, height: 152, top: 600, left: 154 })
  const run = session(makeDocument({ nodes: [avatar] }))
  run.tick()
  assert.equal(avatar.scrolls.length, 0)
})

test('ignores a canvas hidden by any of the usual means', () => {
  for (const style of [{ visibility: 'hidden' }, { display: 'none' }, { opacity: '0' }]) {
    const canvas = element('canvas', { width: 152, height: 152, top: 600, left: 154 })
    Object.assign(canvas.style, style)
    const run = session(makeDocument({ nodes: [canvas] }))
    run.tick()
    assert.equal(canvas.scrolls.length, 0, JSON.stringify(style))
  }
})

test('reads visibility in the document the canvas lives in', () => {
  const innerCanvas = element('canvas', { width: 152, height: 152, top: 600, left: 154 })
  innerCanvas.style.visibility = 'hidden'
  const inner = makeDocument({ nodes: [innerCanvas] })
  const run = session(makeDocument({ frames: [frame(inner)] }))
  run.tick()
  assert.equal(innerCanvas.scrolls.length, 0)
})

test('falls back to the login card that holds the 扫码登录 label', () => {
  const card = element('div', { width: 400, height: 420, top: 600, left: 30 })
  const text = label('扫码登录')
  text.parentElement = card
  card.childNodes = [text]
  card.textContent = '扫码登录'
  const run = session(makeDocument({ nodes: [card, text] }))
  run.tick()
  assert.equal(card.scrolls.length, 1)
  assert.equal(text.scrolls.length, 0)
})

test('skips a wrapper that only repeats the label', () => {
  const outer = element('div', { width: 600, height: 640, top: 600, left: 0 })
  const card = element('div', { width: 400, height: 420, top: 600, left: 30 })
  const leaf = label('扫码登录')
  leaf.parentElement = card
  card.childNodes = [leaf]
  card.textContent = '扫码登录'
  card.parentElement = outer
  outer.childNodes = [card]
  outer.textContent = '扫码登录'
  // Document order matters: the two wrappers are seen before the leaf.
  const run = session(makeDocument({ nodes: [outer, card, leaf] }))
  run.tick()
  assert.equal(outer.scrolls.length, 0)
  assert.equal(card.scrolls.length, 1)
})

test('finds a QR rendered inside a same-origin frame', () => {
  const innerCanvas = element('canvas', { width: 152, height: 152, top: 600, left: 154 })
  const inner = makeDocument({ nodes: [innerCanvas] })
  const run = session(makeDocument({ frames: [frame(inner)] }))
  run.tick()
  assert.equal(innerCanvas.scrolls.length, 1)
})

test('skips a frame it cannot read instead of throwing', () => {
  const run = session(makeDocument({ frames: [blockedFrame()] }))
  assert.doesNotThrow(() => run.tick())
})

test('measures the frame viewport, not the window that injected the script', () => {
  const canvas = element('canvas', { width: 152, height: 152, top: 600, left: 154 })
  const inner = makeDocument({ width: 600, height: 900, nodes: [canvas] })
  const run = session(makeDocument({ frames: [frame(inner)] }))
  run.tick()
  // Fully visible inside the 600x900 frame; the top window's 460x720 box would
  // have said otherwise and scrolled for nothing.
  assert.equal(canvas.scrolls.length, 0)
})

test('nudges the window when the page itself did not scroll the QR into view', () => {
  const canvas = element('canvas', { width: 152, height: 152, top: -400, left: 0 })
  canvas.scrollIntoView = () => {}
  const run = session(makeDocument({ nodes: [canvas] }))
  run.tick()
  // Centre of the 460x720 viewport minus the QR centre.
  assert.deepEqual(run.doc.scrolled, [[-154, -684]])
})

test('nudges the frame that holds the QR, using that frame’s viewport', () => {
  const canvas = element('canvas', { width: 152, height: 152, top: -400, left: 0 })
  canvas.scrollIntoView = () => {}
  const inner = makeDocument({ width: 400, height: 600, nodes: [canvas] })
  const run = session(makeDocument({ frames: [frame(inner)] }))
  run.tick()
  // Centre of the 400x600 frame viewport minus the QR centre.
  assert.deepEqual(inner.scrolled, [[-124, -624]])
  assert.deepEqual(run.doc.scrolled, [])
})

test('a second eval within the same tick window does not rescan', () => {
  const canvas = element('canvas', { width: 152, height: 152, top: 600, left: 154 })
  const run = session(makeDocument({ nodes: [canvas] }))
  run.tick()
  run.tick()
  assert.equal(canvas.scrolls.length, 1)
  run.advance(500)
  run.tick()
  assert.equal(canvas.scrolls.length, 2)
})
