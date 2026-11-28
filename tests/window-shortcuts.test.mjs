import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'
import {createRequire} from 'node:module'

const shortcuts=await build({entryPoints:['src/domain/shortcuts.ts'],bundle:true,write:false,format:'cjs',platform:'node'})
const instantiate=output=>{const module={exports:{}};new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports);return module.exports}
const {defaultShortcuts}=instantiate(shortcuts)

const app=await build({entryPoints:['src/app/windowShortcuts.ts'],bundle:true,write:false,format:'cjs',platform:'node',plugins:[{
 name:'window-shortcut-boundaries',setup(builder){
  const mocks={
   playerStore:'export const usePlayerStore={getState:()=>globalThis.windowShortcutPlayer}',
   globalShortcuts:'export const listenGlobalShortcuts=()=>()=>{};export const syncGlobalShortcuts=()=>{};export const showMainWindow=()=>{}',
   platform:'export const isMobile=false',
   shortcuts:'export const useShortcutStore={getState:()=>({bindings:globalThis.windowShortcutBindings,globalEnabled:false}),subscribe:()=>()=>{}}',
   installMouseShortcuts:'export const installMouseShortcuts=()=>()=>{}',
   nativeTextEditing:'export const suppressBrowserContextMenu=()=>{}',
   overlayStack:'export const dispatchBack=()=>false',
  }
  for(const [name,contents] of Object.entries(mocks))builder.onLoad({filter:new RegExp(name+'$'),namespace:'mock'},()=>({contents}))
  builder.onResolve({filter:/player\/playerStore$/},()=>({path:'playerStore',namespace:'mock'}))
  builder.onResolve({filter:/services\/globalShortcuts$/},()=>({path:'globalShortcuts',namespace:'mock'}))
  builder.onResolve({filter:/services\/platform$/},()=>({path:'platform',namespace:'mock'}))
  builder.onResolve({filter:/services\/shortcuts$/},()=>({path:'shortcuts',namespace:'mock'}))
  builder.onResolve({filter:/shared\/installMouseShortcuts$/},()=>({path:'installMouseShortcuts',namespace:'mock'}))
  builder.onResolve({filter:/shared\/nativeTextEditing$/},()=>({path:'nativeTextEditing',namespace:'mock'}))
  builder.onResolve({filter:/shared\/overlayStack$/},()=>({path:'overlayStack',namespace:'mock'}))
 }
}]})

const pointerMarker = '[data-playback-space-pointer]'
const rangeMarker = 'input[type="range"][data-playback-space-range]'

function fakeTarget({ role = '', native = '', pointer = false, range = false, insideMenu = false, editor = false } = {}) {
  return {
    isContentEditable: false,
    matches: selector => (selector === rangeMarker && range) || (selector === pointerMarker && pointer),
    closest(selector) {
      if (selector === pointerMarker) return pointer ? this : null
      if (selector === '[data-shortcut-editor]') return editor ? this : null
      if (selector.includes('[role="menu"]')) return insideMenu ? this : null
      if (selector === '.dock-controls,.mini-player-controls') return null
      const parts = selector.split(', ')
      return parts.some(part => part === native || part === `[role="${role}"]`) ? this : null
    },
  }
}

function keyboard(key, target, extra) {
  const code = key === ' ' ? 'Space' : /^[a-z]$/.test(key) ? `Key${key.toUpperCase()}` : key
  return { key, code, target, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false,
    defaultPrevented: false, stopped: false, preventDefault() { this.defaultPrevented = true },
    stopPropagation() { this.stopped = true }, getModifierState: () => false, ...extra }
}

function install(t, { modal = false, bindings = defaultShortcuts(false) } = {}) {
  const listeners = new Map()
  const actions = []
  const keyFor = (type, capture = false) => `${type}:${capture}`
  globalThis.window = {
    addEventListener: (type, fn, capture) => listeners.set(keyFor(type, capture), fn),
    removeEventListener: (type, fn, capture) => listeners.delete(keyFor(type, capture)),
  }
  globalThis.document = { activeElement: null, addEventListener() {}, removeEventListener() {}, querySelector: () => modal ? {} : null }
  globalThis.windowShortcutBindings = bindings
  globalThis.windowShortcutPlayer = { progressSeconds: 0, volume: .5,
    toggle: () => actions.push('toggle'), previous: () => actions.push('previous'), next: () => actions.push('next'),
    seek: () => actions.push('seek'), setVolume: () => actions.push('volume') }
  const stop = instantiate(app).installWindowShortcuts()
  t.after(() => {
    stop()
    assert.equal(listeners.size, 0)
  })
  const focus = target => {
    if (document.activeElement !== target) {
      document.activeElement = target
      listeners.get(keyFor('focusin'))({ target })
    }
  }
  return {
    actions, focus,
    pointer(target) {
      listeners.get(keyFor('pointerdown', true))({ target, pointerType: 'mouse', button: 0 })
      focus(target)
    },
    blur() { listeners.get(keyFor('blur'))() },
    press(key, { extra, onTarget } = {}) {
      const event = keyboard(key, document.activeElement, extra)
      listeners.get(keyFor('keydown', true))(event)
      if (!event.stopped) onTarget?.(event)
      if (!event.stopped) listeners.get(keyFor('keydown'))(event)
      return event
    },
  }
}

