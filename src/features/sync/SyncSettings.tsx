import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { Cloud, LoaderCircle } from 'lucide-react'
import { resetPlayerForAccount } from '../player/playerStore'
import { commandErrorMessage, inDesktopShell } from '../../services/desktopApi'
import { defaultSyncConfig, refreshSyncedLibrary, syncNow, syncStatus, type SyncConfig, type SyncOutcome } from '../../services/sync'

export function SyncSettings() {
  const client = useQueryClient()
  const status = useQuery({ queryKey: ['sync-status'], queryFn: syncStatus, enabled: inDesktopShell, retry: false })
  const [config, setConfig] = useState<SyncConfig>(defaultSyncConfig)
  const [username, setUsername] = useState(''), [password, setPassword] = useState('')
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(''), [outcome, setOutcome] = useState<SyncOutcome | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  useEffect(() => { if (status.data) setConfig(status.data.config) }, [status.data])
  const notify = () => window.dispatchEvent(new Event('bilimusic-sync-configured'))
  const action = async (fn: () => Promise<void>) => {
    setBusy(true); setMessage('')
    try { await fn(); await status.refetch() } catch (e) { setMessage(commandErrorMessage(e)) }
    finally { await status.refetch(); setBusy(false) }
  }
  const connect = () => action(async () => {
    await resetPlayerForAccount()
    await invoke('sync_connect', { settings: config, username, password, consent })
    setPassword(''); setConsent(false)
    await client.invalidateQueries()
    setOutcome(await syncNow(true)); setMessage('连接成功，请确认下面的合并预览。首次确认前不会自动上传。')
  })
  const merge = (resolution?: 'local' | 'remote') => action(async () => {
    const result = await syncNow(false, resolution); setOutcome(result)
    if (result.conflicts.length && !resolution) { setMessage('同一信息存在不同修改，请选择保留哪一侧。'); return }
    await refreshSyncedLibrary(client)
    setOutcome(null)
    setMessage('同步完成。B站原始歌曲信息正在设备上补齐。'); notify()
    void invoke<number>('sync_hydrate_sources').then(() => refreshSyncedLibrary(client)).catch(() => undefined)
  })
  return <section className="sync-settings" aria-label="云同步设置"><header><Cloud /><div><h3>云同步</h3><p>默认关闭，仅同步列表和个人修改。B站原始信息由各设备获取，不上传媒体文件。</p></div></header>
    {!inDesktopShell ? <p>请在 BiliMusic 客户端中配置同步。</p> : <>
    <div className="sync-summary"><strong>{status.data?.config.enabled ? `已开启 · ${status.data.config.provider === 'cloud' ? 'BiliMusic 云' : '坚果云'}` : '已关闭 / 已暂停'}</strong><small>{status.data?.config.uid ? `当前B站 UID ${status.data.config.uid} · ` : '尚未绑定同步账号 · '}最近同步：{status.data?.lastSuccess ? `${status.data.lastSuccess} UTC` : '尚未同步'} · 本次范围约 {Math.ceil((status.data?.bytes || 0) / 1024)} KB</small></div>
    <fieldset disabled={busy}><label>同步服务<select value={config.provider} onChange={(e) => { setConfig({ ...config, provider: e.target.value as SyncConfig['provider'] }); setConsent(false); setOutcome(null) }}><option value="webdav">坚果云 WebDAV</option><option value="cloud">BiliMusic 云</option></select></label>
    {config.provider === 'webdav' ? <><label>服务器地址<input value={config.url} onChange={(e) => setConfig({ ...config, url: e.target.value })} spellCheck={false} /></label><label>坚果云账号<input type="email" value={username} autoComplete="off" onChange={(e) => setUsername(e.target.value)} /></label><label>应用专用密码<input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} /></label><small>凭据保存在系统安全存储中，直接连接坚果云，不经过我们的服务器。</small></> : <p>连接时会通过 HTTPS 将当前B站会话发送给同步服务器进行一次身份核验，服务器不保存该会话，后续使用独立的设备令牌（有效期30天）。</p>}
    <label className="sync-check"><input type="checkbox" checked={config.history} onChange={(e) => setConfig({ ...config, history: e.target.checked })} />同时同步最近播放（最多200首）</label>
    <label className="sync-check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />我同意向所选服务上传歌单、收藏、歌曲修改和歌词设置，以及勾选的最近播放，并知悉上述身份核验方式。</label>
    <button disabled={!consent} onClick={() => void connect()}>{busy && <LoaderCircle className="spin" />}连接并预览合并</button>
    </fieldset>
    {status.data?.config.uid && <div className="sync-actions"><button disabled={busy} onClick={() => void action(async () => { await invoke('sync_import_guest'); await refreshSyncedLibrary(client); setMessage('已合并本机原有资料；原资料库保留。'); setOutcome(null) })}>导入本机原有资料</button><button disabled={busy} onClick={() => void action(async () => { const path = await invoke<string>('sync_export'); setMessage(`已保存备份：${path}`) })}>导出本机备份</button>
    <button disabled={busy || !status.data.config.enabled} onClick={() => void action(async () => { setOutcome(await syncNow(true)) })}>预览同步</button>
    <button disabled={busy || !status.data.config.initialized} onClick={() => void action(async () => { await invoke('sync_pause', { paused: status.data!.config.enabled }); notify() })}>{status.data.config.enabled ? '暂停同步' : '继续同步'}</button>
    <button disabled={busy} onClick={() => void action(async () => { await invoke('sync_disconnect'); setOutcome(null); notify(); setMessage('已断开连接，云端资料保留。') })}>断开连接</button>
    {status.data.config.provider === 'cloud' && <button disabled={busy} onClick={() => setConfirmDelete(true)}>删除云端资料</button>}</div>}
    {outcome && <div className="sync-preview"><strong>合并预览：{outcome.records} 条记录，约 {Math.ceil(outcome.bytes / 1024)} KB</strong><p>只合并个人数据，不同步B站会话、媒体文件或第三方缓存。首次同步前会保留一份本机资料备份。</p>{outcome.conflicts.length ? <><p>发现 {outcome.conflicts.length} 处冲突，尚未覆盖：</p><ul>{outcome.conflicts.slice(0, 15).map((c, i) => <li key={i}><code>{c.key} / {c.field}</code><small>本机：{JSON.stringify(c.local)}<br />云端：{JSON.stringify(c.remote)}</small></li>)}</ul><div className="sync-actions"><button disabled={busy} onClick={() => void merge('local')}>冲突保留本机，其余合并</button><button disabled={busy} onClick={() => void merge('remote')}>冲突保留云端，其余合并</button></div></> : <button disabled={busy || !status.data?.config.enabled} onClick={() => void merge()}>确认合并并同步</button>}</div>}
    {confirmDelete && <div className="sync-preview"><p>将删除BiliMusic云端歌单、收藏、修改信息和历史，并撤销所有设备令牌。本机资料保留；再次连接需重新授权。</p><button disabled={busy} onClick={() => void action(async () => { await invoke('sync_delete_cloud'); setConfirmDelete(false); setOutcome(null); notify(); setMessage('已删除云端资料并暂停同步。') })}>确认删除所有云端资料</button><button onClick={() => setConfirmDelete(false)}>取消</button></div>}
    {(message || status.error) && <p className="sync-message" role="status">{message || commandErrorMessage(status.error)}</p>}
    <details><summary>隐私与存储说明</summary><p>云同步只上传上述勾选的数据。自有云保存B站UID和设备令牌摘要，令牌有效期30天；身份核验会话不落库。断开连接保留云端数据，删除云端资料会撤销全部设备令牌。服务器加密备份最多保留两个日版本，删除内容随备份轮换清除。同步使用HTTPS，不是端到端加密。坚果云最多10台设备，每台设备快照上限12MB，凭据不会发送到BiliMusic。</p></details><small>上限：500个歌单、5000首歌曲、10000个歌单成员、3MB同步包。失去所有同步列表引用的歌曲信息不再上传。关闭历史同步不会删除以前已上传的云端历史。</small>
    </>}
  </section>
}
