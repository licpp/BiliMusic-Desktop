import { ShortcutSettings } from './ShortcutSettings'
import { FloatingLyricsSettings } from './FloatingLyricsSettings'
import { UpdateSettings } from './UpdateSettings'
import { PlaybackCacheSettings } from './PlaybackCacheSettings'
import { SyncSettings } from '../sync/SyncSettings'
import { isMobile, isIOS, isOHOS } from '../../services/platform'
import { Cloud, Download, FolderOpen, HardDrive, History, LoaderCircle, Sun } from 'lucide-react'
import { SettingsDisclosure } from './SettingsDisclosure'
import { usePlayerStore } from '../player/playerStore'
import { useThemeStore } from '../../services/theme'
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { commandErrorMessage, inDesktopShell } from '../../services/desktopApi'
import { chooseDownloadDirectory, getDownloadDirectory } from '../../services/settings'
import { syncStatus } from '../../services/sync'

export function SettingsView({ embedded = false, onOpenDownloads }: { embedded?: boolean; onOpenDownloads?: () => void }) {
  const theme = useThemeStore(state => state.theme), setTheme = useThemeStore(state => state.setTheme)
  const autoResume = usePlayerStore(state => state.autoResume), setAutoResume = usePlayerStore(state => state.setAutoResume)
  const [downloadDirectory, setDownloadDirectory] = useState('')
  const [loading, setLoading] = useState(true), [error, setError] = useState('')
  const sync = useQuery({ queryKey:['sync-status'], queryFn:syncStatus, enabled:inDesktopShell, retry:false })
  useEffect(() => {
    if (!inDesktopShell) { setLoading(false); return }
    void getDownloadDirectory().then(setDownloadDirectory).catch(cause => setError(commandErrorMessage(cause))).finally(() => setLoading(false))
  }, [])
  const chooseDirectory = async () => {
    setError('')
    try { const selected = await chooseDownloadDirectory(); if (selected) setDownloadDirectory(selected) }
    catch (cause) { setError(commandErrorMessage(cause)) }
  }
  return <section className="settings-view settings-organized">
    {!embedded && <header><h2>设置</h2><p>让音乐按你的习惯播放。</p></header>}
    <section className="settings-group" aria-labelledby="settings-appearance"><h3 id="settings-appearance">外观</h3><div className="settings-group-body">
      <div className="settings-card"><div className="settings-icon"><Sun/></div><div><strong>主题</strong><small>选择你喜欢的明暗</small></div><div className="theme-options"><button className={theme === 'dark' ? 'selected' : ''} aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>深色</button><button className={theme === 'light' ? 'selected' : ''} aria-pressed={theme === 'light'} onClick={() => setTheme('light')}>浅色</button></div></div>
    </div></section>
    <section className="settings-group" aria-labelledby="settings-playback"><h3 id="settings-playback">播放与歌词</h3><div className="settings-group-body">
      <div className="settings-card"><div className="settings-icon"><History/></div><div><strong id="auto-resume-label">断点续播</strong><small>从上次听到的位置继续</small></div><button type="button" className="auto-resume-switch" role="switch" aria-checked={autoResume} aria-labelledby="auto-resume-label" onClick={() => setAutoResume(!autoResume)}><span aria-hidden="true"/></button></div>
      {!isIOS && !isOHOS && <FloatingLyricsSettings/>}
      {!isMobile && <ShortcutSettings/>}
    </div></section>
    <section className="settings-group" aria-labelledby="settings-library"><h3 id="settings-library">音乐资料</h3><div className="settings-group-body">
      <SettingsDisclosure icon={<Cloud/>} title="云同步" description={sync.data?.config.enabled ? `${sync.data.config.provider === 'cloud' ? 'BiliMusic 云' : '坚果云'} · 已开启` : sync.data?.config.initialized ? '已暂停' : '在不同设备间同步音乐资料与听歌统计'}><SyncSettings embedded/></SettingsDisclosure>
      <SettingsDisclosure icon={<HardDrive/>} title="播放缓存" description="管理缓存容量，清理已听片段"><PlaybackCacheSettings embedded/></SettingsDisclosure>
      <div className="settings-card"><div className="settings-icon"><Download/></div><div><strong>{isMobile ? '已下载音乐' : '下载目录'}</strong><small>{!inDesktopShell ? '在客户端中管理本地文件' : isMobile ? '保存在这台设备中' : loading ? '正在读取…' : downloadDirectory || '下载时选择保存位置'}</small></div><button onClick={isMobile ? onOpenDownloads : () => void chooseDirectory()} disabled={loading || !inDesktopShell}>{loading ? <LoaderCircle className="spin"/> : <FolderOpen/>}{isMobile ? '查看' : '更改'}</button></div>
      {error && <p className="settings-error" role="alert">{error}</p>}
    </div></section>
    <section className="settings-group" aria-labelledby="settings-about"><h3 id="settings-about">关于 BiliMusic</h3><div className="settings-group-body"><UpdateSettings/></div></section>
  </section>
}
