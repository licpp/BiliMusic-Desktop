import { Download, FolderOpen, LoaderCircle, Settings2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { commandErrorMessage, inDesktopShell } from '../../services/desktopApi'
import { chooseDownloadDirectory, getDownloadDirectory } from '../../services/settings'

export function SettingsView() {
  const [downloadDirectory, setDownloadDirectory] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!inDesktopShell) { setLoading(false); return }
    void getDownloadDirectory().then(setDownloadDirectory).catch((cause) => setError(commandErrorMessage(cause))).finally(() => setLoading(false))
  }, [])

  const chooseDirectory = async () => {
    setError('')
    try {
      const selected = await chooseDownloadDirectory()
      if (!selected) return
      setDownloadDirectory(selected)
    } catch (cause) { setError(commandErrorMessage(cause)) }
  }

  return <section className="settings-view"><header><span className="eyebrow">PREFERENCES</span><h2>设置</h2><p>本机偏好只保存在当前设备。</p></header><div className="settings-card"><div className="settings-icon"><Download /></div><div><strong>下载目录</strong><small>{!inDesktopShell ? '浏览器预览不支持选择本机下载目录' : loading ? '正在读取设置' : downloadDirectory || '尚未选择，下载前会再次询问'}</small></div><button onClick={() => void chooseDirectory()} disabled={loading || !inDesktopShell}>{loading ? <LoaderCircle className="spin" /> : <FolderOpen />}选择目录</button></div>{error && <div className="settings-error"><Settings2 />{error}</div>}</section>
}
