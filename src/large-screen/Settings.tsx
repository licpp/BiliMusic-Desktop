import { ExtensionSettingsEntry } from '../features/settings/ExtensionsSettings'
import { LoudnessSettings } from '../features/settings/LoudnessSettings'
import { SystemTitleLyricsSettings } from '../features/settings/SystemTitleLyricsSettings'
import { accountQueryKey, accountQueryFilter, resetAccountQueries } from '../services/queryKeys'
import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { Cloud, HardDrive, LogOut, Moon, QrCode, Sun, UserRound } from 'lucide-react'
import { commandErrorMessage, generateLoginQr, getAccountProfile, inDesktopShell, logoutBilibili, pollLoginQr } from '../services/desktopApi'
import type { QrLogin } from '../domain/account'
import { resetPlayerForAccount } from '../features/player/playerStore'
import { DiagnosticsSettings } from '../features/settings/DiagnosticsSettings'
import { FeedbackSettings } from '../features/settings/FeedbackSettings'
import { UpdateSettings } from '../features/settings/UpdateSettings'
import { ResumeSettings } from '../features/settings/ResumeSettings'
import { PlaybackCacheSettings } from '../features/settings/PlaybackCacheSettings'
import { SyncSettings } from '../features/sync/SyncSettings'
import { systemThemeSupported, useThemeStore } from '../services/theme'
import { ThemeSystemIcon } from '../shared/ThemeSystemIcon'
import { useSyncAttention } from '../services/syncAttention'
import { LargeDialog } from './LargeDialog'
import { Failure } from './Library'

export function LargeSettings({ onOpenExtensions }: { onOpenExtensions: () => void }) {
  const themePreference = useThemeStore(s => s.preference), setTheme = useThemeStore(s => s.setTheme), followsSystem = systemThemeSupported()
  const attention = useSyncAttention(s => s.library || s.statistics)
  const [size, setSize] = useState(() => Number(localStorage.getItem('large-ui-size')) || 1)
  const [lyrics, setLyrics] = useState(() => Number(localStorage.getItem('large-lyrics-size')) || 1)
  const [awake, setAwake] = useState(() => localStorage.getItem('large-keep-awake') === 'true')
  const [accountOpenRequest, requestAccountOpen] = useState(0)
  return <><LargeAccount openRequest={accountOpenRequest}/><ExtensionSettingsEntry onOpen={onOpenExtensions}/><div className="large-settings-common"><UpdateSettings large/><DiagnosticsSettings large/><FeedbackSettings large onLogin={() => requestAccountOpen(value => value + 1)}/></div>
    <details className="large-disclosure" open={attention ? true : undefined}><summary><Cloud/><span><strong>云同步</strong><small>{attention || '在不同设备间同步音乐库与听歌记录'}</small></span></summary><SyncSettings embedded/></details>
    <div className="large-settings-common"><ResumeSettings/><LoudnessSettings/><SystemTitleLyricsSettings/></div>
    <details className="large-disclosure"><summary><HardDrive/><span><strong>播放缓存</strong><small>容量与已用空间</small></span></summary><PlaybackCacheSettings embedded/></details>
    <section className="large-setting-section large-surface"><h2>外观与显示</h2><div className="large-setting-row"><span>主题</span><div className="large-options"><button aria-pressed={themePreference === 'light'} onClick={() => setTheme('light')}><Sun/>明亮</button><button aria-pressed={themePreference === 'dark'} onClick={() => setTheme('dark')}><Moon/>深色</button>{followsSystem && <button aria-pressed={themePreference === 'system'} onClick={() => setTheme('system')}><ThemeSystemIcon/>跟随系统</button>}</div></div>
      <div className="large-setting-row"><span>界面大小</span><div className="large-options">{[0.9, 1, 1.15].map((value, i) => <button key={value} aria-pressed={size === value} onClick={() => { setSize(value); localStorage.setItem('large-ui-size', String(value)); document.documentElement.style.setProperty('--large-scale', String(value)) }}>{['紧凑', '标准', '较大'][i]}</button>)}</div></div>
      <div className="large-setting-row"><span>歌词字号</span><div className="large-options">{[0.85, 1, 1.2].map((value, i) => <button key={value} aria-pressed={lyrics === value} onClick={() => { setLyrics(value); localStorage.setItem('large-lyrics-size', String(value)); document.documentElement.style.setProperty('--large-lyric-scale', String(value)) }}>{['小', '标准', '大'][i]}</button>)}</div></div>
      <button className="large-setting-toggle" aria-pressed={awake} onClick={() => { const next = !awake; setAwake(next); localStorage.setItem('large-keep-awake', String(next)); window.dispatchEvent(new Event('bilimusic-display-changed')) }}><Sun/><span>播放页面保持亮屏</span><small>{awake ? '已开启' : '未开启'}</small></button>
    </section></>
}

