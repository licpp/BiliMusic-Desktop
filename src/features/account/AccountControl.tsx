import { useQuery, useQueryClient } from '@tanstack/react-query'
import { LoaderCircle, LogOut, QrCode, X } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { useEffect, useState } from 'react'
import { commandErrorMessage, generateLoginQr, getAccountProfile, inDesktopShell, logoutBilibili, pollLoginQr, type QrLogin } from '../../services/desktopApi'

export function AccountControl() {
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
        const login = await generateLoginQr()
        if (cancelled) return
        setQr(login); setStatus('请使用哔哩哔哩客户端扫码')
        const poll = async () => {
          try {
            const result = await pollLoginQr(login.key)
            if (cancelled) return
            if (result.status === 'authenticated') { setStatus('登录成功'); await client.invalidateQueries({ queryKey: ['account'] }); setOpen(false); return }
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

  const logout = async () => { await logoutBilibili(); await client.invalidateQueries({ queryKey: ['account'] }); setOpen(false) }
  return <><button type="button" className="avatar" onClick={() => setOpen(true)}>{profile.data?.avatarUrl ? <img src={profile.data.avatarUrl} alt="" /> : profile.data?.name?.slice(0, 1) || '山'}</button>{open && <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}><div className="account-dialog"><header><div><span className="eyebrow">BILIBILI</span><h3>{profile.data?.loggedIn ? '账号信息' : '扫码登录'}</h3></div><button onClick={() => setOpen(false)}><X /></button></header>{profile.data?.loggedIn ? <div className="account-profile">{profile.data.avatarUrl && <img src={profile.data.avatarUrl} alt="" />}<strong>{profile.data.name}</strong><small>UID {profile.data.userId}</small><button onClick={() => void logout()}><LogOut />退出登录</button></div> : inDesktopShell ? <div className="qr-login">{qr ? <QRCodeSVG value={qr.url} size={190} level="M" marginSize={2} /> : <span><LoaderCircle className="spin" /></span>}<p>{status || '正在生成二维码'}</p><small>登录仅用于评论、点赞等需要账号的操作。</small></div> : <div className="qr-login"><QrCode /><p>请在桌面应用中登录</p></div>}</div></div>}</>
}
