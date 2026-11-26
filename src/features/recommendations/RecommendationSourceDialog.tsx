import { useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, LoaderCircle, LogIn, Pencil, RefreshCw, Trash2, X } from 'lucide-react'
import { QRCodeSVG } from 'qrcode.react'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { commandErrorMessage } from '../../services/userErrors'
import { RECOMMENDATION_SOURCE_NAME_MAX, qrPollingCanRetry, validateRecommendationSourceName, type RecommendationSource } from '../../domain/recommendation'
import {
  cancelNeteaseQr,
  clearRecommendationData,
  generateNeteaseQr,
  pollNeteaseQr,
  recommendationQueryKey,
  removeRecommendationSource,
  renameRecommendationSource,
  type NeteaseQrGenerate,
} from '../../services/recommendations'

type Props = {
  sources: RecommendationSource[]
  selectedId?: string
  onSelect: (sourceId: string) => void
  onClose: () => void
}

/** Source management keeps its own QR view so the main page never blocks on login. */
export function RecommendationSourceDialog({ sources, selectedId, onSelect, onClose }: Props) {
  const client = useQueryClient()
  const [view, setView] = useState<'list' | 'login'>('list')
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

  if (view === 'login') {
    return (
      <CollectionDialog title="添加网易云推荐源" mobileSheet className="recommendation-dialog" onClose={onClose}>
        <NeteaseQrLogin
          onAuthorized={source => {
            invalidate()
            onSelect(source.id)
            setView('list')
            setNotice(`已添加「${source.name}」，可以关闭窗口开始匹配`)
          }}
          onCancel={() => setView('list')}
        />
      </CollectionDialog>
    )
  }

  return (
    <CollectionDialog title="推荐源设置" mobileSheet className="recommendation-dialog" onClose={onClose}>
      <div className="recommendation-dialog-body">
        {sources.length === 0 && <p className="recommendation-dialog-empty">还没有推荐源。添加网易云账号后，每天 6:00 会自动获取当日推荐。</p>}
        <ul className="recommendation-source-rows">
          {sources.map(source => (
            <li key={source.id} data-active={source.id === selectedId || undefined}>
              <div className="recommendation-source-copy">
                {renaming === source.id
                  ? <form className="recommendation-rename" onSubmit={event => { event.preventDefault(); submitRename() }}>
                    <input autoFocus aria-label="推荐源名称" maxLength={RECOMMENDATION_SOURCE_NAME_MAX} value={name} onChange={event => setName(event.target.value)} />
                    <button type="submit" aria-label="保存名称" disabled={rename.isPending}><Check size={15} /></button>
                    <button type="button" aria-label="取消重命名" onClick={() => setRenaming(undefined)}><X size={15} /></button>
                  </form>
                  : <><strong>{source.name}</strong><small>网易云 · {source.nickname || '未命名账号'}</small></>}
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
          ))}
        </ul>
        {error && <p className="recommendation-dialog-error" role="alert">{error}</p>}
        {notice && <p className="recommendation-dialog-notice" role="status">{notice}</p>}
        <p className="recommendation-risk">网易云推荐通过非官方接口读取，可能不符合其服务条款，极端情况下账号会被限制。登录凭据只保存在本机设备数据库，不会上传或同步。</p>
        <div className="recommendation-dialog-footer">
          {sources.length > 0 && (clearing
            ? <div className="recommendation-remove-confirm" role="group" aria-label="确认清除全部推荐数据">
              <span>清除后所有推荐源、登录凭据和缓存都会删除，确定吗？</span>
              <button type="button" className="danger" disabled={clear.isPending} onClick={() => clear.mutate()}>{clear.isPending ? '清除中…' : '清除'}</button>
              <button type="button" disabled={clear.isPending} onClick={() => setClearing(false)}>取消</button>
            </div>
            : <button type="button" className="recommendation-clear" onClick={() => { setClearing(true); setError(''); setNotice('') }}>清除全部推荐数据</button>)}
          <button type="button" className="recommendation-primary" onClick={() => { setView('login'); setError(''); setNotice('') }}>
            <RefreshCw size={15} />添加网易云推荐源
          </button>
        </div>
      </div>
    </CollectionDialog>
  )
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

function NeteaseQrLogin({ onAuthorized, onCancel }: {
  onAuthorized: (source: RecommendationSource) => void
  onCancel: () => void
}) {
  const [accepted, setAccepted] = useState(false)
  const [started, setStarted] = useState(false)
  const [qr, setQr] = useState<NeteaseQrGenerate>()
  const [state, setState] = useState<'idle' | 'loading' | 'waiting' | 'scanned' | 'retrying' | 'expired' | 'error'>('idle')
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
            const retry = qrPollingCanRetry(cause)
            setState(retry ? 'retrying' : 'error')
            setStatus(commandErrorMessage(cause))
            if (!retry) return
            timer = window.setTimeout(poll, 3000)
          }
        }
        timer = window.setTimeout(poll, 1000)
      } catch (cause) {
        if (cancelled) return
        setState('error'); setStatus(commandErrorMessage(cause))
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
        <p>登录后只读取「每日推荐」歌曲列表，播放仍然通过 B 站完成，不会播放或下载网易云音频。</p>
      </div>
      <div className="recommendation-terms">
        <p><strong>请先确认风险</strong></p>
        <ul>
          <li>每日推荐使用网易云非官方接口，可能不符合其服务条款。</li>
          <li>第三方登录与高频请求在极端情况下可能导致账号被限制。</li>
          <li>登录凭据（MUSIC_U）仅保存在本机设备数据库，不参与云同步。</li>
        </ul>
        <label>
          <input type="checkbox" checked={accepted} onChange={event => setAccepted(event.target.checked)} />
          <span>我已了解上述风险，并愿意继续使用自己的网易云账号登录</span>
        </label>
      </div>
      <div className="recommendation-dialog-footer">
        <button type="button" onClick={onCancel}>取消</button>
        <button type="button" className="recommendation-primary" disabled={!accepted} onClick={() => setStarted(true)}>同意并生成二维码</button>
      </div>
    </div>
  }

  return <div className="recommendation-qr">
    <div className="recommendation-qr-frame" data-state={state}>
      {qr && state !== 'error'
        ? <QRCodeSVG value={qr.qrUrl} size={196} level="M" marginSize={2} role="img" aria-label="网易云音乐登录二维码" />
        : state === 'error' ? <span className="recommendation-qr-placeholder"><X size={26} /></span>
          : <span className="recommendation-qr-placeholder"><LoaderCircle size={26} className="spin" /></span>}
      {state === 'expired' && <div className="recommendation-qr-overlay">
        <button type="button" className="recommendation-primary" onClick={() => setNonce(value => value + 1)}>
          <RefreshCw size={15} />刷新二维码
        </button>
      </div>}
    </div>
    <p className="recommendation-qr-status" data-state={state} role="status">{status || '正在生成二维码…'}</p>
    <small className="recommendation-qr-tip">在网易云音乐 App 中打开「扫一扫」，扫码后需要在手机上确认登录。</small>
    <div className="recommendation-dialog-footer">
      <button type="button" onClick={onCancel}>取消</button>
      {/* Expired keeps the overlay CTA; a terminal failure has no scannable code. */}
      {state === 'error' && <button type="button" className="recommendation-primary" onClick={() => setNonce(value => value + 1)}><RefreshCw size={15} />重新生成</button>}
    </div>
  </div>
}
