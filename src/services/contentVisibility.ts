import { invoke } from '@tauri-apps/api/core'
import { create } from 'zustand'
import { useEffect } from 'react'
import { accountEpoch } from './accountScope'
import { inDesktopShell } from './desktopApi'
import { ruleKey, type VisibilityRule } from '../domain/contentVisibility'
type Snapshot = { session: string; rules: VisibilityRule[]; error?: string }
export const useContentVisibility = create<Snapshot>(() => ({session:'',rules:[]}))
let request = 0
export async function refreshVisibility() {
  const epoch = accountEpoch(), ticket = ++request
  const snapshot = inDesktopShell ? await invoke<Snapshot>('content_visibility') : {session:'preview',rules:useContentVisibility.getState().rules}
  if (epoch !== accountEpoch() || ticket !== request) return
  useContentVisibility.setState(snapshot)
}
export function useVisibilityRules() {
  const rules = useContentVisibility(s => s.rules)
  useEffect(() => { void ensureVisibility().catch(() => undefined) }, [])
  return rules
}
let loading: Promise<void> | undefined
export function ensureVisibility() {
  if (useContentVisibility.getState().session) return Promise.resolve()
  return loading ??= refreshVisibility().finally(() => { loading = undefined })
}
let writing = Promise.resolve()
export function saveVisibility(changes: VisibilityRule[]) {
  const epoch = accountEpoch()
  const operation = writing.catch(() => undefined).then(async () => {
    await ensureVisibility()
    if (epoch !== accountEpoch()) throw Error('账号已切换，请重新操作')
    const before = useContentVisibility.getState()
    if (inDesktopShell) await invoke('content_visibility_save',{expectedSession:before.session,changes})
    if (epoch !== accountEpoch()) return
    // Read canonical projection after the transaction; a concurrent cloud merge must not be lost.
    if (inDesktopShell) await refreshVisibility()
    else useContentVisibility.setState({rules:[...before.rules.filter(r=>!changes.some(c=>ruleKey(c)===ruleKey(r))),...changes]})
    window.dispatchEvent(new Event('bilimusic-data-changed'))
    window.dispatchEvent(new Event('bilimusic-visibility-changed'))
  })
  writing = operation
  return operation
}
if(typeof window!=='undefined') {
window.addEventListener('bilimusic-account-changing',()=>{++request; loading=undefined;useContentVisibility.setState({session:'',rules:[],error:undefined})})
window.addEventListener('bilimusic-account-changed',()=>{void refreshVisibility().catch(()=>undefined)})
window.addEventListener('bilimusic-library-synced',()=>{void refreshVisibility().catch(()=>undefined)})
}
