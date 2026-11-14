import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Check } from 'lucide-react'
import { commandErrorMessage } from '../../services/desktopApi'
import type { SyncConflict } from '../../services/sync'

type Cell = { type: 'missing' } | { type: 'value'; value: unknown }
type Menu = { token: string; options: Record<string, { cell: Cell; label: string }[]> }
const fields: Record<string, string> = { name: '名称', description: '简介', creatorNote: 'UP 主备注', title: '歌曲名', artist: '歌手', folderId: '所在文件夹', __present: '保留或删除', __record: '整项资料', __parent: '所属文件夹', lyrics: '歌词', lyricOffset: '歌词偏移' }
export function conflictText(cell: Cell, field: string): string {
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
    void invoke<Menu>('sync_conflict_options').then(value => { if (alive) setMenu(value) }).catch(e => { if (alive) setError(commandErrorMessage(e)) })
    return () => { alive = false }
  }, [conflicts])
  const chooseAll = (side: number) => {
    if (menu) setChoices(Object.fromEntries(Object.entries(menu.options).map(([key, values]) => [key, values[Math.min(side, values.length - 1)].cell])))
  }
  const ready = menu && conflicts.every(c => JSON.stringify([c.key, c.field]) in choices)
  return <div className="sync-conflicts">
    <p className="sync-note">逐项选择要保留的内容，其余资料自动合并。</p>
    {error ? <p role="alert">{error}</p> : !menu ? <p role="status">正在读取修改…</p> : <>
      <div className="sync-actions"><button disabled={busy} onClick={() => chooseAll(0)}>全部保留本机</button><button disabled={busy} onClick={() => chooseAll(1)}>全部保留云端</button></div>
      {conflicts.map(c => {
        const key = JSON.stringify([c.key, c.field])
        return <fieldset className="sync-conflict" key={key} disabled={busy}>
          <legend>{fields[c.field] || c.field}<small>{c.key}</small></legend>
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
