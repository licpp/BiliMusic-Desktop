import { Download, FolderOpen, LoaderCircle, Settings2, Sun } from 'lucide-react'
import { useThemeStore } from '../../services/theme'
import { useEffect, useState } from 'react'
import { commandErrorMessage, inDesktopShell } from '../../services/desktopApi'
import { chooseDownloadDirectory, getDownloadDirectory } from '../../services/settings'

export function SettingsView() {
  const theme = useThemeStore((state) => state.theme)
  const setTheme = useThemeStore((state) => state.setTheme)
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

  return <section className="settings-view"><header><span className="eyebrow">PREFERENCES</span><h2>设置</h2><p>本机偏好只保存在当前设备。</p></header><div className="settings-card"><div className="settings-icon"><Sun /></div><div><strong>外观主题</strong><small>可在顶部快速切换，选择会自动保存。</small></div><div className="theme-options"><button className={theme === 'dark' ? 'selected' : ''} aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>深色</button><button className={theme === 'light' ? 'selected' : ''} aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>浅色</button></div></div><div className="settings-card"><div className="settings-icon"><Download /></div><div><strong>下载目录</strong><small>{!inDesktopShell ? '浏览器预览不支持选择本机下载目录' : loading ? '正在读取设置' : downloadDirectory || '尚未选择，下载前会再次询问'}</small></div><button onClick={() => void chooseDirectory()} disabled={loading || !inDesktopShell}>{loading ? <LoaderCircle className="spin" /> : <FolderOpen />}选择目录</button></div>{error && <div className="settings-error"><Settings2 />{error}</div>}</section>
}
