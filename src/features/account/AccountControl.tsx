import { isAndroid } from '../../services/platform'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, LogOut, QrCode, UserRound, X } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { resetPlayerForAccount } from '../player/playerStore'
import { useEffect, useState } from 'react'
import { commandErrorMessage, generateLoginQr, getAccountProfile, inDesktopShell, logoutBilibili, pollLoginQr, type QrLogin } from '../../services/desktopApi'

export function AccountControl({ expanded = false }: { expanded?: boolean }) {
  const client = useQueryClient()
  const profile = useQuery({ queryKey: ['account'], queryFn: getAccountProfile, retry: false })
  const [open, setOpen] = useState(false)
  const [qr, setQr] = useState<QrLogin | null>(null)
  const [status, setStatus] = useState('')

  useEffect(() => {
    if (!open || profile.data?.loggedIn || !inDesktopShell) return
    let cancelled = false
    let timer = 0
    const begin = async () => {
      try {
        await resetPlayerForAccount()
        const login = await generateLoginQr()
        if (cancelled) return
        setQr(login); setStatus('请使用哔哩哔哩客户端扫码')
        const poll = async () => {
          try {
            const result = await pollLoginQr(login.key)
            if (cancelled) return
            if (result.status === 'authenticated') { setStatus('登录成功'); await client.invalidateQueries(); window.dispatchEvent(new Event('bilimusic-sync-configured')); setOpen(false); return }
            if (result.status === 'expired') { setStatus('二维码已过期，请重新打开'); return }
            setStatus(result.status === 'confirmed' ? '已扫码，请在手机上确认' : '等待扫码')
            timer = window.setTimeout(poll, 1800)
          } catch (cause) { if (!cancelled) { setStatus(commandErrorMessage(cause)); timer = window.setTimeout(poll, 3000) } }
        }
        timer = window.setTimeout(poll, 1000)
      } catch (cause) { if (!cancelled) setStatus(commandErrorMessage(cause)) }
    }
    void begin()
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [open, profile.data?.loggedIn, client])

  const logout = async () => { try { await resetPlayerForAccount(); await logoutBilibili(); await client.invalidateQueries(); client.removeQueries({ queryKey: ['bili-favorites'] }); window.dispatchEvent(new Event('bilimusic-sync-configured')); setOpen(false) } catch (cause) { setStatus(commandErrorMessage(cause)) } }
  return <><button type="button" className={expanded ? "account-entry" : "avatar"} aria-label={profile.data?.loggedIn ? '查看账号信息' : '登录 B 站账号'} onClick={() => setOpen(true)}><span className={expanded ? 'account-entry-avatar' : undefined}>{profile.data?.avatarUrl ? <img src={profile.data.avatarUrl} alt="" referrerPolicy="no-referrer" /> : <UserRound size={expanded ? 28 : 18} />}</span>{expanded && <span><strong>{profile.data?.loggedIn ? profile.data.name : '登录 B站账号'}</strong><small>{profile.data?.loggedIn ? `UID ${profile.data.userId} · 查看账号` : '导入收藏夹与同步自己的音乐资料'}</small></span>}</button>{open && <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}><div className="account-dialog"><header><div><span className="eyebrow">BILIBILI</span><h3>{profile.data?.loggedIn ? '账号信息' : '扫码登录'}</h3></div><button type="button" onClick={() => setOpen(false)} aria-label="关闭账号窗口"><X /></button></header>{profile.data?.loggedIn ? <div className="account-profile">{profile.data.avatarUrl && <img src={profile.data.avatarUrl} alt="" referrerPolicy="no-referrer" />}<strong>{profile.data.name}</strong><small>UID {profile.data.userId}</small><button type="button" onClick={() => void logout()}><LogOut />退出登录</button></div> : inDesktopShell ? <div className="qr-login">{qr ? <QRCodeSVG value={qr.url} size={190} level="M" marginSize={2} /> : <span><LoaderCircle className="spin" /></span>}<p>{status || '正在生成二维码'}</p>{isAndroid && qr && <><button type="button" onClick={() => void navigator.clipboard.writeText(qr.url).then(() => setStatus('已复制登录链接，可在其他设备打开二维码扫码')).catch(() => setStatus('无法复制，请使用另一台设备扫码'))}>复制登录链接</button><small>可截图二维码后，在 B 站扫一扫中从相册识别；是否支持取决于 B 站客户端。</small></>}<small>登录用于收藏夹导入、评论与点赞。</small></div> : <div className="qr-login"><QrCode /><p>请在桌面应用中登录</p></div>}</div></div>}</>
}
