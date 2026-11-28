import { ArrowRight, ArrowUpCircle, Download, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react'
import { useRef, useState } from 'react'
import { LargeDialog } from '../../large-screen/LargeDialog'
import { checkUpdates, confirmUpdate, installUpdate, openUpdateReleaseNotes, useUpdateStore, type UpdateCheck } from '../../services/updates'
import { prepareForApplicationUpdate } from '../player/playerStore'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { currentDisplayVersion, formatReleaseVersion } from '../../shared/version'
import './update-settings.css'

export function UpdateSettings({ large = false }: { large?: boolean }) {
  const { phase, result, error, notice, received, total } = useUpdateStore()
  const [confirmation, setConfirmation] = useState<UpdateCheck>()
  const confirming = useRef(false)
  const busy = phase !== 'idle' && phase !== 'ready'
  const ready = phase === 'ready'
  const version = result && formatReleaseVersion(result.version, result.build)
  const message = phase === 'downloading' ? '正在下载更新…' : phase === 'verifying' ? '正在校验安装包…' : phase === 'installing' ? '正在准备安装…' : ready ? '下载完成，可以安装' : phase === 'checking' ? '正在检查最新版本…' : result?.status === 'available' ? `发现更新 ${version}` : result?.status === 'current' ? '已是最新版本' : result?.status === 'ahead' ? '当前版本较新，无需更新' : result?.status === 'unsupported' ? '暂无适用于当前设备的安装包' : ''
  const desktopInstaller = /^(mac|windows)(-|$)/.test(result?.platform ?? '')
  const percent = total && total > 0 ? Math.min(100, Math.floor(received / total * 100)) : undefined
  const requestUpdate = () => {
    if (busy || result?.status !== 'available') return
    if (ready) {
      void installUpdate(prepareForApplicationUpdate)
      return
    }
    confirming.current = false
    setConfirmation(result)
  }
  const acceptUpdate = () => {
    if (!confirmation || confirming.current) return
    confirming.current = true
    setConfirmation(undefined)
    void confirmUpdate(confirmation)
  }
  const closeConfirmation = () => setConfirmation(undefined)

  return <><section className="settings-card update-settings" aria-label="应用更新">
    <div className="settings-icon"><ArrowUpCircle /></div>
    <div><strong>应用更新</strong><small>当前版本 {currentDisplayVersion}</small></div>
    <button type="button" aria-disabled={busy || ready} onClick={() => void checkUpdates()}>{phase === 'checking' ? <LoaderCircle className="spin" /> : <RefreshCw/>}{phase === 'checking' ? '正在检查…' : '检查更新'}</button>
    {(message || error) && <div className="update-status" role="status" aria-live="polite">
      <span className={error ? 'update-error' : ''}>{error || notice || message}</span>
      {result?.status === 'available' && <button type="button" disabled={busy} onClick={requestUpdate}>
        {busy ? <LoaderCircle className="spin"/> : result.installable ? <Download/> : <ExternalLink/>}
        {busy ? phase === 'installing' ? '正在安装…' : '正在准备…' : ready ? desktopInstaller ? '安装并重启' : '安装更新' : '下载更新'}
      </button>}
    </div>}
    {(phase === 'downloading' || phase === 'verifying') && <div className="update-transfer"><progress aria-label="更新下载进度" max={100} value={percent}/><small>{percent === undefined ? '下载中' : `${percent}%`}{total ? ` · ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB` : ''}</small></div>}
  </section>
  {confirmation && (large
    ? <LargeDialog title="更新内容" className="update-confirm-dialog" onClose={closeConfirmation}>
      <UpdateConfirmation release={confirmation} onConfirm={acceptUpdate} onClose={closeConfirmation}/>
    </LargeDialog>
    : <CollectionDialog title="更新内容" className="update-confirm-dialog" mobileSheet onClose={closeConfirmation}>
      <UpdateConfirmation release={confirmation} onConfirm={acceptUpdate} onClose={closeConfirmation}/>
    </CollectionDialog>)}
  </>
}

function UpdateConfirmation({ release, onConfirm, onClose }: { release: UpdateCheck; onConfirm: () => void; onClose: () => void }) {
  const [linkError, setLinkError] = useState(false)

  return <div className="update-confirm-content">
    <div className="update-confirm-version">
      <span>{currentDisplayVersion}</span><ArrowRight size={16} aria-label="更新到"/>
      <strong>{formatReleaseVersion(release.version, release.build)}</strong>
      {release.size && <small>{(release.size / 1048576).toFixed(1)} MB</small>}
    </div>
    {release.updateNotes?.length
      ? <ul className="update-confirm-notes">{release.updateNotes.map((note, index) => <li key={index}>{note}</li>)}</ul>
      : <p className="update-confirm-empty">暂无更新说明</p>}
    <button type="button" className="update-confirm-link" onClick={() => void openUpdateReleaseNotes().then(() => setLinkError(false), () => setLinkError(true))}>
      查看完整日志<ExternalLink size={14} aria-hidden="true"/>
    </button>
    {linkError && <p className="update-confirm-error" role="alert">无法打开更新日志</p>}
    <div className="update-confirm-actions">
      <button type="button" className="collection-flat-button" data-dialog-autofocus onClick={onClose}>稍后</button>
      <button type="button" className="collection-primary large-primary" onClick={onConfirm}>
        {release.installable ? <><Download size={17} aria-hidden="true"/>确认下载</> : <><ExternalLink size={17} aria-hidden="true"/>前往官网</>}
      </button>
    </div>
  </div>
}
