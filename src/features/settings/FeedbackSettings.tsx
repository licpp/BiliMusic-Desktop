import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { isTauri } from '@tauri-apps/api/core'
import { ArrowRight, ArrowUpRight, Check, ChevronDown, CircleCheck, Copy, Globe, Headphones, ImagePlus, LoaderCircle, MessageSquareText, Tv, X } from 'lucide-react'
import { LargeDialog } from '../../large-screen/LargeDialog'
import { accountEpoch } from '../../services/accountScope'
import { formatDiagnosticEnvironment, readDiagnosticEnvironment, type DiagnosticEnvironment } from '../../services/diagnosticEnvironment'
import { openFeedbackLink, readFeedbackAccount, readFeedbackPolicy, sendFeedback, type FeedbackAccount, type FeedbackCategory, type FeedbackPolicy } from '../../services/feedback'
import { FEEDBACK_IMAGE_ACCEPT, FEEDBACK_IMAGE_MAX_COUNT, feedbackClipboardImages, feedbackImagePreview, readFeedbackImages, type FeedbackImage } from '../../services/feedbackImages'
import { isMobile } from '../../services/platform'
import { commandErrorMessage } from '../../services/userErrors'
import { CollectionDialog } from '../../shared/CollectionDialog'
import { copyText } from '../../shared/copyText'
import { MobilePage } from '../../shared/MobilePage'
import { currentDisplayVersion } from '../../shared/version'
import { FeedbackHistory } from './FeedbackHistory'
import './feedback-settings.css'

const categories: Record<FeedbackCategory, string> = {
  bug: '问题反馈',
  suggestion: '功能建议',
  copyright: '版权与权利',
  other: '其他',
}
type AccountView = FeedbackAccount & { epoch: number }
const supportGroup = '1132131566'

export function FeedbackSettings({ large = false, onLogin }: { large?: boolean; onLogin?: () => void }) {
  const [open, setOpen] = useState(false)
  if (!isTauri()) return null
  const onClose = () => setOpen(false)
  const title = '意见反馈'
  const form = open && <FeedbackForm onClose={onClose} onLogin={() => { onClose(); onLogin?.() }}/>
  return <>
    <section className="settings-card feedback-settings-entry" aria-label={title}>
      <div className="settings-icon"><MessageSquareText/></div>
      <div><strong>{title}</strong><small>报告问题或提出建议</small></div>
      <button type="button" onClick={() => setOpen(true)}>填写反馈</button>
    </section>
    {open && (large
      ? <LargeDialog title={title} onClose={onClose} className="feedback-dialog">{form}</LargeDialog>
      : isMobile
        ? <MobilePage title={title} onBack={onClose} className="feedback-mobile-page">{form}</MobilePage>
        : <CollectionDialog title={title} onClose={onClose} className="feedback-dialog">{form}</CollectionDialog>)}
  </>
}

