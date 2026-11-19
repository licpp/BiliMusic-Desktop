import { ArrowUpCircle, Download, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react'
import { checkUpdates, downloadUpdate, installUpdate, openUpdateDownload, useUpdateStore } from '../../services/updates'
import { currentDisplayVersion, formatReleaseVersion } from '../../shared/version'

export function UpdateSettings() {
  const { phase, result, error, notice, received, total } = useUpdateStore()
  const busy = phase !== 'idle' && phase !== 'ready'
  const ready = phase === 'ready'
  const version = result && formatReleaseVersion(result.version, result.build)
  const message = phase === 'downloading' ? '正在下载更新…' : phase === 'verifying' ? '正在校验安装包…' : phase === 'installing' ? '正在准备安装…' : ready ? '下载完成，可以安装' : phase === 'checking' ? '正在检查最新版本…' : result?.status === 'available' ? `发现更新 ${version}` : result?.status === 'current' ? '已是最新版本' : result?.status === 'ahead' ? '当前版本较新，无需更新' : result?.status === 'unsupported' ? '暂无适用于当前设备的安装包' : ''
  const desktopInstaller = /^(mac|windows)(-|$)/.test(result?.platform ?? '')
  const percent = total && total > 0 ? Math.min(100, Math.floor(received / total * 100)) : undefined
  return <section className="settings-card update-settings" aria-label="应用更新">
    <div className="settings-icon"><ArrowUpCircle /></div>
    <div><strong>应用更新</strong><small>当前版本 {currentDisplayVersion}</small></div>
    <button type="button" aria-disabled={busy || ready} onClick={() => void checkUpdates()}>{phase === 'checking' ? <LoaderCircle className="spin" /> : <RefreshCw/>}{phase === 'checking' ? '正在检查…' : '检查更新'}</button>
    {(message || error) && <div className="update-status" role="status" aria-live="polite">
      <span className={error ? 'update-error' : ''}>{error || notice || message}</span>
      {result?.status === 'available' && (result.installable ? <button type="button" aria-disabled={busy} onClick={() => void (ready ? installUpdate() : downloadUpdate())}>{busy ? <LoaderCircle className="spin"/> : <Download/>}{busy ? phase === 'installing' ? '正在安装…' : '正在准备…' : ready ? desktopInstaller ? '安装并重启' : '安装更新' : '下载更新'}</button> : <button type="button" onClick={() => void openUpdateDownload().catch(() => useUpdateStore.setState({ error: '无法打开官网，请检查网络' }))}><ExternalLink/>前往官网下载</button>)}
    </div>}
    {(phase === 'downloading' || phase === 'verifying') && <div className="update-transfer"><progress aria-label="更新下载进度" max={100} value={percent}/><small>{percent === undefined ? '下载中' : `${percent}%`}{total ? ` · ${(received / 1048576).toFixed(1)} / ${(total / 1048576).toFixed(1)} MB` : ''}</small></div>}
  </section>
}
