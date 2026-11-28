import { useOverlayDismiss } from '../../shared/useOverlayDismiss'
import { accountQueryKey, accountQueryFilter, resetAccountQueries } from '../../services/queryKeys'
import { ProfileBadges } from './ProfileBadges'
import { isMobile } from '../../services/platform'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Copy, LoaderCircle, LogOut, QrCode, RefreshCw, UserRound, X } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { resetPlayerForAccount } from '../player/playerStore'
import { useEffect, useRef, useState } from 'react'
import { commandErrorMessage, generateLoginQr, getAccountProfile, inDesktopShell, logoutBilibili, pollLoginQr } from '../../services/desktopApi'
import { resolveVipBadge, type QrLogin } from '../../domain/account'

export function AccountControl({ expanded = false, openRequest = 0 }: { expanded?: boolean; openRequest?: number }) {
  const client = useQueryClient()
  const profile = useQuery({ queryKey: accountQueryKey('account'), queryFn: getAccountProfile, retry: false })
  const [open, setOpen] = useState(false)
  const dialog = useRef<HTMLDivElement>(null)
  useOverlayDismiss(dialog, open, () => setOpen(false))
  const [qr, setQr] = useState<QrLogin | null>(null)
  const [qrNonce, setQrNonce] = useState(0)
  const [qrState, setQrState] = useState<'loading' | 'waiting' | 'confirmed' | 'expired' | 'error'>('loading')
  const [status, setStatus] = useState('')
  const [copied, setCopied] = useState(false)

  const refetchProfile = profile.refetch
  useEffect(() => {
    if (!openRequest) return
    setOpen(true)
    void refetchProfile()
  }, [openRequest, refetchProfile])

  useEffect(() => {
    if (!open || profile.data?.loggedIn || !inDesktopShell) return
    let cancelled = false
    let timer = 0
    setQr(null)
    setQrState('loading')
    setStatus('正在生成二维码…')
    setCopied(false)
    const begin = async () => {
      try {
        const login = await generateLoginQr()
        if (cancelled) return
        setQr(login); setQrState('waiting'); setStatus('请使用哔哩哔哩客户端扫码')
        const poll = async () => {
          try {
            const result = await pollLoginQr(login.key)
            if (result.status === 'authenticated') {
              // The native command has switched the library even if the dialog was closed during this poll.
              if (!cancelled) setOpen(false)
              await resetPlayerForAccount()
              await client.cancelQueries(accountQueryFilter)
              await resetAccountQueries(client)
              window.dispatchEvent(new Event('bilimusic-account-changed'))
              window.dispatchEvent(new Event('bilimusic-sync-configured'))
              return
            }
            if (cancelled) return
            if (result.status === 'expired') { setQrState('expired'); setStatus('二维码已过期，请刷新重试'); return }
            setQrState(result.status === 'confirmed' ? 'confirmed' : 'waiting')
            setStatus(result.status === 'confirmed' ? '已扫码，请在手机上确认' : '等待扫码')
            timer = window.setTimeout(poll, 1800)
          } catch (cause) { if (!cancelled) { setQrState('error'); setStatus(commandErrorMessage(cause)); timer = window.setTimeout(poll, 3000) } }
        }
        timer = window.setTimeout(poll, 1000)
      } catch (cause) { if (!cancelled) { setQrState('error'); setStatus(commandErrorMessage(cause)) } }
    }
    void begin()
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [open, profile.data?.loggedIn, client, qrNonce])

  const openAccount = () => {
    setQr(null)
    setStatus('')
    setCopied(false)
    setOpen(true)
  }
  const [loggingOut, setLoggingOut] = useState(false)
  const logout = async () => {
    if (loggingOut) return
    setLoggingOut(true)
    try {
      await client.cancelQueries(accountQueryFilter)
      await resetPlayerForAccount()
      await logoutBilibili()
      await client.cancelQueries(accountQueryFilter)
      await resetAccountQueries(client)
      window.dispatchEvent(new Event('bilimusic-sync-configured'))
      setOpen(false)
    } catch (cause) { setStatus(commandErrorMessage(cause)) }
    finally { window.dispatchEvent(new Event('bilimusic-account-changed')); setLoggingOut(false) }
  }
  const copyLoginUrl = () => {
    if (!qr) return
    void navigator.clipboard.writeText(qr.url).then(() => {
      setCopied(true)
      setStatus('已复制登录链接，可在其他设备打开二维码扫码')
      window.setTimeout(() => setCopied(false), 2200)
    }).catch(() => setStatus('无法复制，请使用另一台设备扫码'))
  }
  const account = profile.data
  const loggedIn = account?.loggedIn
  const vipBadge = resolveVipBadge(account)
  const badges = loggedIn && <ProfileBadges level={account?.level} seniorMember={account?.seniorMember} vipActive={account?.vipActive} vipType={account?.vipType} vipTheme={account?.vipTheme} vipLabel={account?.vipLabel}/>
  return <><button type="button" className={expanded ? "account-entry" : "avatar"} title={profile.data?.loggedIn ? '查看账号信息' : '登录 B 站账号'} aria-label={profile.data?.loggedIn ? '查看账号信息' : '登录 B 站账号'} onClick={openAccount}><span className={expanded ? `account-entry-avatar${vipBadge ? ' vip-avatar' : ''}` : undefined} data-vip-tier={vipBadge?.tier}>{profile.data?.avatarUrl ? <img src={profile.data.avatarUrl} alt="" referrerPolicy="no-referrer" /> : <UserRound size={expanded ? 28 : 18} />}</span>{expanded && <span><strong>{profile.data?.loggedIn ? profile.data.name : '登录 B站账号'}</strong><small>{loggedIn ? `UID ${account?.userId}` : '导入收藏夹与同步自己的音乐资料'}</small>{badges}</span>}</button>{open && <div ref={dialog} className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOpen(false)}><div className="account-dialog" role="dialog" aria-modal="true" aria-label={profile.data?.loggedIn ? '账号信息' : '扫码登录'}><header><div><span className="eyebrow">BILIBILI</span><h3>{profile.data?.loggedIn ? '账号信息' : '扫码登录'}</h3></div><button type="button" className="account-dialog-close" onClick={() => setOpen(false)} aria-label="关闭账号窗口"><X size={18} /></button></header>{profile.data?.loggedIn ? <div className="account-profile"><span className={`account-profile-avatar${vipBadge ? ' vip-avatar' : ''}`} data-vip-tier={vipBadge?.tier}>{account?.avatarUrl ? <img src={account.avatarUrl} alt="" referrerPolicy="no-referrer"/> : <UserRound size={30}/>}</span><strong>{account?.name}</strong><small>UID {account?.userId}</small>{badges}{status && <p className="inline-error" role="alert">{status}</p>}<button type="button" className="account-logout-button" disabled={loggingOut} onClick={() => void logout()}>{loggingOut ? <LoaderCircle size={16} className="spin"/> : <LogOut size={16} />}<span>{loggingOut ? '正在退出…' : '退出登录'}</span></button></div> : inDesktopShell ? <div className="qr-login"><div className={`qr-frame${qrState === 'expired' ? ' expired' : ''}`}>{qr ? <QRCodeSVG value={qr.url} size={188} level="M" marginSize={2} /> : <span className="qr-placeholder"><LoaderCircle size={26} className="spin" /></span>}{qrState === 'expired' && <div className="qr-expired-overlay"><button type="button" className="qr-action-button primary" onClick={() => setQrNonce(n => n + 1)}><RefreshCw size={15}/>刷新二维码</button></div>}</div><p className="qr-status-pill" data-state={qrState}>{status || '正在生成二维码…'}</p><div className="qr-login-actions">{isMobile && qr && qrState !== 'expired' && <button type="button" className="qr-action-button primary" onClick={copyLoginUrl}>{copied ? <Check size={15}/> : <Copy size={15}/>}{copied ? '已复制链接' : '复制登录链接'}</button>}{(qrState === 'expired' || qrState === 'error') && <button type="button" className="qr-action-button" onClick={() => setQrNonce(n => n + 1)}><RefreshCw size={15}/>重新生成</button>}</div>{isMobile && qr && <small className="qr-mobile-tip">也可截图二维码，在哔哩哔哩 App「扫一扫」中从相册识别登录。</small>}<small className="qr-login-note">登录用于收藏夹导入、评论与点赞。连接同步服务后，同一账号可汇总各设备的听歌统计。</small></div> : <div className="qr-login"><span className="qr-placeholder"><QrCode size={36} /></span><p className="qr-status-pill">请在桌面或移动客户端中登录</p></div>}</div></div>}</>
}