function FeedbackForm({ onClose, onLogin }: { onClose: () => void; onLogin: () => void }) {
  const id = useId()
  const form = useRef<HTMLFormElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const attachmentRead = useRef<symbol | undefined>(undefined)
  const submitting = useRef(false)
  const [category, setCategory] = useState<FeedbackCategory>('bug')
  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [anonymous, setAnonymous] = useState(false)
  const [view, setView] = useState<'submit' | 'history'>('submit')
  const [email, setEmail] = useState('')
  const [contact, setContact] = useState('')
  const [account, setAccount] = useState<AccountView | null>()
  const [accountError, setAccountError] = useState(false)
  const [accountReload, setAccountReload] = useState(0)
  const [includeEnvironment, setIncludeEnvironment] = useState(true)
  const [environmentOpen, setEnvironmentOpen] = useState(false)
  const [environment, setEnvironment] = useState<DiagnosticEnvironment>()
  const [environmentError, setEnvironmentError] = useState(false)
  const [images, setImages] = useState<FeedbackImage[]>([])
  const [readingImages, setReadingImages] = useState(false)
  const [imageError, setImageError] = useState('')
  const [policy, setPolicy] = useState<FeedbackPolicy>()
  const [policyOpen, setPolicyOpen] = useState(false)
  const [policyError, setPolicyError] = useState(false)
  const [policyReload, setPolicyReload] = useState(0)
  const [consent, setConsent] = useState(false)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [receipt, setReceipt] = useState<{ id: string; anonymous: boolean }>()
  const [openInHistory, setOpenInHistory] = useState<string>()
  const [copyStatus, setCopyStatus] = useState('')
  const attachEnvironment = category === 'bug' && includeEnvironment

  useEffect(() => {
    let generation = 0
    const load = () => {
      const request = ++generation
      const epoch = accountEpoch()
      void readFeedbackAccount().then(value => {
        if (request === generation && epoch === accountEpoch()) setAccount(value ? { ...value, epoch } : null)
      }, () => {
        if (request === generation && epoch === accountEpoch()) { setAccountError(true); setAccount(null) }
      })
    }
    const reset = () => {
      generation++
      setAccount(undefined)
      setAccountError(false)
      setAnonymous(false)
      setView('submit')
      setReceipt(undefined)
      setOpenInHistory(undefined)
      setTitle('')
      setMessage('')
      setEmail('')
      setContact('')
      setImages([])
      attachmentRead.current = undefined
      setReadingImages(false)
      setImageError('')
      setConsent(false)
      setCopyStatus('')
      setError('')
    }
    const changed = () => { reset(); load() }
    load()
    window.addEventListener('bilimusic-account-changing', reset)
    window.addEventListener('bilimusic-account-changed', changed)
    return () => {
      generation++
      window.removeEventListener('bilimusic-account-changing', reset)
      window.removeEventListener('bilimusic-account-changed', changed)
    }
  }, [accountReload])

  useEffect(() => {
    if (!account) return
    let active = true
    void readFeedbackPolicy().then(value => {
      if (active) setPolicy(value)
    }, () => {
      if (active) setPolicyError(true)
    })
    return () => { active = false }
  }, [account, policyReload])

  useEffect(() => {
    if (!account || !attachEnvironment || environment) return
    let active = true
    void readDiagnosticEnvironment().then(value => {
      if (active) setEnvironment(value)
    }, () => {
      if (active) setEnvironmentError(true)
    })
    return () => { active = false }
  }, [account, attachEnvironment, environment])

  const contactRequired = category === 'copyright'
  const reloadPolicy = () => {
    setConsent(false)
    setPolicy(undefined)
    setPolicyError(false)
    setPolicyReload(value => value + 1)
  }
  const confirmAccountAgain = () => {
    setAnonymous(false)
    setConsent(false)
    setAccountError(false)
    setAccount(undefined)
    setAccountReload(value => value + 1)
  }

  const addImages = useCallback(async (files: File[]) => {
    if (!files.length || submitting.current || attachmentRead.current) return
    const request = Symbol()
    const epoch = accountEpoch()
    const currentRead = () => attachmentRead.current === request && epoch === accountEpoch()
    attachmentRead.current = request
    setReadingImages(true)
    setImageError('')
    try {
      const result = await readFeedbackImages(files, images.length)
      if (!currentRead()) return
      setImages(current => [...current, ...result.images].slice(0, FEEDBACK_IMAGE_MAX_COUNT))
      setImageError(result.errors.join('。'))
    } catch {
      if (currentRead()) setImageError('无法读取图片，请重试')
    } finally {
      if (currentRead()) {
        attachmentRead.current = undefined
        setReadingImages(false)
      }
    }
  }, [images.length])

  useEffect(() => {
    if (!account || view !== 'submit' || receipt) return
    const paste = (event: ClipboardEvent) => {
      const container = form.current?.closest('.feedback-dialog, .feedback-mobile-page')
      if (!container || event.defaultPrevented || container.getAttribute('data-closing') === 'true') return
      const target = event.target
      if (target instanceof Node && target !== document.body && target !== document && !container.contains(target)) return
      const files = feedbackClipboardImages(event.clipboardData)
      if (!files.length) return
      event.preventDefault()
      void addImages(files)
    }
    document.addEventListener('paste', paste)
    return () => document.removeEventListener('paste', paste)
  }, [account, addImages, receipt, view])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitting.current || attachmentRead.current || !consent || !policy || (attachEnvironment && !environment)) return
    const epoch = accountEpoch()
    if (!account || account.epoch !== epoch) {
      confirmAccountAgain()
      setError('B 站账号已变更，请重新确认后提交')
      return
    }
    const cleanedTitle = title.trim()
    const cleanedMessage = message.trim()
    const reply = contactRequired ? contact.trim() : ''
    const replyEmail = contactRequired ? email.trim() : ''
    if (cleanedTitle.length < 3) { setError('标题至少填写 3 个字符'); return }
    if (cleanedMessage.length < 10) { setError('请填写至少 10 个字符，方便我们了解情况'); return }
    if (replyEmail && !event.currentTarget.querySelector<HTMLInputElement>('input[type="email"]')?.validity.valid) {
      setError('请填写有效的邮箱'); return
    }
    if (contactRequired && !reply && !replyEmail) { setError('版权反馈请留下邮箱或其他联系方式'); return }
    setError('')
    submitting.current = true
    setSending(true)
    try {
      const result = await sendFeedback({
        category, title: cleanedTitle, message: cleanedMessage, contact: reply, consent: true, anonymous,
        policyVersion: policy.version, accountSession: account.accountSession, images,
        ...(replyEmail ? { email: replyEmail } : {}),
        ...(attachEnvironment && environment ? { environment } : {}),
      })
      if (epoch !== accountEpoch()) return
      setReceipt({ id: result.id, anonymous })
      setTitle(''); setMessage(''); setEmail(''); setContact('')
      setAnonymous(false); setConsent(false); setCopyStatus('')
      setImages([])
    } catch (cause) {
      if (epoch !== accountEpoch()) return
      const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined
      if (code === 'feedback_account_changed') confirmAccountAgain()
      if (code === 'feedback_login_required') { setAnonymous(false); setConsent(false); setAccount(null) }
      if (code === 'feedback_policy_changed') { reloadPolicy(); setPolicyOpen(true) }
      setError(commandErrorMessage(cause, '反馈提交失败，请重试'))
    } finally {
      submitting.current = false
      setSending(false)
    }
  }

  if (!account) return <div className="feedback-page-content">
    <div className="feedback-account-state">
      <span className="feedback-account-icon" aria-hidden="true">
        {account === undefined ? <LoaderCircle size={25} className="spin"/> : <MessageSquareText size={27}/>}
      </span>
      {account === undefined ? <p role="status">正在确认 B 站登录状态…</p> : <>
        <strong>{accountError ? '暂时无法确认登录状态' : error || '登录 B 站后可提交反馈'}</strong>
        <button type="button" className="collection-primary feedback-primary" onClick={accountError ? confirmAccountAgain : onLogin}>
          {accountError ? '重试' : '登录 B 站'}<ArrowRight size={16} aria-hidden="true"/>
        </button>
      </>}
    </div>
    <FeedbackSupport standalone/>
  </div>

  const navigation = <nav className="feedback-navigation" aria-label="意见反馈">
    <button type="button" aria-pressed={view === 'submit'} disabled={sending} onClick={() => setView('submit')}>提交反馈</button>
    <button type="button" aria-pressed={view === 'history'} disabled={sending} onClick={() => { setReceipt(undefined); setOpenInHistory(undefined); setView('history') }}>我的反馈</button>
  </nav>

  if (view === 'history') return <div className="feedback-page-content">{navigation}
    <FeedbackHistory key={account.accountSession} accountSession={account.accountSession} initiallyExpanded={openInHistory}/>
  </div>

  if (receipt) return <div className="feedback-receipt">
    <CircleCheck size={34} aria-hidden="true"/>
    <strong role="status">反馈已收到</strong>
    <div className="feedback-receipt-number"><span>反馈编号</span><code>{receipt.id}</code></div>
    <div className="feedback-actions">
      <button type="button" className="collection-flat-button" onClick={() => {
        void copyText(receipt.id).then(() => setCopyStatus('已复制编号'), () => setCopyStatus('复制失败，请重试'))
      }}><Copy size={16}/>复制编号</button>
      {receipt.anonymous
        ? <button type="button" className="collection-primary feedback-primary" onClick={onClose}>完成</button>
        : <button type="button" className="collection-primary feedback-primary" onClick={() => { setOpenInHistory(receipt.id); setReceipt(undefined); setView('history') }}>查看进度</button>}
    </div>
    {copyStatus && <small role="status">{copyStatus}</small>}
  </div>

  return <div className="feedback-page-content">{navigation}<form ref={form} className="feedback-form" noValidate onSubmit={event => void submit(event)}>
    <fieldset disabled={sending} className="feedback-fieldset">
      <div className="feedback-fields">
        <div className="feedback-subject">
          <label className="feedback-field"><span>类型</span>
            <span className="feedback-select"><select tabIndex={0} value={category} onChange={event => setCategory(event.target.value as FeedbackCategory)}>
              {Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select><ChevronDown size={16} aria-hidden="true"/></span>
          </label>
          <label className="feedback-field"><span>标题</span>
            <input value={title} maxLength={120} onChange={event => setTitle(event.target.value)} placeholder="用一句话概括"/>
          </label>
        </div>
        <label className="feedback-field"><span>描述</span>
          <textarea tabIndex={0} value={message} maxLength={5000} onChange={event => setMessage(event.target.value)} rows={4}
            placeholder={category === 'bug' ? '你进行了什么操作？遇到了什么问题？' : '写下你想反馈的内容'}/>
        </label>
        <div className="feedback-attachments">
          <div className="feedback-section-heading"><strong>截图</strong><small>{images.length} / {FEEDBACK_IMAGE_MAX_COUNT}</small>
            {!isMobile && images.length < FEEDBACK_IMAGE_MAX_COUNT && <small>可直接粘贴图片</small>}
          </div>
          <input ref={fileInput} type="file" accept={FEEDBACK_IMAGE_ACCEPT} multiple hidden onChange={event => {
            const files = Array.from(event.target.files ?? [])
            event.target.value = ''
            void addImages(files)
          }}/>
          <div className="feedback-image-list">
            {images.map((image, index) => <div className="feedback-image" key={index}>
              <img src={feedbackImagePreview(image)} alt={image.name}/>
              <button type="button" aria-label={`移除 ${image.name}`} onClick={() => {
                setImages(current => current.filter((_, position) => position !== index))
                setImageError('')
              }}><X size={15}/></button>
            </div>)}
            {images.length < FEEDBACK_IMAGE_MAX_COUNT && <button type="button" className="feedback-image-add" disabled={readingImages} onClick={() => fileInput.current?.click()}>
              {readingImages ? <LoaderCircle className="spin" size={18}/> : <ImagePlus size={18}/>}
              <span>{readingImages ? '读取中' : '添加图片'}</span>
            </button>}
          </div>
          {imageError && <p className="feedback-error" role="alert">{imageError}</p>}
        </div>
        <div className="feedback-disclosure-fields">
          {contactRequired && <div className="feedback-copyright-contact">
            <div className="feedback-section-heading"><strong>联系方式</strong><small>至少填写一项，用于核实权属</small></div>
            <label className="feedback-field"><span>邮箱</span>
              <input type="email" autoComplete="email" value={email} maxLength={254} onChange={event => setEmail(event.target.value)} placeholder="接收核实结果的邮箱"/>
            </label>
            <label className="feedback-field"><span>其他联系方式</span>
              <input value={contact} maxLength={200} onChange={event => setContact(event.target.value)} placeholder="例如 QQ 号"/>
            </label>
          </div>}
          <div className="feedback-anonymity">
            <FeedbackCheck checked={anonymous} onToggle={() => {
              setAnonymous(value => !value)
              setConsent(false)
            }}>匿名反馈</FeedbackCheck>
            {anonymous ? <small className="feedback-anonymous-notice">匿名提交后，无法在「我的反馈」查看处理进度。</small>
              : <small className="feedback-uid">将关联 B 站 UID <strong>{account.uid}</strong>，可在本机查看进度。</small>}
          </div>
          {category === 'bug' && <div className="feedback-environment">
            <div className="feedback-environment-row">
              <FeedbackCheck checked={includeEnvironment} onToggle={() => {
                setEnvironmentError(false)
                setIncludeEnvironment(value => !value)
              }}>附上本机环境</FeedbackCheck>
              {includeEnvironment && (environment
                ? <button type="button" className="feedback-policy-link" aria-expanded={environmentOpen} aria-controls={`${id}-environment`} onClick={() => setEnvironmentOpen(value => !value)}>{environmentOpen ? '收起环境' : '查看环境'}</button>
                : <small role="status">{environmentError ? '读取失败，可取消勾选后提交' : '正在读取本机环境…'}</small>)}
            </div>
            {includeEnvironment && environment && <pre id={`${id}-environment`} className="feedback-environment-preview" hidden={!environmentOpen}>{formatDiagnosticEnvironment(currentDisplayVersion, environment)}</pre>}
          </div>}
        </div>
        <div className="feedback-consent">
          {policy ? <>
            <div className="feedback-consent-row">
              <FeedbackCheck checked={consent} onToggle={() => setConsent(value => !value)}>
                {anonymous ? '我已阅读并同意' : '同意附上 B 站 UID，并接受'}
              </FeedbackCheck>
              <button type="button" className="feedback-policy-link" aria-expanded={policyOpen} aria-controls={`${id}-policy`} onClick={() => setPolicyOpen(value => !value)}>{policy.title}</button>
            </div>
            <div className="feedback-policy" id={`${id}-policy`} hidden={!policyOpen}>
              {policy.sections.map(([heading, body]) => <section key={heading}><strong>{heading}</strong><p>{body}</p></section>)}
            </div>
          </> : policyError
            ? <div className="feedback-consent-row"><small role="status">暂时无法读取隐私说明</small><button type="button" className="feedback-policy-link" onClick={reloadPolicy}>重试</button></div>
            : <small role="status">正在读取隐私说明…</small>}
        </div>
      </div>
    </fieldset>
    {error && <p className="feedback-error" role="alert">{error}</p>}
    <div className="feedback-actions">
      <button type="submit" className="collection-primary feedback-primary" disabled={!consent || !policy || sending || readingImages || (attachEnvironment && !environment)}>
        {sending && <LoaderCircle className="spin" size={16}/>}
        {sending ? '正在提交…' : '提交反馈'}
      </button>
    </div>
  </form><FeedbackSupport/></div>
}

