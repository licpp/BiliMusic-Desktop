import { accountQueryKey } from '../../services/queryKeys'
import { syncErrorMessage } from '../../services/userErrors'
import { useSyncAttention, clearSyncAttention, reportSyncError } from '../../services/syncAttention'
import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { Check, ChevronDown, Cloud, LoaderCircle, RefreshCw } from 'lucide-react'
import { ActionMenu } from '../../shared/ActionMenu'
import { SyncDevices } from './SyncDevices'
import { SyncTrackRepair } from './SyncTrackRepair'
import { SyncRecovery, type IssueArea } from './SyncRecovery'
import { describeSyncIssue, type SyncIssue } from '../../services/syncIssues'
import { accountEpoch } from '../../services/accountScope'
import { inDesktopShell } from '../../services/desktopApi'
import { hydrateSources } from '../../services/sourceHydration'
import { defaultSyncConfig, syncNow, syncStatus, type SyncConfig, type SyncOutcome, type TrackRepairPreview } from '../../services/sync'
import { refreshSyncedLibrary } from './librarySync'

function syncTime(value?: string) {
  if (!value) return '尚未同步'
  const date = new Date(`${value.replace(' ', 'T')}Z`)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function SyncSettings({embedded=false}:{embedded?:boolean}={}) {
  const pending = useSyncAttention(state => state.outcome)
  const libraryIssue = useSyncAttention(state => state.libraryIssue)
  const statisticsIssue = useSyncAttention(state => state.statisticsIssue)
  const client = useQueryClient()
  const status = useQuery({ queryKey: accountQueryKey('sync-status'), queryFn: syncStatus, enabled: inDesktopShell, retry: false })
  const [config, setConfig] = useState<SyncConfig>(defaultSyncConfig)
  const [username, setUsername] = useState(''), [password, setPassword] = useState('')
  const [consent, setConsent] = useState(false), [busy, setBusy] = useState(false)
  const [message, setMessage] = useState(''), [outcome, setOutcome] = useState<SyncOutcome | null>(pending)
  const [editing, setEditing] = useState(false), [confirmDelete, setConfirmDelete] = useState(false)
  const [repair, setRepair] = useState<TrackRepairPreview | null>(null)
  const [repairBackup, setRepairBackup] = useState('')
  const [recovery, setRecovery] = useState(false)
  const [requestIssue, setRequestIssue] = useState<SyncIssue | null>(null)
  useEffect(() => {
    const reset = () => {
      setRepair(null); setRepairBackup(''); setRecovery(false); setRequestIssue(null)
      setOutcome(null); setMessage(''); setEditing(false); setPassword(''); setConsent(false)
    }
    window.addEventListener('bilimusic-account-changing', reset)
    return () => window.removeEventListener('bilimusic-account-changing', reset)
  }, [])
  useEffect(() => { setOutcome(pending) }, [pending])
  const saved = status.data?.config
  const connected = !!(saved?.enabled || saved?.initialized)
  useEffect(() => { if (status.data) setConfig(status.data.config) }, [status.data])
  const notify = () => window.dispatchEvent(new Event('bilimusic-sync-configured'))
  const action = async (fn: (session: number) => Promise<void>, syncAction: 'sync' | 'connect' | false = false) => {
    const session = accountEpoch()
    setBusy(true); setMessage('')
    if (syncAction) setRequestIssue(null)
    try { await fn(session) } catch (e) {
      if (session === accountEpoch()) {
        setMessage(syncErrorMessage(e))
        if (syncAction) {
          if (syncAction === 'connect') setRequestIssue(describeSyncIssue(e))
          setRecovery(true)
        }
      }
    } finally {
      if (session === accountEpoch()) await status.refetch()
      setBusy(false)
    }
  }
  const syncStatistics = async (session: number) => {
    try {
      const synced = await invoke<boolean>('listening_sync')
      if (!synced || session !== accountEpoch()) return
      reportSyncError('statistics', false)
      await client.invalidateQueries({queryKey:accountQueryKey('listening-statistics')})
    } catch (e) {
      if (session !== accountEpoch()) return
      reportSyncError('statistics', true, e)
      setRecovery(true)
    }
  }
  const applyOutcome = async (result: SyncOutcome, session: number) => {
    if (session !== accountEpoch() || result.skipped) return
    setOutcome(result)
    if (result.conflicts.length) {
      setMessage('发现不同修改，请选择保留哪一侧。')
      setRecovery(true)
      return
    }
    await refreshSyncedLibrary(client)
    if (session !== accountEpoch()) return
    setOutcome(null)
    if (result.importError || result.visibilityError || result.chaptersError) {
      await status.refetch()
      if (session !== accountEpoch()) return
      setMessage('音乐库已同步，部分资料待处理')
      setRecovery(true)
    } else {
      setMessage('同步完成')
    }
    notify()
    await syncStatistics(session)
    void hydrateSources(session)
      .then(loaded => { if (loaded && session === accountEpoch()) return refreshSyncedLibrary(client) })
      .catch(() => undefined)
  }
  const connect = () => action(async session => {
    setOutcome(null)
    await invoke('sync_connect', { settings: config, username, password, consent })
    if (session !== accountEpoch()) return
    clearSyncAttention()
    setPassword(''); setConsent(false); setEditing(false); window.dispatchEvent(new Event('bilimusic-statistics-sync-requested'))
    await client.invalidateQueries()
    if (session === accountEpoch()) await applyOutcome(await syncNow(false), session)
  }, 'connect')
  const merge = (resolution?: string) => action(async session => { await applyOutcome(await syncNow(false, resolution), session) }, 'sync')
  const preview = () => action(async session => {
    const result = await syncNow(true)
    if (session !== accountEpoch() || result.skipped) return
    setOutcome(result)
    if (result.conflicts.length) setRecovery(true)
    else setRecovery(false)
  }, 'sync')
  const archive = (revision: string) => {
    const session = accountEpoch()
    setRepair(null)
    void action(async () => {
      const path = await invoke<string>('sync_archive_invalid_track_references', { revision })
      if (session !== accountEpoch()) return
      setRepairBackup(path)
      setRequestIssue(null)
      setOutcome(null)
      await refreshSyncedLibrary(client)
      if (session !== accountEpoch()) return
      if (saved?.enabled) {
        const result = await syncNow(false)
        if (session === accountEpoch()) await applyOutcome(result, session)
      } else setMessage('修复完成')
    }, 'sync')
  }
  const issues: { area: IssueArea; issue: SyncIssue }[] = []
  const currentIssue = requestIssue || libraryIssue
  if (!status.data?.trackRepair) {
    if (currentIssue && !status.data?.localError) issues.push({ area: '音乐库', issue: currentIssue })
    else if (status.error) issues.push({ area: '音乐库', issue: describeSyncIssue(status.error) })
  }
  if (status.data?.localError) issues.push({ area: '本机资料', issue: describeSyncIssue(status.data.localError) })
  if (status.data?.importError) issues.push({ area: '导入歌单', issue: describeSyncIssue(status.data.importError) })
  if (status.data?.visibilityError) issues.push({ area: '隐藏偏好', issue: describeSyncIssue(status.data.visibilityError) })
  if (status.data?.chaptersError) issues.push({ area: '章节', issue: describeSyncIssue(status.data.chaptersError) })
  if (statisticsIssue) issues.push({ area: '听歌统计', issue: statisticsIssue })
  const exportBackup = () => action(async session => {
    const path = await invoke<string>('sync_export')
    if (session === accountEpoch()) setMessage(`备份已保存到 ${path}`)
  })
  const retry = (statisticsOnly: boolean) => {
    if (statisticsOnly) return action(session => syncStatistics(session))
    if (!saved?.enabled) return status.refetch()
    if (outcome?.conflicts.length || issues.some(({issue}) => issue.kind === 'conflict')) return preview()
    return merge()
  }
  return <section className={`sync-settings${embedded?' sync-settings-embedded':''}`} aria-label="云同步设置">
    {(!embedded||connected)&&<div className="sync-heading">
      {!embedded&&<><div className="settings-icon"><Cloud /></div>
      <div className="sync-heading-copy"><h3>云同步</h3><p>{connected ? `${saved?.provider === 'cloud' ? 'BiliMusic 云' : '坚果云'} · ${saved?.enabled ? saved.initialized ? '已开启' : '待首次同步' : '已暂停'}` : '在不同设备间同步你的音乐资料，默认关闭'}</p></div></>}
      {inDesktopShell && <div className="sync-toolbar">
        {connected ? <><button className="sync-primary" disabled={busy || !saved?.enabled} onClick={() => void merge()}>{busy ? <LoaderCircle className="spin" /> : <RefreshCw />}{saved?.initialized ? '立即同步' : '首次同步'}</button><button disabled={busy || !saved?.initialized} onClick={() => void action(async () => { await invoke('sync_pause', { paused: saved!.enabled }); notify() })}>{saved?.enabled ? '暂停' : '继续'}</button></> : <button className="sync-primary" disabled={busy || status.isPending} aria-expanded={editing} onClick={() => setEditing(!editing)}>{editing ? '收起' : '设置同步'}</button>}
      </div>}
    </div>}
    {!inDesktopShell ? <p className="sync-note">请在 BiliMusic 客户端中配置同步。</p> : <>
      {connected && <div className="sync-info"><span>最近同步</span><span>{syncTime(status.data?.lastSuccess)}</span><span>同步内容</span><span>歌单、B 站关联收藏夹、合集收藏、歌曲信息、歌词设置{saved?.history ? '、最近播放和合集续播进度' : ''}</span></div>}
      {connected && <button className="sync-link" disabled={busy} aria-expanded={editing} onClick={() => { setEditing(!editing); setConsent(false) }}>{editing ? '收起连接设置' : '更改连接与同步内容'}</button>}
      {(editing||embedded&&!connected) && <form className="sync-connection" onSubmit={(e) => { e.preventDefault(); if (consent && !busy && config.provider === 'webdav') void connect() }}>
        <fieldset disabled={busy||status.isPending}>
          <div className="sync-provider-field"><span id="sync-provider-label">同步服务</span><div className="sync-provider-picker" role="group" aria-labelledby="sync-provider-label">
            <ActionMenu label={`同步服务：${config.provider==='cloud'?'BiliMusic 云':'坚果云'}`} panelClassName="sync-provider-menu" icon={<><Cloud size={16}/><span>{config.provider==='cloud'?'BiliMusic 云':'坚果云'}</span><ChevronDown size={16}/></>}>
              {close=><>
                <button type="button" role="menuitemradio" aria-checked={config.provider==='webdav'} disabled={busy} onClick={()=>{setConfig({...config,provider:'webdav'});setConsent(false);close()}}><span>坚果云<small>WebDAV 同步</small></span>{config.provider==='webdav'&&<Check size={16}/>}</button>
                <button type="button" role="menuitemradio" aria-checked={config.provider==='cloud'} disabled><span>BiliMusic 云<small>暂不可用</small></span>{config.provider==='cloud'&&<Check size={16}/>}</button>
              </>}
            </ActionMenu>
          </div></div>
          {config.provider === 'webdav' ? <>
            <div className="sync-credentials"><label>坚果云账号<input type="text" inputMode="email" required value={username} autoComplete="off" placeholder="邮箱或手机号" onChange={(e) => setUsername(e.target.value)} /></label><label>应用密码<input type="password" required value={password} autoComplete="new-password" placeholder="坚果云中生成的应用密码" onChange={(e) => setPassword(e.target.value)} /></label></div>
            <details className="sync-address"><summary>服务器地址</summary><label><input aria-label="服务器地址" value={config.url} required type="url" onChange={(e) => setConfig({ ...config, url: e.target.value })} spellCheck={false} /></label></details>
            <p className="sync-note">凭据保存在系统安全存储中，直接连接坚果云。</p>
          </> : <p className="sync-note">BiliMusic 云暂不可用，请选择坚果云连接。</p>}
          <label className="sync-check"><input type="checkbox" checked={config.history} onChange={(e) => setConfig({ ...config, history: e.target.checked })} /><span>同步播放记录<small>最近 200 首的记录和断点、收藏合集续播，默认关闭</small></span></label>
          <p className="sync-note">听歌统计通过所选服务，按 B 站账号自动汇总所有设备，无需先完成资料库合并。可在听歌统计页查看、暂停或恢复。</p>
          <label className="sync-check"><input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} /><span>同意向所选服务同步歌单、B 站关联收藏夹、合集收藏、歌曲修改和歌词设置，以及听歌统计和所选的播放记录，并同意上述身份核验方式。</span></label>
          <div className="sync-actions"><button className="sync-primary" type="submit" disabled={!consent || config.provider === 'cloud'}>{busy && <LoaderCircle className="spin" />}连接并同步</button>{(!embedded||connected)&&<button type="button" onClick={() => { setEditing(false); setPassword(''); setConsent(false); if (saved) setConfig(saved) }}>取消</button>}</div>
        </fieldset>
      </form>}
      {status.data?.trackRepair && <div className="sync-preview">
        <strong>同步记录缺少歌曲</strong>
        <p>有 {status.data.trackRepair.total} 条本机记录需要处理。</p>
        <button type="button" className="sync-primary" disabled={busy} onClick={() => setRepair(status.data?.trackRepair ?? null)}>查看并修复</button>
      </div>}
      {repair && <SyncTrackRepair preview={repair} onClose={() => setRepair(null)} onArchive={archive} />}
      {repairBackup && <p className="sync-repair-backup" role="status">修复备份已保存到 <code>{repairBackup}</code></p>}
      {(outcome?.conflicts.length || issues.length > 0) ? <div className="sync-preview">
        <strong>{outcome?.conflicts.length ? `有 ${outcome.conflicts.length} 处修改需要确认` : '同步待处理'}</strong>
        {issues.length > 0 && <p>{issues.map(({area}) => area).join('、')}</p>}
        <button className="sync-primary" type="button" onClick={() => setRecovery(true)}>处理同步问题</button>
      </div> : outcome && <div className="sync-preview"><strong>资料已准备好合并</strong><p>{outcome.records} 条资料 · 首次同步前自动保留本机备份</p><button className="sync-primary" disabled={busy || !saved?.enabled} onClick={() => void merge()}>确认合并并同步</button></div>}
      {recovery && !repair && (!status.data?.trackRepair || issues.length > 0 || !!outcome?.conflicts.length) && <SyncRecovery
        issues={issues} outcome={outcome} config={saved} busy={busy} message={requestIssue || outcome?.conflicts.length && issues.length === 0 ? '' : message}
        onClose={() => setRecovery(false)} onMerge={resolution => void merge(resolution)} onRetry={onlyStatistics => void retry(onlyStatistics)}
        onReconnect={() => { setRecovery(false); setConsent(false); setEditing(true) }}
        onBackup={saved?.uid && !status.data?.localError && !status.data?.trackRepair ? () => void exportBackup() : undefined}
      />}
      {message && <p className="sync-message" role="status">{message}</p>}
      {connected && saved?.provider === 'webdav' && saved.initialized && <SyncDevices />}
      <details className="sync-more"><summary>资料管理与隐私</summary><div className="sync-more-content">
        {saved?.uid && <>
          <div className="sync-setting-row"><div><strong>本机资料</strong><small>导入保留原资料；备份导出到本机。</small></div><div className="sync-actions"><button disabled={busy} onClick={() => void action(async () => { await invoke('sync_import_guest'); await refreshSyncedLibrary(client); setMessage('已导入本机原有资料'); setOutcome(null) })}>导入原有资料</button><button disabled={busy} onClick={() => void action(async () => { const path = await invoke<string>('sync_export'); setMessage(`备份已保存：${path}`) })}>导出备份</button></div></div>
          {connected && <div className="sync-setting-row"><div><strong>连接管理</strong><small>断开后保留本机和云端资料。</small></div><div className="sync-actions"><button disabled={busy || !saved.enabled} onClick={() => void preview()}>预览同步</button><button disabled={busy} onClick={() => void action(async () => { await invoke('sync_disconnect'); clearSyncAttention(); setOutcome(null); setEditing(false); notify(); window.dispatchEvent(new Event('bilimusic-statistics-sync-requested')); setMessage('已断开连接') })}>断开连接</button>{saved.provider === 'cloud' && <button className="sync-danger" disabled={busy} onClick={() => setConfirmDelete(true)}>删除云端资料</button>}</div></div>}
        </>}
        <details><summary>隐私与存储说明</summary><p>只同步个人资料，不上传音视频或登录会话缓存。关联收藏夹只同步导入清单和名称，内容从 B 站重新读取。失去所有同步列表引用的歌曲修改不再上传。每个收藏合集只保留一条续播进度。关闭播放记录同步后，已上传的播放记录仍会保留在云端。</p><p>BiliMusic 云保存B站UID和设备令牌摘要，令牌30天到期；身份核验会话不落库。删除云端资料会撤销全部设备令牌，加密备份最多保留两个日版本，删除内容随轮换清除。坚果云凭据不发送到BiliMusic。传输使用HTTPS，不是端到端加密。</p><p>每个账号最多500个歌单、5000首歌曲、10000个歌单成员。坚果云使用增量同步，每个同步对象上限12MB；请将所有设备更新到支持新版同步的版本。</p></details>
      </div></details>
      {confirmDelete && <div className="sync-preview" role="alert"><strong>删除全部云端资料？</strong><p>将删除云端歌单、合集收藏、修改和历史，并撤销所有设备令牌。本机资料保留。</p><div className="sync-actions"><button className="sync-danger" disabled={busy} onClick={() => void action(async () => { await invoke('sync_delete_cloud'); setConfirmDelete(false); setOutcome(null); notify(); setMessage('已删除云端资料并暂停同步') })}>确认删除</button><button disabled={busy} onClick={() => setConfirmDelete(false)}>取消</button></div></div>}
    </>}
  </section>
}
