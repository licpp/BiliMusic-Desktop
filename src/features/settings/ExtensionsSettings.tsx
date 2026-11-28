import { Fragment, useState } from 'react'
import { CalendarDays, Check, ChevronDown, ChevronRight, ChevronUp, Flame, Music2, Puzzle, TvMinimalPlay } from 'lucide-react'
import { EXTENSIONS, useExtensionPreferences } from '../../services/extensions'
import { DAILY_PREVIEW_PANEL_ID, ExtensionDailyPreview } from './ExtensionDailyPreview'
import './extensions-settings.css'

const groups = [
  { id: 'recommendation', title: '推荐' },
  { id: 'hot-search', title: '热搜' },
] as const

const optionIcons: Partial<Record<(typeof EXTENSIONS)[number]['id'], typeof Puzzle>> = {
  daily: CalendarDays,
  feed: TvMinimalPlay,
  bili: Flame,
  qq: Music2,
  netease: Music2,
}

export function ExtensionSettingsEntry({ onOpen }: { onOpen: () => void }) {
  return <button type="button" className="extension-settings-entry" data-focus="settings-extensions" onClick={onOpen}>
    <span className="extension-entry-icon"><Puzzle aria-hidden="true"/></span>
    <strong>扩展</strong>
    <ChevronRight size={18} aria-hidden="true"/>
  </button>
}

export function ExtensionsSettings({ onPreviewOpen }: { onPreviewOpen?: () => void }) {
  const enabledIds = useExtensionPreferences(state => state.enabledIds)
  const setEnabled = useExtensionPreferences(state => state.setEnabled)
  const [previewOpen, setPreviewOpen] = useState(true)
  return <section className="extension-settings" aria-labelledby="extension-search-heading">
    <h3 id="extension-search-heading">搜索与探索</h3>
    {groups.map(group => {
      const options = EXTENSIONS.filter(extension => extension.placement === 'search' && extension.group === group.id)
      if (!options.length) return null
      return <fieldset className="extension-settings-group" key={group.id}>
        <legend>{group.title}</legend>
        <div className="extension-settings-options">
          {options.map(({ id, title }) => {
            const checked = enabledIds.includes(id)
            const Icon = optionIcons[id] ?? Puzzle
            return <Fragment key={id}>
              <label className="extension-settings-option" data-checked={checked}>
                <Icon className="extension-option-icon" aria-hidden="true"/>
                <span>{title}</span>
                <span className="extension-settings-side">
                  {id === 'daily' && <button type="button" className="extension-preview-toggle"
                    data-focus="extension-daily-preview" aria-expanded={previewOpen}
                    aria-controls={previewOpen ? DAILY_PREVIEW_PANEL_ID : undefined}
                    onClick={() => setPreviewOpen(open => !open)}>
                    {previewOpen ? '收起' : '展开'}
                    {previewOpen ? <ChevronUp size={14} aria-hidden="true"/> : <ChevronDown size={14} aria-hidden="true"/>}
                  </button>}
                  <span className="extension-settings-check">
                    <input type="checkbox" checked={checked} data-native data-focus={`extension-${id}`}
                      aria-label={title}
                      onChange={event => setEnabled(id, event.currentTarget.checked)}
                      onKeyDown={event => {
                        if (event.key !== 'Enter') return
                        event.preventDefault()
                        if (!event.repeat) event.currentTarget.click()
                      }}/>
                    <Check aria-hidden="true" strokeWidth={3}/>
                  </span>
                </span>
              </label>
              {id === 'daily' && <ExtensionDailyPreview open={previewOpen} enabled={checked} onOpen={onPreviewOpen}/>}
            </Fragment>
          })}
        </div>
      </fieldset>
    })}
  </section>
}
