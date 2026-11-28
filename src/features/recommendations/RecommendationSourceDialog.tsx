import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, ChevronRight, LoaderCircle, LogIn, Pencil, Plus, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { isMobile } from '../../services/platform'
import { commandErrorMessage } from '../../services/userErrors'
import { RECOMMENDATION_SOURCE_NAME_MAX, isNeteaseLoginCancelled, qrLoginFailureState, recommendationSourceAccount, validateRecommendationSourceName, type RecommendationSource } from '../../domain/recommendation'
import {
  cancelNeteaseQr,
  cancelNeteaseWebLogin,
  clearRecommendationData,
  generateNeteaseQr,
  pollNeteaseQr,
  recommendationQueryKey,
  removeRecommendationSource,
  renameRecommendationSource,
  webLoginNetease,
  type NeteaseQrGenerate,
} from '../../services/recommendations'

type Props = {
  sources: RecommendationSource[]
  selectedId?: string
  /** `add` opens the provider picker directly, for callers with no list behind it. */
  initialView?: 'list' | 'login' | 'add'
  onSelect: (sourceId: string) => void
  onClose: () => void
}

/** Source management keeps its own QR view so the main page never blocks on login. */
export function RecommendationSourceDialog({ sources, selectedId, initialView = 'list', onSelect, onClose }: Props) {
  const client = useQueryClient()
  const [view, setView] = useState<'list' | 'login'>(initialView === 'login' ? 'login' : 'list')
  // The picker stacks over the list so the user can still see which sources
  // exist; `providers` only lists implemented sources.
  const [picker, setPicker] = useState<'providers' | 'login' | null>(initialView === 'add' ? 'providers' : null)
  const [renaming, setRenaming] = useState<string>()
  const [name, setName] = useState('')
  const [removing, setRemoving] = useState<string>()
  const [clearing, setClearing] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  const invalidate = () => {
    void client.invalidateQueries({ queryKey: recommendationQueryKey.sources })
    void client.invalidateQueries({ queryKey: ['recommendations', 'daily'] })
  }

  const rename = useMutation({
    mutationFn: (source: RecommendationSource) => renameRecommendationSource(source.id, name, source.revision),
    onSuccess: updated => {
      setRenaming(undefined)
      setNotice(`已重命名为「${updated.name}」`)
      invalidate()
    },
    onError: cause => setError(commandErrorMessage(cause)),
  })
  const remove = useMutation({
    mutationFn: (source: RecommendationSource) => removeRecommendationSource(source.id, source.revision),
    onSuccess: (_, source) => {
      setRemoving(undefined)
      setNotice('推荐源已移除，本机上的推荐缓存已一并删除')
      if (selectedId === source.id) {
        const next = sources.find(item => item.id !== source.id)
        onSelect(next?.id ?? '')
      }
      invalidate()
    },
    onError: cause => setError(commandErrorMessage(cause)),
  })
  const clear = useMutation({
    mutationFn: clearRecommendationData,
    onSuccess: () => {
      setClearing(false)
      setNotice('已清除全部推荐源与登录凭据')
      onSelect('')
      invalidate()
    },
    onError: cause => setError(commandErrorMessage(cause)),
  })

  const startRename = (source: RecommendationSource) => {
    setRenaming(source.id)
    setName(source.name)
    setError('')
    setNotice('')
  }
  const submitRename = () => {
    if (!renaming) return
    const message = validateRecommendationSourceName(name)
    if (message) { setError(message); return }
    const source = sources.find(item => item.id === renaming)
    if (source) rename.mutate(source)
  }
  const removeSource = (source: RecommendationSource) => {
    remove.mutate(source)
  }
  const openPicker = () => {
    setPicker('providers')
    setError('')
    setNotice('')
  }
  // With `initialView="add"` the picker is the whole flow; there is no list to
  // fall back to, so closing it closes the dialog.
  const standalonePicker = initialView === 'add'
  const closePicker = () => {
    if (standalonePicker) onClose()
    else setPicker(null)
  }
  // The login view stacks over whatever opened it instead of replacing it, so
  // the picker or the list stays mounted underneath and closing login returns
  // to it without the modal disappearing first.
  const loginFromPicker = picker === 'login'
  const loginOpen = loginFromPicker || view === 'login'
  const closeLogin = () => {
    if (loginFromPicker) setPicker('providers')
    else setView('list')
  }
  const authorized = (source: RecommendationSource) => {
    invalidate()
    onSelect(source.id)
    if (loginFromPicker && standalonePicker) { onClose(); return }
    if (loginFromPicker) setPicker(null)
    else setView('list')
    setNotice(`已添加「${source.name}」，可以关闭窗口开始匹配`)
  }

  return <>
    {!standalonePicker && <CollectionDialog title="推荐源设置" mobileSheet className="recommendation-dialog" onClose={onClose}>
      <div className="recommendation-dialog-body">
        {sources.length === 0
          ? <button type="button" className="recommendation-source-dropzone" onClick={openPicker} data-dialog-autofocus>
            <Plus size={20} aria-hidden />
            <span>推荐源</span>
          </button>
          : <ul className="recommendation-source-rows">
            {sources.map(source => {
              const account = recommendationSourceAccount(source)
              return <li key={source.id} data-active={source.id === selectedId || undefined}>
                <div className="recommendation-source-copy">
                  {renaming === source.id
                    ? <form className="recommendation-rename" onSubmit={event => { event.preventDefault(); submitRename() }}>
                      <input autoFocus aria-label="推荐源名称" maxLength={RECOMMENDATION_SOURCE_NAME_MAX} value={name} onChange={event => setName(event.target.value)} />
                      <button type="submit" aria-label="保存名称" disabled={rename.isPending}><Check size={15} /></button>
                      <button type="button" aria-label="取消重命名" onClick={() => setRenaming(undefined)}><X size={15} /></button>
                    </form>
                    : <><strong>{source.name}</strong>{account && <small>{account}</small>}</>}
                  <span className="recommendation-source-state" data-state={source.lastRefreshState}>{refreshLabel(source)}</span>
                </div>
                {removing === source.id
                  ? <div className="recommendation-remove-confirm" role="group" aria-label="确认移除推荐源">
                    <span>移除后本机缓存会一起删除，确定吗？</span>
                    <button type="button" className="danger" disabled={remove.isPending} onClick={() => removeSource(source)}>移除</button>
                    <button type="button" onClick={() => setRemoving(undefined)}>取消</button>
                  </div>
                  : <div className="recommendation-source-actions">
                    <button type="button" onClick={() => startRename(source)} disabled={rename.isPending || remove.isPending}><Pencil size={14} /><span>重命名</span></button>
                    <button type="button" onClick={() => { setError(''); setNotice(''); setView('login') }} disabled={rename.isPending || remove.isPending}><LogIn size={14} /><span>重新登录</span></button>
                    <button type="button" className="danger" onClick={() => { setError(''); setNotice(''); setRemoving(source.id) }} disabled={rename.isPending || remove.isPending}><Trash2 size={14} /><span>移除</span></button>
                  </div>}
              </li>
            })}
          </ul>}
        {sources.length === 0 && <p className="recommendation-dialog-empty">添加账号后，可以在这里切换、重命名或重新登录；歌单什么时候更新、包含哪些歌曲，都由各推荐源自己决定。</p>}
        {error && <p className="recommendation-dialog-error" role="alert">{error}</p>}
        {notice && <p className="recommendation-dialog-notice" role="status">{notice}</p>}
        {sources.length > 0 && <div className="recommendation-dialog-footer">
          {clearing
            ? <div className="recommendation-remove-confirm" role="group" aria-label="确认清除全部推荐数据">
              <span>清除后所有推荐源、登录凭据和缓存都会删除，确定吗？</span>
              <button type="button" className="danger" disabled={clear.isPending} onClick={() => clear.mutate()}>{clear.isPending ? '清除中…' : '清除'}</button>
              <button type="button" disabled={clear.isPending} onClick={() => setClearing(false)}>取消</button>
            </div>
            : <button type="button" className="recommendation-clear" onClick={() => { setClearing(true); setError(''); setNotice('') }}>清除全部推荐数据</button>}
          <button type="button" className="recommendation-primary" onClick={openPicker}>
            <Plus size={15} />添加推荐源
          </button>
        </div>}
      </div>
    </CollectionDialog>}

    {picker !== null && <CollectionDialog title="添加推荐源" mobileSheet stacked={!standalonePicker} className="recommendation-dialog recommendation-provider-dialog" onClose={closePicker}>
      <div className="recommendation-dialog-body">
        <p className="recommendation-dialog-empty">选择一个推荐源，登录后即可读取它的每日推荐，并匹配到 B 站视频。</p>
        <button type="button" className="recommendation-provider" onClick={() => setPicker('login')} data-dialog-autofocus>
          <img className="recommendation-provider-mark" src="/netease-music.png" alt="" width={40} height={40} />
          <span>
            <strong>网易云音乐</strong>
            <small>每天 6:00 更新「每日推荐」</small>
          </span>
          <ChevronRight size={18} aria-hidden />
        </button>
        <div className="recommendation-dialog-footer">
          <button type="button" onClick={closePicker}>关闭</button>
        </div>
      </div>
    </CollectionDialog>}

    {loginOpen && <CollectionDialog title="添加网易云音乐推荐源" mobileSheet stacked className="recommendation-dialog" onClose={closeLogin}>
      <NeteaseLogin onAuthorized={authorized} onCancel={closeLogin} />
    </CollectionDialog>}
  </>
}


