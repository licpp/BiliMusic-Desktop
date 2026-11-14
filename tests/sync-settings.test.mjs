import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'

const output = await build({
  entryPoints: ['src/features/sync/SyncSettings.tsx'], bundle: true, write: false,
  format: 'cjs', platform: 'node', jsx: 'automatic', external: ['react/jsx-runtime'],
  plugins: [{ name: 'settings-boundaries', setup(builder) {
    builder.onResolve({ filter: /^lucide-react$/ }, () => ({ path: 'icons', namespace: 'test' }))
    builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react-hooks', namespace: 'test' }))
    builder.onResolve({ filter: /^@tanstack\/react-query$/ }, () => ({ path: 'queries', namespace: 'test' }))
    builder.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'invoke', namespace: 'test' }))
    builder.onResolve({ filter: /syncAttention$/ }, () => ({path:'attention',namespace:'test'}))
    builder.onResolve({ filter: /services\/(sync|desktopApi)$/ }, args => ({ path: args.path.endsWith('/sync') ? 'sync' : 'api', namespace: 'test' }))
    builder.onResolve({ filter: /player\/playerStore$/ }, () => ({ path: 'player', namespace: 'test' }))
    builder.onResolve({ filter: /shared\/ActionMenu$/ }, () => ({ path: 'menu', namespace: 'test' }))
    builder.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({ contents: {
      icons: `export const Monitor=()=>null; export const Smartphone=()=>null; export const Cloud=()=>null; export const LoaderCircle=()=>null; export const RefreshCw=()=>null; export const Check=()=>null; export const ChevronDown=()=>null;`,
      attention: `export const useSyncAttention=select=>select({outcome:null,library:'',statistics:''});export const clearSyncAttention=()=>{};export const reportSyncError=()=>{};`,
      menu: `export const ActionMenu=()=>null;`,
      'react-hooks': `export const useState = initial => globalThis.syncSettingsTest.useState(initial); export const useEffect = () => {};`,
      queries: `export const useQuery = () => globalThis.syncSettingsTest.query; export const useQueryClient = () => ({invalidateQueries:async()=>{}});`,
      invoke: `export const invoke = (...args) => globalThis.syncSettingsTest.invoke(...args);`,
      sync: `export const defaultSyncConfig={enabled:false,provider:'webdav',uid:'42',url:'https://dav.jianguoyun.com/dav/',history:false,initialized:false,deviceId:''}; export const refreshSyncedLibrary=async()=>{}; export const syncNow=(...args)=>globalThis.syncSettingsTest.syncNow(...args); export const syncStatus=async()=>({});`,
      api: `export const inDesktopShell=true; export const commandErrorMessage=e=>e.message;`,
      player: `export const resetPlayerForAccount=async()=>{throw new Error('Connecting sync must not reset the account or player')};`,
    }[path] }))
  } }],
})

function elements(node, predicate) {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(child => elements(child, predicate))
  return [...(predicate(node) ? [node] : []), ...elements(node.props?.children, predicate)]
}
function setup(fail = false) {
  const calls = []
  let cursor = 0
  const state = []
  const config = { enabled: false, provider: 'webdav', uid: '42', initialized: false }
  globalThis.window = {dispatchEvent(){}}
  globalThis.syncSettingsTest = {
    useState(initial) {
      const index = cursor++
      if (!(index in state)) state[index] = initial
      return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value }]
    },
    query: { data: { config }, isPending: false, refetch: async () => {} },
    invoke: async (command, args) => {
      calls.push([command, args])
      if (fail) throw new Error('连接失败，请重试')
      return { config: { ...config, enabled: true } }
    },
    syncNow: async (...args) => { calls.push(['preview', ...args]); return { conflicts: [], records: 3, bytes: 200, changed: false } },
  }
  const module = {exports:{}}
  new Function('require','module','exports',output.outputFiles[0].text)(createRequire(import.meta.url),module,module.exports)
  const render = props => { cursor = 0; return module.exports.SyncSettings(props) }
  return {calls,render}
}
async function connect(render) {
  elements(render(), node => node.type === 'button' && node.props['aria-expanded'] === false)[0].props.onClick()
  const form = elements(render(), node => node.type === 'form')[0]
  const consent = elements(form, node => node.type === 'input' && node.props.type === 'checkbox').at(-1)
  consent.props.onChange({target:{checked:true}})
  elements(render(), node => node.type === 'form')[0].props.onSubmit({preventDefault(){}})
  await new Promise(setImmediate)
}

