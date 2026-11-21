import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { build } from 'esbuild'

const mocks = new Map([
  ['react', 'export const useEffect = () => {}, useRef = current => ({ current }), useState = value => [value, () => {}]'],
  ['@tanstack/react-query', 'export const useQuery = () => ({})'],
  ['react-dom', 'export const flushSync = action => action()'],
  ['lucide-react', 'export const Clock3 = "clock", Search = "search", X = "close"'],
  ['../../services/desktopApi', 'export const getSearchSuggestions = () => []'],
])
const { outputFiles: [output] } = await build({
  entryPoints: ['src/features/search/SearchField.tsx'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  jsx: 'automatic',
  external: ['react/jsx-runtime'],
  plugins: [{
    name: 'search-field-hooks',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, ({ path }) => mocks.has(path) ? { path, namespace: 'fixture' } : undefined)
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: mocks.get(path) }))
    },
  }],
})
const bundle = { exports: {} }
new Function('module', 'exports', 'require', output.text)(bundle, bundle.exports, createRequire(import.meta.url))
const { SearchField } = bundle.exports

test('clearing the search restores the input during the click and cancels a pending blur', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const calls = []
  const field = { focus: options => { calls.push(['focus', options]); document.activeElement = field } }
  const original = globalThis.document
  globalThis.document = { activeElement: field }
  try {
    const { props: { children } } = SearchField({
      value: '旅人', focused: true, history: [], inputRef: { current: field },
      onBlur: () => calls.push('blur'), onClear: () => calls.push('clear'),
    })
    const input = children.find(child => child?.type === 'input')
    const clear = children.find(child => child?.props.className?.includes('search-reset'))
    let defaultPrevented = false
    clear.props.onMouseDown({ preventDefault: () => { defaultPrevented = true } })
    assert.equal(defaultPrevented, true)

    input.props.onBlur()
    document.activeElement = clear
    clear.props.onClick()
    assert.equal(document.activeElement, field)
    t.mock.timers.tick(120)
    assert.deepEqual(calls, ['clear', ['focus', { preventScroll: true }]])
  } finally {
    if (original === undefined) delete globalThis.document
    else globalThis.document = original
  }
})
