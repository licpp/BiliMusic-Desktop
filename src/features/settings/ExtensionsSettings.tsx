import { CalendarDays, Check, ChevronRight, Flame, Music2, Puzzle, TvMinimalPlay } from 'lucide-react'
import { EXTENSIONS, useExtensionPreferences } from '../../services/extensions'
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

export function ExtensionsSettings() {
  const enabledIds = useExtensionPreferences(state => state.enabledIds)
  const setEnabled = useExtensionPreferences(state => state.setEnabled)
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
            return <label className="extension-settings-option" data-checked={checked} key={id}>
              <Icon className="extension-option-icon" aria-hidden="true"/>
              <span>{title}</span>
              <span className="extension-settings-check">
                <input type="checkbox" checked={checked} data-native data-focus={`extension-${id}`}
                  onChange={event => setEnabled(id, event.currentTarget.checked)}
                  onKeyDown={event => {
                    if (event.key !== 'Enter') return
                    event.preventDefault()
                    if (!event.repeat) event.currentTarget.click()
                  }}/>
                <Check aria-hidden="true" strokeWidth={3}/>
              </span>
            </label>
          })}
        </div>
      </fieldset>
    })}
  </section>
}