function LargeAccount({ openRequest }: { openRequest: number }) {
  const client = useQueryClient(), profile = useQuery({ queryKey: accountQueryKey('account'), queryFn: getAccountProfile, retry: false })
  const [open, setOpen] = useState(false), [qr, setQr] = useState<QrLogin>(), [revision, setRevision] = useState(0), [message, setMessage] = useState(''), [busy, setBusy] = useState(false)
  const refetchProfile = profile.refetch
  useEffect(() => {
    if (!openRequest) return
    setMessage('')
    setOpen(true)
    void refetchProfile()
  }, [openRequest, refetchProfile])
  useEffect(() => {
    if (!open || profile.data?.loggedIn || !inDesktopShell) return
    let cancelled = false, timer = 0
    setQr(undefined); setMessage('正在生成二维码…')
    void generateLoginQr().then(login => {
      if (cancelled) return
      setQr(login); setMessage('请使用哔哩哔哩客户端扫码')
      const poll = async () => {
        try {
          const status = await pollLoginQr(login.key)
          if (status.status === 'authenticated') {
            await resetPlayerForAccount(); await client.cancelQueries(accountQueryFilter); await resetAccountQueries(client)
            window.dispatchEvent(new Event('bilimusic-account-changed')); window.dispatchEvent(new Event('bilimusic-sync-configured'))
            if (!cancelled) setOpen(false)
            return
          }
          if (cancelled) return
          setMessage(status.message || (status.status === 'confirmed' ? '已扫码，请在手机上确认' : '等待扫码'))
          if (status.status === 'expired' || status.status === 'error') return
        } catch (e) { if (!cancelled) setMessage(commandErrorMessage(e)) }
        if (!cancelled) timer = window.setTimeout(poll, 2000)
      }
      timer = window.setTimeout(poll, 1200)
    }).catch(e => { if (!cancelled) setMessage(commandErrorMessage(e)) })
    return () => { cancelled = true; clearTimeout(timer) }
  }, [open, revision, profile.data?.loggedIn, client])
  const logout = async () => {
    setBusy(true)
    try { await client.cancelQueries(accountQueryFilter); await resetPlayerForAccount(); await logoutBilibili(); await resetAccountQueries(client); window.dispatchEvent(new Event('bilimusic-account-changed')); window.dispatchEvent(new Event('bilimusic-sync-configured')); setOpen(false) }
    catch (e) { setMessage(commandErrorMessage(e)) } finally { setBusy(false) }
  }
  return <><button className="large-account large-surface" data-focus="account" data-primary-focus onClick={() => { setMessage(''); setOpen(true) }}>{profile.data?.avatarUrl ? <img src={profile.data.avatarUrl} alt="" referrerPolicy="no-referrer"/> : <span><UserRound/></span>}<div><strong>{profile.data?.name || '登录 B站账号'}</strong><small>{profile.data?.loggedIn ? '账号信息' : '扫码连接你的音乐世界'}</small></div><QrCode/></button><Failure error={profile.error} retry={() => void profile.refetch()}/>
    {open && <LargeDialog title={profile.data?.loggedIn ? '账号信息' : '扫码登录'} onClose={() => setOpen(false)}>{profile.data?.loggedIn ? <div className="large-account-profile"><h2>{profile.data.name}</h2><button disabled={busy} onClick={() => void logout()}><LogOut/>退出登录</button><p role="status">{message}</p></div> : <div className="large-qr">{qr ? <QRCodeSVG value={qr.url} size={224} marginSize={3}/> : <QrCode size={80}/>}<p role="status">{message}</p><button onClick={() => setRevision(r => r + 1)}>刷新二维码</button></div>}</LargeDialog>}
  </>
}
