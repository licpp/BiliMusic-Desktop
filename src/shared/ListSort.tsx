import { ArrowUpDown, CalendarDays, Check, ChevronDown, ListOrdered, Type } from 'lucide-react'
import { useState } from 'react'
import { ActionMenu } from './ActionMenu'
import { useCompactLayout } from './useCompactLayout'
import { useListPreferences, useSaveListPreferences } from '../services/listPreferences'
import type { SortRule } from '../services/listOrdering'
import { commandErrorMessage } from '../services/desktopApi'
import '../styles/list-sorting.css'

export function useListSort(entity: string) {
  const query = useListPreferences()
  return { rule: query.data?.preferences.find(p => p.entity === entity)?.sortRule || 'source:asc' as SortRule, dates: query.data?.dates || {} }
}

export function ListSort({ entity }: { entity: string }) {
  const { rule } = useListSort(entity), save = useSaveListPreferences(), compact = useCompactLayout()
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [mode, direction] = rule.split(':')
  const modes = [
    { id: 'source', label: '默认顺序', Icon: ListOrdered },
    { id: 'name', label: '名称顺序', Icon: Type },
    { id: 'date', label: '发布日期', Icon: CalendarDays },
  ]
  const orderLabel = mode === 'date' ? direction === 'desc' ? '从新到旧' : '从旧到新' : direction === 'desc' ? '倒序' : '正序'
  const change = async (next: string) => {
    setBusy(true); setError('')
    try {
      const reverse = mode === next ? direction === 'asc' ? 'desc' : 'asc' : next === 'date' ? 'desc' : 'asc'
      await save([{ entity, sortRule: `${next}:${reverse}` as SortRule }])
    } catch (cause) { setError(commandErrorMessage(cause)) }
    finally { setBusy(false) }
  }
  return <span className="list-sort-control">
    <ActionMenu label="列表排序" panelClassName="list-sort-menu" touchSheet={compact} icon={<>
      <ArrowUpDown size={16}/><span className="sort-current-label">{modes.find(item => item.id === mode)?.label}</span><ChevronDown size={14} className="sort-trigger-chevron"/>
    </>}>{close => <>
      {modes.map(({ id, label, Icon }) => <button type="button" key={id} role="menuitemradio" aria-checked={id === mode} disabled={busy} onClick={() => { close(); void change(id) }}>
        <Icon size={17}/><span>{label}</span>{mode === id && <><small>{orderLabel}</small><Check size={16}/></>}
      </button>)}
      <small className="sort-menu-note">再次选择当前规则可切换正反序</small>
    </>}</ActionMenu>
    {error && <span className="inline-error" role="alert">{error}</span>}
  </span>
}
