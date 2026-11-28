import { Channel, invoke, isTauri } from '@tauri-apps/api/core'
import { create } from 'zustand'
import { version } from '../../package.json'
import { compareVersions } from '../shared/version'

export const currentRelease = version
const downloadPage = 'https://bilimusic.cn/#download'
const releaseNotesPage = 'https://github.com/licpp/BiliMusic-Desktop/releases'
export type UpdateRelease = { version: string; build?: number; currentBuild?: number; available: boolean; installable?: boolean; requestId?: string; platform?: string; size?: number; updateNotes?: string[] }
export type UpdateCheck = UpdateRelease & { status: 'available' | 'current' | 'ahead' | 'unsupported' }
export type UpdateProgress = { phase: 'downloading' | 'verifying' | 'ready'; received: number; total?: number }
type Phase = 'idle' | 'checking' | 'downloading' | 'verifying' | 'ready' | 'installing'
type UpdateState = { phase: Phase; result?: UpdateCheck; error: string; notice: string; received: number; total?: number }
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : cause && typeof cause === 'object' && 'message' in cause && typeof cause.message === 'string' ? cause.message : '更新失败，请稍后重试'

export async function checkForUpdate(): Promise<UpdateCheck> {
  if (!isTauri()) throw new Error('请在 BiliMusic 应用中检查更新')
  const release = await invoke<UpdateRelease>('app_check_update')
  const order = compareVersions(release.version, currentRelease) || (release.build ?? 0) - (release.currentBuild ?? 0)
  return { ...release, status: !release.available ? 'unsupported' : order > 0 ? 'available' : order < 0 ? 'ahead' : 'current' }
}
export async function openUpdateDownload() {
  if (isTauri()) await invoke('app_open_download_page')
  else window.open(downloadPage, '_blank', 'noopener,noreferrer')
}
export async function openUpdateReleaseNotes() {
  if (isTauri()) await invoke('app_open_release_notes')
  else window.open(releaseNotesPage, '_blank', 'noopener,noreferrer')
}
// Shared by both shells. Downloads survive leaving settings; only one operation runs at a time.
export const useUpdateStore = create<UpdateState>(() => ({ phase: 'idle', error: '', notice: '', received: 0 }))
let operation = 0
let lastAttempt = 0
let lastSuccess = 0
const busy = (phase: Phase) => phase !== 'idle' && phase !== 'ready'
export async function checkUpdates() {
  if (useUpdateStore.getState().phase !== 'idle') return
  const token = ++operation
  lastAttempt = Date.now()
  useUpdateStore.setState({ phase: 'checking', error: '', notice: '' })
  try {
    const result = await checkForUpdate()
    if (token !== operation) return
    lastSuccess = Date.now()
    useUpdateStore.setState({ result, phase: 'idle' })
  } catch (cause) { if (token === operation) useUpdateStore.setState({ phase: 'idle', error: errorText(cause) }) }
}
export async function downloadUpdate() {
  const state = useUpdateStore.getState()
  if (state.phase !== 'idle' || state.result?.status !== 'available' || !state.result.installable || !state.result.requestId) return
  const token = ++operation, requestId = state.result.requestId
  useUpdateStore.setState({ phase: 'downloading', error: '', notice: '', received: 0, total: state.result.size })
  const onProgress = new Channel<UpdateProgress>()
  onProgress.onmessage = progress => {
    if (token !== operation || !busy(useUpdateStore.getState().phase) || progress.phase === 'ready') return
    useUpdateStore.setState({ phase: progress.phase, received: progress.received, total: progress.total })
  }
  try {
    await invoke('app_download_update', { requestId, onProgress })
    if (token === operation) useUpdateStore.setState({ phase: 'ready' })
  } catch (cause) { if (token === operation) useUpdateStore.setState({ phase: 'idle', error: errorText(cause) }) }
}
export async function confirmUpdate(confirmed: UpdateCheck) {
  const { phase, result } = useUpdateStore.getState()
  if (phase !== 'idle') return
  if (result !== confirmed || result?.status !== 'available') {
    useUpdateStore.setState({ error: '更新信息已刷新，请重新确认' })
    return
  }
  if (result.installable) {
    await downloadUpdate()
  } else {
    try {
      await openUpdateDownload()
    } catch {
      useUpdateStore.setState({ error: '无法打开官网，请检查网络' })
    }
  }
}
export async function installUpdate(prepareLocalState: () => Promise<void>) {
  const state = useUpdateStore.getState()
  if (state.phase !== 'ready' || !state.result?.requestId) return
  const token = ++operation
  useUpdateStore.setState({ phase: 'installing', error: '', notice: '' })
  try {
    // Save the local queue and position before a desktop installer restarts the process.
    await prepareLocalState()
    const status = await invoke<string>('app_install_update', { requestId: state.result.requestId })
    if (token === operation) useUpdateStore.setState({ phase: 'ready', notice: status === 'permission-required' ? '请允许安装应用，返回后点击安装更新' : '已打开系统安装器，请完成安装' })
  } catch (cause) { if (token === operation) useUpdateStore.setState({ phase: 'ready', error: errorText(cause) }) }
}
let stopChecks: (() => void) | undefined
export function startUpdateChecks() {
  if (!isTauri() || stopChecks) return stopChecks ?? (() => {})
  const due = () => {
    const now = Date.now()
    if (!document.hidden && now - lastAttempt >= 15 * 60_000 && now - lastSuccess >= 12 * 60 * 60_000) void checkUpdates()
  }
  const first = window.setTimeout(due, 10_000)
  const timer = window.setInterval(due, 15 * 60_000)
  document.addEventListener('visibilitychange', due)
  stopChecks = () => { clearTimeout(first); clearInterval(timer); document.removeEventListener('visibilitychange', due); stopChecks = undefined }
  return stopChecks
}