function refreshLabel(source: RecommendationSource) {
  switch (source.lastRefreshState) {
    case 'ready': return '已同步'
    case 'refreshing': return '同步中'
    case 'auth-required': return '需要重新登录'
    case 'error': return '上次同步失败'
    default: return '等待同步'
  }
}

function NeteaseLogin({ onAuthorized, onCancel }: {
  onAuthorized: (source: RecommendationSource) => void
  onCancel: () => void
}) {
  const [mode, setMode] = useState<'qr' | 'web'>(isMobile ? 'qr' : 'web')
  const [accepted, setAccepted] = useState(false)
  const [state, setState] = useState<'idle' | 'opening' | 'waiting' | 'error'>('idle')
  const [status, setStatus] = useState('')
  const alive = useRef(true)
  const pending = useRef(false)

  useEffect(() => {
    // StrictMode mounts, unmounts and remounts in development; restore the
    // flag so a successful login after the remount is still delivered.
    alive.current = true
    return () => {
      alive.current = false
      // Closing the dialog must not leave a login window waiting in the
      // background with a live session.
      if (pending.current) void cancelNeteaseWebLogin().catch(() => {})
    }
  }, [])

  const begin = async () => {
    // A double click must not send a second command that would answer
    // `netease_login_in_progress` and clear `pending` for the first attempt.
    if (pending.current || !accepted) return
    setMode('web')
    setState('opening')
    setStatus('正在打开网易云登录页…')
    pending.current = true
    // The command resolves only after login, so switch the copy once the
    // window has had time to appear instead of leaving it on "opening".
    const opened = window.setTimeout(() => {
      if (!alive.current || !pending.current) return
      setState('waiting')
      setStatus('请在网易云登录页完成登录')
    }, 1200)
    try {
      const source = await webLoginNetease(true)
      pending.current = false
      if (!alive.current) return
      onAuthorized(source)
    } catch (cause) {
      pending.current = false
      if (!alive.current) return
      if (isNeteaseLoginCancelled(cause)) {
        setState('idle')
        setStatus('已取消登录')
        return
      }
      setState('error')
      setStatus(commandErrorMessage(cause))
    } finally {
      window.clearTimeout(opened)
    }
  }

  const useQr = () => {
    setStatus('')
    setState('idle')
    setMode('qr')
  }

  if (mode === 'qr') {
    return <NeteaseQrLogin accepted={accepted} onAccept={setAccepted} onUseWeb={() => setMode('web')}
      onVerify={() => void begin()} onAuthorized={onAuthorized} onCancel={onCancel} />
  }

  if (state === 'idle') {
    return <div className="recommendation-qr">
      <div className="recommendation-qr-intro">
        <span className="eyebrow coral">NETEASE CLOUD MUSIC</span>
        <h4>在应用内登录网易云音乐</h4>
        <p>在网易云官方页面登录，按页面提示完成验证后会自动返回。</p>
      </div>
      <div className="recommendation-terms">
        <p><strong>请先确认风险</strong></p>
        <ul>
          <li>每日推荐使用网易云非官方接口，可能不符合其服务条款。</li>
          <li>第三方登录与高频请求在极端情况下可能导致账号被限制。</li>
          <li>登录状态保存在本机，用于读取每日推荐。</li>
        </ul>
        <label>
          <input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} />
          <span>我已了解上述风险，并愿意继续使用自己的网易云账号登录</span>
        </label>
      </div>
      {status && <p className="recommendation-qr-status" role="status">{status}</p>}
      {isMobile && <button type="button" className="recommendation-switch-login" onClick={useQr}>改用扫码登录</button>}
      <div className="recommendation-dialog-footer">
        <button type="button" onClick={onCancel}>取消</button>
        <button type="button" className="recommendation-primary" disabled={!accepted} onClick={() => void begin()}>
          同意并打开登录页
        </button>
      </div>
    </div>
  }

  if (state === 'error') {
    return <div className="recommendation-qr">
      <div className="recommendation-qr-frame" data-state="error">
        <span className="recommendation-qr-placeholder"><X size={26} /></span>
      </div>
      <p className="recommendation-qr-status" data-state="error" role="alert">{status}</p>
      {isMobile && <button type="button" className="recommendation-switch-login" onClick={useQr}>改用扫码登录</button>}
      <div className="recommendation-dialog-footer">
        <button type="button" onClick={onCancel}>取消</button>
        <button type="button" className="recommendation-primary" onClick={() => void begin()}><RefreshCw size={15} />重试</button>
      </div>
    </div>
  }

  return <div className="recommendation-qr">
    <div className="recommendation-qr-frame" data-state={state === 'opening' ? 'loading' : 'waiting'}>
      <span className="recommendation-qr-placeholder"><LoaderCircle size={26} className="spin" /></span>
    </div>
    <p className="recommendation-qr-status" data-state={state} role="status">{status}</p>
    <div className="recommendation-dialog-footer">
      <button type="button" onClick={onCancel}>取消登录</button>
    </div>
  </div>
}

