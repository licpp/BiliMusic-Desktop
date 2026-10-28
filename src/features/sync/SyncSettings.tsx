import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { Cloud, LoaderCircle, RefreshCw } from 'lucide-react'
import { resetPlayerForAccount } from '../player/playerStore'
import { commandErrorMessage, inDesktopShell } from '../../services/desktopApi'
import { defaultSyncConfig, refreshSyncedLibrary, syncNow, syncStatus, type SyncConfig, type SyncOutcome } from '../../services/sync'

function syncTime(value?: string) {
  if (!value) return '尚未同步'
  const date = new Date(`${value.replace(' ', 'T')}Z`)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function SyncSettings() {
  const client = useQueryClient()
  const status = useQuery({ queryKey: ['sync-status'], queryFn: syncStatus, enabled: inDesktopShell, retry: false })
  const [config, setConfig] = useState<SyncConfig>(defaultSyncConfig)
  const [username, setUsername] = useState(''), [password, setPassword] = useState('')
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(''), [outcome, setOutcome] = useState<SyncOutcome | null>(null)
  const [editing, setEditing] = useState(false), [confirmDelete, setConfirmDelete] = useState(false)
  const saved = status.data?.config
  const connected = !!(saved?.enabled || saved?.initialized)
  useEffect(() => { if (status.data) setConfig(status.data.config) }, [status.data])
  const notify = () => window.dispatchEvent(new Event('bilimusic-sync-configured'))
  const action = async (fn: () => Promise<void>) => {
    setBusy(true); setMessage('')
    try { await fn() } catch (e) { setMessage(commandErrorMessage(e)) }
    finally { await status.refetch(); setBusy(false) }
  }
  const connect = () => action(async () => {
    await resetPlayerForAccount()
    await invoke('sync_connect', { settings: config, username, password, consent })
    setPassword(''); setConsent(false); setEditing(false)
    await client.invalidateQueries()
    setOutcome(await syncNow(true)); setMessage('连接成功，确认首次合并后开始同步。')
  })
  const merge = (resolution?: 'local' | 'remote') => action(async () => {
    const result = await syncNow(false, resolution); setOutcome(result)
    if (result.conflicts.length && !resolution) { setMessage('发现不同修改，请选择保留哪一侧。'); return }
    await refreshSyncedLibrary(client)
    setOutcome(null); setMessage('同步完成'); notify()
    void invoke<number>('sync_hydrate_sources').then(() => refreshSyncedLibrary(client)).catch(() => undefined)
  })
  const preview = () => action(async () => { setOutcome(await syncNow(true)) })
  return <section className="sync-settings" aria-label="云同步设置">
    <div className="sync-heading">
      <div className="settings-icon"><Cloud /></div>
      <div className="sync-heading-copy"><h3>云同步</h3><p>{connected ? `${saved?.provider === 'cloud' ? 'BiliMusic 云' : '坚果云'} · ${saved?.enabled ? saved.initialized ? '已开启' : '待首次同步' : '已暂停'}` : '在不同设备间同步你的音乐资料，默认关闭'}</p></div>
      {inDesktopShell && <div className="sync-toolbar">
        {connected ? <><button className="sync-primary" disabled={busy || !saved?.enabled} onClick={() => void (saved?.initialized ? merge() : preview())}>{busy ? <LoaderCircle className="spin" /> : <RefreshCw />}{saved?.initialized ? '立即同步' : '首次同步'}</button><button disabled={busy || !saved?.initialized} onClick={() => void action(async () => { await invoke('sync_pause', { paused: saved!.enabled }); notify() })}>{saved?.enabled ? '暂停' : '继续'}</button></> : <button className="sync-primary" disabled={busy || status.isPending} aria-expanded={editing} onClick={() => setEditing(!editing)}>{editing ? '收起' : '设置同步'}</button>}
      </div>}
    </div>
    {!inDesktopShell ? <p className="sync-note">请在 BiliMusic 客户端中配置同步。</p> : <>
      {connected && <div className="sync-info"><span>最近同步</span><span>{syncTime(status.data?.lastSuccess)}</span><span>同步内容</span><span>歌单、收藏、歌曲信息、歌词设置{saved?.history ? '、最近播放' : ''}</span></div>}
      {connected && <button className="sync-link" disabled={busy} aria-expanded={editing} onClick={() => { setEditing(!editing); setConsent(false) }}>{editing ? '收起连接设置' : '更改连接与同步内容'}</button>}
      {editing && <form className="sync-connection" onSubmit={(e) => { e.preventDefault(); if (consent && !busy) void connect() }}>
        <fieldset disabled={busy}>
          <label>同步服务<select value={config.provider} onChange={(e) => { setConfig({ ...config, provider: e.target.value as SyncConfig['provider'] }); setConsent(false) }}><option value="webdav">坚果云</option><option value="cloud">BiliMusic 云</option></select></label>
          {config.provider === 'webdav' ? <>
            <div className="sync-credentials"><label>坚果云账号<input type="text" inputMode="email" required value={username} autoComplete="off" placeholder="邮箱或手机号" onChange={(e) => setUsername(e.target.value)} /></label><label>应用密码<input type="password" required value={password} autoComplete="new-password" placeholder="坚果云中生成的应用密码" onChange={(e) => setPassword(e.target.value)} /></label></div>
            <details className="sync-address"><summary>服务器地址</summary><label><input aria-label="服务器地址" value={config.url} required type="url" onChange={(e) => setConfig({ ...config, url: e.target.value })} spellCheck={false} /></label></details>
            <p className="sync-note">凭据保存在系统安全存储中，直接连接坚果云。</p>
          </> : <p className="sync-note">通过 HTTPS 使用当前B站登录会话核验身份，服务器不保存该会话，后续使用设备令牌。</p>}
          <label className="sync-check"><input type="checkbox" checked={config.history} onChange={(e) => setConfig({ ...config, history: e.target.checked })} /><span>同步最近播放<small>最多200首，默认关闭</small></span></label>
          <label className="sync-check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>同意向所选服务同步歌单、收藏、歌曲修改和歌词设置，以及所选的最近播放，并同意上述身份核验方式。</span></label>
          <div className="sync-actions"><button className="sync-primary" type="submit" disabled={!consent}>{busy && <LoaderCircle className="spin" />}连接并预览</button><button type="button" onClick={() => { setEditing(false); setPassword(''); setConsent(false); if (saved) setConfig(saved) }}>取消</button></div>
        </fieldset>
      </form>}
      {outcome && <div className="sync-preview"><strong>{outcome.conflicts.length ? `有 ${outcome.conflicts.length} 处修改需要确认` : '资料已准备好合并'}</strong><p>{outcome.records} 条资料 · 首次同步前自动保留本机备份</p>{outcome.conflicts.length ? <><details><summary>查看不同的修改</summary><ul>{outcome.conflicts.map((c, i) => <li key={i}><code>{c.key} / {c.field}</code><small>本机：{JSON.stringify(c.local)}<br />云端：{JSON.stringify(c.remote)}</small></li>)}</ul></details><div className="sync-actions"><button disabled={busy} onClick={() => void merge('local')}>冲突保留本机</button><button disabled={busy} onClick={() => void merge('remote')}>冲突保留云端</button></div><small>其余资料正常合并。</small></> : <button className="sync-primary" disabled={busy || !saved?.enabled} onClick={() => void merge()}>确认合并并同步</button>}</div>}
      {(message || status.error) && <p className="sync-message" role="status">{message || commandErrorMessage(status.error)}</p>}
      <details className="sync-more"><summary>资料管理与隐私</summary><div className="sync-more-content">
        {saved?.uid && <>
          <div className="sync-setting-row"><div><strong>本机资料</strong><small>导入保留原资料；备份导出到本机。</small></div><div className="sync-actions"><button disabled={busy} onClick={() => void action(async () => { await invoke('sync_import_guest'); await refreshSyncedLibrary(client); setMessage('已导入本机原有资料'); setOutcome(null) })}>导入原有资料</button><button disabled={busy} onClick={() => void action(async () => { const path = await invoke<string>('sync_export'); setMessage(`备份已保存：${path}`) })}>导出备份</button></div></div>
          {connected && <div className="sync-setting-row"><div><strong>连接管理</strong><small>断开后保留本机和云端资料。</small></div><div className="sync-actions"><button disabled={busy || !saved.enabled} onClick={() => void preview()}>预览同步</button><button disabled={busy} onClick={() => void action(async () => { await invoke('sync_disconnect'); setOutcome(null); setEditing(false); notify(); setMessage('已断开连接') })}>断开连接</button>{saved.provider === 'cloud' && <button className="sync-danger" disabled={busy} onClick={() => setConfirmDelete(true)}>删除云端资料</button>}</div></div>}
        </>}
        <details><summary>隐私与存储说明</summary><p>只同步个人资料，不上传音视频、B站原始信息或登录会话缓存。失去所有同步列表引用的歌曲修改不再上传。关闭历史同步不会删除以前已上传的历史。</p><p>BiliMusic 云保存B站UID和设备令牌摘要，令牌30天到期；身份核验会话不落库。删除云端资料会撤销全部设备令牌，加密备份最多保留两个日版本，删除内容随轮换清除。坚果云凭据不发送到BiliMusic。传输使用HTTPS，不是端到端加密。</p><p>每个账号最多500个歌单、5000首歌曲、10000个歌单成员；BiliMusic云同步包上限3MB，坚果云最多10台设备，每台快照上限12MB。</p></details>
      </div></details>
      {confirmDelete && <div className="sync-preview" role="alert"><strong>删除全部云端资料？</strong><p>将删除云端歌单、收藏、修改和历史，并撤销所有设备令牌。本机资料保留。</p><div className="sync-actions"><button className="sync-danger" disabled={busy} onClick={() => void action(async () => { await invoke('sync_delete_cloud'); setConfirmDelete(false); setOutcome(null); notify(); setMessage('已删除云端资料并暂停同步') })}>确认删除</button><button disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button></div></div>}
    </>}
  </section>
}
