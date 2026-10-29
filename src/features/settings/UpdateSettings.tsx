import { useState } from 'react'
import { ArrowUpCircle, ExternalLink, LoaderCircle } from 'lucide-react'
import { commandErrorMessage } from '../../services/desktopApi'
import { checkForUpdate, currentRelease, openUpdateDownload, type UpdateCheck } from '../../services/updates'

export function UpdateSettings() {
  const [checking, setChecking] = useState(false)
  const [opening, setOpening] = useState(false)
  const [result, setResult] = useState<UpdateCheck | null>(null)
  const [error, setError] = useState('')
  const check = async () => {
    if (checking) return
    setChecking(true); setError(''); setResult(null)
    try { setResult(await checkForUpdate()) }
    catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setChecking(false) }
  }
  const download = async () => {
    if (opening) return
    setOpening(true); setError('')
    try { await openUpdateDownload() }
    catch (cause) { setError(`无法打开官网：${commandErrorMessage(cause)}`) }
    finally { setOpening(false) }
  }
  const message = result?.status === 'available' ? `发现新版本 ${result.version}` : result?.status === 'current' ? '已是最新版本' : result?.status === 'ahead' ? '当前版本较新，无需更新' : result?.status === 'unsupported' ? '官网暂无适用于当前设备的安装包' : ''
  return <section className="settings-card update-settings" aria-label="应用更新">
    <div className="settings-icon"><ArrowUpCircle /></div>
    <div><strong>应用更新</strong><small>当前版本 {currentRelease}</small></div>
    <button type="button" disabled={checking} onClick={() => void check()}>{checking && <LoaderCircle className="spin" />}{checking ? '正在检查…' : '检查更新'}</button>
    {(checking || message || error) && <div className="update-status" role="status" aria-live="polite"><span className={error ? 'update-error' : ''}>{error || (checking ? '正在查询官网最新版本…' : message)}</span>{result?.status === 'available' && <button type="button" disabled={checking || opening} onClick={() => void download()}><ExternalLink />{opening ? '正在打开…' : '前往官网下载'}</button>}</div>}
  </section>
}