const activate = (actions, label) => event => { event.preventDefault(); actions.push(label) }

test('Space remains a shortcut on the page without taking the key from input or shortcut capture', t => {
  const { actions, focus, press } = install(t)
  focus(fakeTarget())
  assert.equal(press(' ').defaultPrevented, true)
  assert.equal(press(' ', { extra: { isComposing: true } }).defaultPrevented, false)
  for (const target of [fakeTarget({ native: 'input' }), fakeTarget({ native: 'textarea' }), fakeTarget({ editor: true })]) {
    focus(target)
    assert.equal(press(' ').defaultPrevented, false)
  }
  assert.deepEqual(actions, ['toggle'])
})

test('playback sliders give Space to playback and keep arrow keys and unrelated sliders', t => {
  const { actions, focus, press } = install(t)
  focus(fakeTarget({ native: 'input', range: true }))
  assert.equal(press(' ').defaultPrevented, true)
  assert.equal(press('ArrowRight').defaultPrevented, false)
  focus(fakeTarget({ native: 'input' }))
  assert.equal(press(' ').defaultPrevented, false)
  assert.deepEqual(actions, ['toggle'])
})

test('mouse-focused song and lyric controls release Space but keyboard focus activates them', t => {
  const { actions, pointer, focus, press } = install(t)
  const lyric = fakeTarget({ role: 'button', pointer: true })
  const row = fakeTarget({ role: 'button', pointer: true })
  const select = activate(actions, 'activate')
  pointer(lyric)
  assert.equal(press(' ', { onTarget: select }).defaultPrevented, true)
  assert.equal(press(' ', { extra: { repeat: true }, onTarget: select }).defaultPrevented, true)
  press('Tab')
  focus(row)
  press(' ', { onTarget: select })
  press('Enter', { onTarget: select })
  assert.deepEqual(actions, ['toggle', 'activate', 'activate'])
})

test('the pointer exception clears on another focus and when the window loses focus', t => {
  const { actions, focus, pointer, press, blur } = install(t)
  const track = fakeTarget({ role: 'button', pointer: true })
  pointer(track)
  focus(fakeTarget())
  focus(track)
  assert.equal(press(' ').defaultPrevented, false)
  pointer(track)
  blur()
  assert.equal(press(' ').defaultPrevented, false)
  assert.deepEqual(actions, [])
})

test('buttons, settings switches and both native and ARIA menus keep their Space action', t => {
  const { actions, pointer, focus, press } = install(t)
  const transport = fakeTarget({ native: 'button', pointer: true })
  focus(transport)
  assert.equal(press(' ').defaultPrevented, false)
  pointer(transport)
  assert.equal(press(' ').defaultPrevented, true)
  for (const target of [
    fakeTarget({ native: 'button' }),
    fakeTarget({ native: 'button', role: 'switch' }),
    fakeTarget({ role: 'checkbox' }),
    fakeTarget({ native: 'button', insideMenu: true, pointer: true }),
    fakeTarget({ role: 'menuitem', insideMenu: true }),
  ]) {
    pointer(target)
    assert.equal(press(' ').defaultPrevented, false)
    assert.equal(press('Enter').defaultPrevented, false)
  }
  assert.deepEqual(actions, ['toggle'])
})

test('a modal keeps Space on its own controls', t => {
  const { actions, pointer, focus, press } = install(t, { modal: true })
  const select = activate(actions, 'activate')
  pointer(fakeTarget({ role: 'button', pointer: true }))
  press(' ', { onTarget: select })
  focus(fakeTarget({ native: 'input', range: true }))
  assert.equal(press(' ').defaultPrevented, false)
  assert.deepEqual(actions, ['activate'])
})

test('mouse focus follows the current playback binding and leaves other shortcuts intact', t => {
  const bindings = defaultShortcuts(false)
  bindings.toggle = { code: 'KeyJ', ctrl: false, meta: false, alt: false, shift: false }
  const { actions, pointer, focus, press } = install(t, { bindings })
  pointer(fakeTarget({ role: 'button', pointer: true }))
  press(' ', { onTarget: activate(actions, 'activate') })
  assert.equal(press('j').defaultPrevented, true)
  focus(fakeTarget({ native: 'button' }))
  press('ArrowLeft', { extra: { ctrlKey: true } })
  assert.deepEqual(actions, ['activate', 'toggle', 'previous'])
})
