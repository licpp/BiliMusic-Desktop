import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

test('organizer grip overrides the phone button rule that permits native panning', () => {
  const css = readFileSync(new URL('../src/styles/list-organizer.css', import.meta.url), 'utf8')
  // The scoped rule must outrank the phone's :root[data-layout="mobile"] button rule.
  assert.match(css, /\[data-order-list\] \[data-order-row\] button\.order-drag-handle\s*\{[^}]*touch-action:none/)
})

test('incremental rows observe a remounted tail with the same scope and batch size', async () => {
  const built = await build({
    entryPoints: ['src/shared/useListRows.ts'],
    bundle: true,
    write: false,
    format: 'cjs',
    external: ['react'],
  })
  const state = [], effects = [], refs = []
  let stateIndex = 0, effectIndex = 0, refIndex = 0
  let pendingEffects = []
  const react = {
    startTransition(callback) { callback() },
    useState(initial) {
      const index = stateIndex++
      state[index] ??= { value: initial }
      return [state[index].value, value => {
        state[index].value = typeof value === 'function' ? value(state[index].value) : value
      }]
    },
    useEffect(callback, dependencies) {
      const index = effectIndex++
      const previous = effects[index]
      if (previous && dependencies.every((value, i) => Object.is(value, previous.dependencies[i]))) return
      pendingEffects.push(() => {
        previous?.cleanup?.()
        effects[index] = { dependencies, cleanup: callback() }
      })
    },
    useRef(value) { return refs[refIndex++] ??= { current: value } },
  }
  const module = { exports: {} }
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(module, module.exports, () => react)
  const rows = Array.from({ length: 100 }, (_, index) => index)
  const render = tail => {
    stateIndex = effectIndex = refIndex = 0
    const result = module.exports.useListRows(rows, 'favorites')
    if (typeof result.tail === 'function') result.tail(tail)
    else result.tail.current = tail
    for (const commit of pendingEffects.splice(0)) commit()
    return result
  }
  const observed = new Map()
  const frames = []
  const tail = () => ({ isConnected: true, closest: () => null })
  const oldTail = tail(), newTail = tail()
  const Observer = globalThis.IntersectionObserver, requestFrame = globalThis.requestAnimationFrame
  globalThis.IntersectionObserver = class {
    constructor(callback) { this.callback = callback }
    observe(element) { this.element = element; observed.set(element, this.callback) }
    disconnect() { observed.delete(this.element) }
  }
  globalThis.requestAnimationFrame = callback => frames.push(callback)
  try {
    render(oldTail)
    assert.equal(render(oldTail).rows.length, 24)
    assert.ok(observed.has(oldTail))
    oldTail.isConnected = false
    render(newTail)
    render(newTail)
    assert.equal(observed.has(oldTail), false)
    assert.ok(observed.has(newTail))
    observed.get(newTail)([{ isIntersecting: true }])
    while (frames.length) frames.shift()()
    assert.equal(render(newTail).rows.length, 48)
  } finally {
    for (const effect of effects) effect.cleanup?.()
    globalThis.IntersectionObserver = Observer
    globalThis.requestAnimationFrame = requestFrame
  }
})