function FeedbackSupport({ standalone = false }: { standalone?: boolean }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [notice, setNotice] = useState('')
  const openLink = (destination: 'author' | 'website') => {
    setNotice('')
    void openFeedbackLink(destination).catch(() => setNotice('无法打开链接，请在浏览器中访问。'))
  }
  return <section className="feedback-support" data-standalone={standalone || undefined} aria-label="人工联系">
    {standalone ? <h3 className="feedback-support-heading">人工联系</h3> :
      <button type="button" className="feedback-support-toggle" aria-expanded={open} aria-controls={id} onClick={() => setOpen(value => !value)}>
        <Headphones size={17} aria-hidden="true"/><span>人工联系</span><ChevronDown size={16} aria-hidden="true"/>
      </button>}
    {(standalone || open) && <div className="feedback-support-list" id={id}>
      <button type="button" data-channel="author" title="space.bilibili.com/295967580" onClick={() => openLink('author')}>
        <span className="feedback-support-icon" aria-hidden="true"><Tv size={19}/></span>
        <span className="feedback-support-copy"><strong>作者 B 站主页</strong><small>space.bilibili.com</small></span>
        <ArrowUpRight size={16} className="feedback-support-action" aria-hidden="true"/>
      </button>
      <button type="button" data-channel="website" onClick={() => openLink('website')}>
        <span className="feedback-support-icon" aria-hidden="true"><Globe size={19}/></span>
        <span className="feedback-support-copy"><strong>BiliMusic 官网</strong><small>bilimusic.cn</small></span>
        <ArrowUpRight size={16} className="feedback-support-action" aria-hidden="true"/>
      </button>
      <button type="button" data-channel="group" aria-label={`复制 QQ 群号 ${supportGroup}`} onClick={() => {
        void copyText(supportGroup).then(() => setNotice('已复制 QQ 群号'), () => setNotice('复制失败，请手动输入群号。'))
      }}>
        <span className="feedback-support-icon" aria-hidden="true"><MessageSquareText size={19}/></span>
        <span className="feedback-support-copy"><strong>QQ 群</strong><small>{supportGroup}</small></span>
        <Copy size={16} className="feedback-support-action" aria-hidden="true"/>
      </button>
    </div>}
    {notice && (standalone || open) && <small className="feedback-support-status" role="status">{notice}</small>}
  </section>
}

function FeedbackCheck({ checked, onToggle, children }: { checked: boolean; onToggle: () => void; children: string }) {
  return <button type="button" className="feedback-check" role="checkbox" aria-checked={checked} onClick={onToggle}>
    <span className="feedback-check-mark" aria-hidden="true"><Check size={14}/></span><span>{children}</span>
  </button>
}
