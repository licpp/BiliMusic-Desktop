import { useEffect, useState } from 'react'
import { Search } from 'lucide-react'
import { DailyRecommendationCard } from '../search/ExploreCards'
import '../search/explore.css'

export const DAILY_PREVIEW_PANEL_ID = 'extension-daily-preview-panel'

/**
 * What the extension adds to the search page, drawn with the real card so the
 * theme, the layout this device uses and today's date stay true. The preview
 * is always there; only an enabled extension can actually take the user to the
 * search page, and a click before that explains what to switch on first.
 */
export function ExtensionDailyPreview({ open, enabled, onOpen }: {
  open: boolean
  enabled: boolean
  onOpen?: () => void
}) {
  const [explain, setExplain] = useState(false)
  useEffect(() => {
    if (enabled) setExplain(false)
  }, [enabled])
  if (!open) return null
  const content = <>
    <span className="extension-preview-search">
      <Search size={14} aria-hidden="true"/><span>搜索歌曲、歌手、BV 号或链接</span>
    </span>
    <span className="explore-landing extension-preview-landing">
      <span className="explore-recommendations"><DailyRecommendationCard interactive={false}/></span>
    </span>
  </>
  // The caption belongs to the frame, so the click target stays one element.
  const caption = !onOpen ? '搜索首页预览' : enabled ? '搜索首页预览 · 点击前往' : '搜索首页预览 · 启用后可前往'
  return <div className="extension-preview" id={DAILY_PREVIEW_PANEL_ID} data-enabled={enabled}>
    <p className="extension-preview-caption">{caption}</p>
    {onOpen
      ? <button type="button" className="extension-preview-frame extension-preview-link"
        aria-label={enabled ? '前往搜索首页查看每日推荐' : '每日推荐尚未启用'}
        aria-disabled={!enabled} onClick={() => enabled ? onOpen() : setExplain(true)}>{content}</button>
      : <div className="extension-preview-frame">{content}</div>}
    {explain && <p className="extension-preview-explain" role="status">先勾选「每日推荐」，再点击预览前往搜索首页。</p>}
  </div>
}