test('connecting sync automatically merges without a confirmation when no conflict exists', async () => {
  const {calls,render} = setup()
  await connect(render)
  assert.deepEqual(calls.slice(0,2).map(call=>call[0]), ['sync_connect','preview'])
  assert.equal(calls[1][1], false)
  assert.equal(elements(render(), node => node.props?.className === 'sync-preview').length,0)
  assert.equal(elements(render(), node => node.props?.role === 'status')[0].props.children, '同步完成')
})

test('automatic initial sync still presents genuine conflicts and never chooses destructively', async () => {
  const {calls,render} = setup()
  globalThis.syncSettingsTest.syncNow=async (...args)=>{calls.push(['preview',...args]);return {conflicts:[{key:'playlist:x',field:'__present'}],records:3,bytes:200,changed:false}}
  await connect(render)
  assert.equal(calls[1][1],false)
  assert.equal(calls.filter(c=>c[0]==='preview').length,1)
  assert.ok(elements(render(),node=>node.props?.className==='sync-preview').length)
  assert.equal(elements(render(),node=>node.props?.role==='status')[0].props.children,'发现不同修改，请选择保留哪一侧。')
})

test('failed connection retains editable settings and shows the error without a merge', async () => {
  const {calls,render} = setup(true)
  await connect(render)
  assert.deepEqual(calls.map(call=>call[0]), ['sync_connect'])
  assert.ok(elements(render(), node => node.type === 'form').length)
  const message = elements(render(), node => node.props?.role === 'status')[0]
  assert.equal(message.props.children, '连接失败，请重试')
})

test('sync service picker keeps unavailable cloud disabled and choosing a service clears consent',()=>{
  const {render}=setup()
  elements(render(),node=>node.type==='button'&&node.props['aria-expanded']===false)[0].props.onClick()
  const consent=elements(render(),node=>node.type==='input'&&node.props.type==='checkbox').at(-1)
  consent.props.onChange({target:{checked:true}})
  const picker=elements(render(),node=>node.props?.panelClassName==='sync-provider-menu')[0]
  let closed=false
  const options=elements(picker.props.children(()=>{closed=true}),node=>node.props?.role==='menuitemradio')
  assert.equal(options.length,2)
  assert.equal(options[1].props.disabled,true)
  assert.equal(options[0].props['aria-checked'],true)
  options[0].props.onClick()
  assert.equal(closed,true)
  assert.equal(elements(render(),node=>node.type==='input'&&node.props.type==='checkbox').at(-1).props.checked,false)
})

test('inline sync opens its connection fields directly and retains consent before connecting',async()=>{
  const {render,calls}=setup()
  const form=elements(render({embedded:true}),node=>node.type==='form')[0]
  assert.ok(form)
  assert.equal(elements(render({embedded:true}),node=>node.props?.className==='sync-heading').length,0)
  assert.equal(elements(form,node=>node.type==='button'&&node.props.children==='取消').length,0)
  elements(form,node=>node.type==='input'&&node.props.type==='checkbox').at(-1).props.onChange({target:{checked:true}})
  elements(render({embedded:true}),node=>node.type==='form')[0].props.onSubmit({preventDefault(){}})
  await new Promise(setImmediate)
  assert.deepEqual(calls.slice(0,2).map(call=>call[0]),['sync_connect','preview'])
})