function NeteaseQrLogin({ accepted, onAccept, onUseWeb, onVerify, onAuthorized, onCancel }: {
  accepted: boolean
  onAccept: (accepted: boolean) => void
  onUseWeb: () => void
  onVerify: () => void
  onAuthorized: (source: RecommendationSource) => void
  onCancel: () => void
}) {
  const [started, setStarted] = useState(false)
  const [qr, setQr] = useState<NeteaseQrGenerate>()
  const [state, setState] = useState<'idle' | 'loading' | 'waiting' | 'scanned' | 'retrying' | 'expired' | 'error' | 'verify'>('idle')
  const [status, setStatus] = useState('')
  const [nonce, setNonce] = useState(0)
  const authorized = useRef(false)
  const authorizedHandler = useRef(onAuthorized)
  authorizedHandler.current = onAuthorized

  useEffect(() => {
    if (!started) return
    let cancelled = false
    let timer = 0
    let attemptId: string | undefined
    setQr(undefined)
    setState('loading')
    setStatus('正在生成二维码…')
    authorized.current = false
    const fail = (cause: unknown, polling = false) => {
      const next = qrLoginFailureState(cause, polling)
      setState(next)
      setStatus(commandErrorMessage(cause))
      return next
    }
    const begin = async () => {
      try {
        const generated = await generateNeteaseQr(true)
        if (cancelled) { void cancelNeteaseQr(generated.attemptId); return }
        attemptId = generated.attemptId
        setQr(generated); setState('waiting'); setStatus('请使用网易云音乐 App 扫码')
        const poll = async () => {
          try {
            const result = await pollNeteaseQr(generated.attemptId, true)
            if (cancelled) return
            if (result.status === 'authorized' && result.source) {
              authorized.current = true
              setState('waiting')
              setStatus('登录成功')
              authorizedHandler.current(result.source)
              return
            }
            if (result.status === 'expired') { setState('expired'); setStatus('二维码已过期，请重新生成'); return }
            setState(result.status === 'scanned' ? 'scanned' : 'waiting')
            setStatus(result.status === 'scanned' ? '已扫码，请在手机上确认' : '等待扫码')
            timer = window.setTimeout(poll, 1800)
          } catch (cause) {
            if (cancelled) return
            // Terminal failures (unknown attempt, account-safety gate) end the
            // attempt; transient ones keep polling and the QR stays valid.
            if (fail(cause, true) === 'retrying') timer = window.setTimeout(poll, 3000)
          }
        }
        timer = window.setTimeout(poll, 1000)
      } catch (cause) {
        if (cancelled) return
        fail(cause)
      }
    }
    void begin()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      if (attemptId && !authorized.current) void cancelNeteaseQr(attemptId)
    }
  }, [started, nonce])

  if (!started) {
    return <div className="recommendation-qr">
      <div className="recommendation-qr-intro">
        <span className="eyebrow coral">NETEASE CLOUD MUSIC</span>
        <h4>用网易云音乐扫码登录</h4>
        <p>网易云音乐每天 6:00（北京时间）更新「每日推荐」；扫码登录后只读取这份歌单，播放仍然通过 B 站完成，不会播放或下载网易云音频。</p>
      </div>
      <div className="recommendation-terms">
        <p><strong>请先确认风险</strong></p>
        <ul>
          <li>每日推荐使用网易云非官方接口，可能不符合其服务条款。</li>
          <li>第三方登录与高频请求在极端情况下可能导致账号被限制。</li>
          <li>登录凭据（MUSIC_U）仅保存在本机设备数据库，不会上传或同步。</li>
        </ul>
        <label>
          <input type="checkbox" checked={accepted} onChange={event => onAccept(event.target.checked)} />
          <span>我已了解上述风险，并愿意继续使用自己的网易云账号登录</span>
        </label>
      </div>
      <button type="button" className="recommendation-switch-login" onClick={onUseWeb}>使用网页登录</button>
      <div className="recommendation-dialog-footer">
        <button type="button" onClick={onCancel}>取消</button>
        <button type="button" className="recommendation-primary" disabled={!accepted} onClick={() => setStarted(true)}>同意并生成二维码</button>
      </div>
    </div>
  }

  if (state === 'verify') {
    return <div className="recommendation-qr recommendation-verification">
      <div className="recommendation-verification-notice" role="status">
        <ShieldCheck size={21} aria-hidden />
        <strong>请在网易云完成安全验证</strong>
      </div>
      <div className="recommendation-dialog-footer">
        <button type="button" onClick={onCancel}>取消</button>
        <button type="button" className="recommendation-primary" onClick={onVerify}><LogIn size={15} />前往网易云验证</button>
      </div>
    </div>
  }

  if (state === 'error') {
    return <div className="recommendation-qr recommendation-verification">
      <div className="recommendation-verification-notice" data-state="error" role="alert">
        <X size={21} aria-hidden />
        <strong>{status}</strong>
      </div>
      <div className="recommendation-dialog-footer">
        <button type="button" onClick={onCancel}>取消</button>
        <button type="button" onClick={() => setNonce(value => value + 1)}><RefreshCw size={15} />重新生成</button>
        <button type="button" className="recommendation-primary" onClick={onVerify}><LogIn size={15} />使用网页登录</button>
      </div>
    </div>
  }

  return <div className="recommendation-qr">
    <div className="recommendation-qr-frame" data-state={state}>
      {qr
        ? <QRCodeSVG value={qr.qrUrl} size={196} level="M" marginSize={2} role="img" aria-label="网易云音乐登录二维码" />
        : <span className="recommendation-qr-placeholder"><LoaderCircle size={26} className="spin" /></span>}
      {state === 'expired' && <div className="recommendation-qr-overlay">
        <button type="button" className="recommendation-primary" onClick={() => setNonce(value => value + 1)}>
          <RefreshCw size={15} />刷新二维码
        </button>
      </div>}
    </div>
    <p className="recommendation-qr-status" data-state={state} role="status">{status || '正在生成二维码…'}</p>
    {state !== 'expired' && <small className="recommendation-qr-tip">在网易云音乐 App 中打开「扫一扫」，扫码后在手机上确认登录。</small>}
    <div className="recommendation-dialog-footer">
      <button type="button" onClick={onCancel}>取消</button>
      <button type="button" onClick={state === 'expired' ? onVerify : onUseWeb}>使用网页登录</button>
    </div>
  </div>
}
