import { syncErrorMessage } from '../../services/userErrors'
import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Check } from 'lucide-react'
import type { SyncConflict } from '../../services/sync'

type Cell = { type: 'missing' } | { type: 'value'; value: unknown }
type Menu = { token: string; options: Record<string, { cell: Cell; label: string }[]> }
const fields: Record<string, string> = { name: '名称', description: '简介', creatorNote: 'UP 主备注', title: '歌曲名', artist: '歌手', folderId: '所在文件夹', __present: '保留或删除', __record: '整项资料', __parent: '所属歌单或文件夹', lyrics: '歌词', lyricOffset: '歌词偏移' }
const entities: Record<string, string> = { playlist:'歌单', item:'歌单曲目', collection:'收藏合集', collectionFolder:'收藏文件夹', linkedFolder:'关联收藏夹', track:'歌曲', lyric:'歌词', favorite:'收藏', view:'列表' }
export function conflictText(cell: Cell, field: string): string {
  if (field === '__parent') return cell.type === 'missing' ? '移除这条引用' : '恢复所属歌单或文件夹'
  if (cell.type === 'missing') return '未设置 / 已移除'
  if (field === '__present') return cell.value ? '保留这项资料' : '删除这项资料'
  if (cell.value === null) return '清空此项'
  if (typeof cell.value === 'object') {
    const record = cell.value as { fields?: { name?: string; title?: string } }
    return record?.fields?.name || record?.fields?.title || JSON.stringify(cell.value)
  }
  return String(cell.value) || '空白'
}
export function SyncConflicts({ conflicts, busy, onMerge }: { conflicts: SyncConflict[]; busy: boolean; onMerge: (resolution: string) => void }) {
  const [menu, setMenu] = useState<Menu | null>(null)
  const [choices, setChoices] = useState<Record<string, Cell>>({})
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    setMenu(null); setChoices({}); setError('')
    void invoke<Menu>('sync_conflict_options').then(value => {
      if (!alive) return
      if (conflicts.every(c => value.options[JSON.stringify([c.key, c.field])]?.length)) setMenu(value)
      else setError('冲突内容已有变化，请刷新后重新选择。')
    }).catch(e => { if (alive) setError(syncErrorMessage(e)) })
    return () => { alive = false }
  }, [conflicts])
  const chooseAll = (side: string) => {
    if (!menu) return
    const selected: Record<string, Cell> = {}
    for (const [key, values] of Object.entries(menu.options)) {
      const candidates = values.filter(option => option.label.startsWith(side))
      if (candidates.length === 1) selected[key] = candidates[0].cell
    }
    setChoices(previous => ({ ...previous, ...selected }))
  }
  const ready = menu && conflicts.every(c => JSON.stringify([c.key, c.field]) in choices)
  const hasMultipleCloudVersions = menu && Object.values(menu.options).some(values => values.filter(option => option.label.startsWith('云端')).length > 1)
  return <div className="sync-conflicts">
    <p className="sync-note">逐项选择要保留的内容。{hasMultipleCloudVersions && '存在多个云端版本的条目需单独选择。'}</p>
    {error ? <p role="alert">{error}</p> : !menu ? <p role="status">正在读取修改…</p> : <>
      <div className="sync-actions"><button disabled={busy} onClick={() => chooseAll('本机')}>全部保留本机</button><button disabled={busy} onClick={() => chooseAll('云端')}>全部保留云端</button></div>
      {conflicts.map(c => {
        const key = JSON.stringify([c.key, c.field])
        return <fieldset className="sync-conflict" key={key} disabled={busy}>
          <legend>{entities[c.key.split(':')[0]] || '资料'} · {fields[c.field] || c.field}{c.field !== 'name' && <small>{c.key.slice(c.key.indexOf(':') + 1)}</small>}</legend>
          <div className="sync-conflict-options">{menu.options[key]?.map((option, i) => {
            const selected = JSON.stringify(choices[key]) === JSON.stringify(option.cell)
            return <button key={i} type="button" aria-pressed={selected} onClick={() => setChoices(previous => ({ ...previous, [key]: option.cell }))}>
              <span className="sync-conflict-label">{option.label}{selected && <Check size={15} />}</span><span>{conflictText(option.cell, c.field)}</span>
            </button>
          })}</div>
        </fieldset>
      })}
      <button className="sync-primary" disabled={busy || !ready} onClick={() => { if (menu && ready) onMerge(JSON.stringify({ token: menu.token, choices })) }}>按选择合并并同步</button>
    </>}
  </div>
}
