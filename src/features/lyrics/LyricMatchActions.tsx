import { Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { lyricsWereCleared, type StoredLyrics } from '../../domain/lyrics'
import './lyric-match-actions.css'

export function LyricMatchActions({ stored, busy, onClear, children }: { stored?: StoredLyrics | null; busy: boolean; onClear: () => void; children: ReactNode }) {
  const [confirm, setConfirm] = useState(false)
  const canClear = Boolean(stored && !lyricsWereCleared(stored))
  return <div className="lyric-match-actions">
    {confirm && canClear ? <>
      <span className="lyric-clear-prompt">移除当前歌词？</span>
      <div className="lyric-clear-action">
        <button type="button" autoFocus disabled={busy} onClick={() => setConfirm(false)}>取消</button>
        <button type="button" className="action-danger" disabled={busy} onClick={onClear}>确认移除</button>
      </div>
    </> : <>{children}{canClear && <div className="lyric-clear-action">
      <button type="button" className="action-danger" disabled={busy} onClick={() => setConfirm(true)}><Trash2 size={15}/>移除当前歌词</button>
    </div>}</>}
  </div>
}
