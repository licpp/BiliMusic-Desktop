import { useSyncExternalStore } from 'react'
import './creator-folder-artwork.css'

export const folderColors = ['湖蓝', '杏橙', '藤紫', '松绿', '莓红', '金棕']
export const folderPatterns = [
  { label: '棋格', solid: 'M4 4h5v5H4zM15 4h5v5h-5zM9.5 9.5h5v5h-5zM4 15h5v5H4zM15 15h5v5h-5z' },
  { label: '双环', outline: 'M15 9a6 6 0 1 1-12 0 6 6 0 0 1 12 0Zm6 6a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z' },
  { label: '斜纹', outline: 'm4 12 8-8M4 20 20 4m-8 16 8-8' },
  { label: '花瓣', solid: 'M11 11H8a4 4 0 1 1 4-4v4Zm2 0V8a4 4 0 1 1 4 4h-4Zm0 2h3a4 4 0 1 1-4 4v-4Zm-2 0v3a4 4 0 1 1-4-4h4Z' },
  { label: '风车', solid: 'm12 12 2-8 6 6-8 2Zm0 0 8 2-6 6-2-8Zm0 0-2 8-6-6 8-2Zm0 0-8-2 6-6 2 8Z' },
  { label: '阶梯', solid: 'M4 20v-5h5v-5h5V5h6v15Z' },
  { label: '折纸', outline: 'm3 17 8-12 10 12H3Zm8-12 3 12m0 0 7-7' },
  { label: '拼块', solid: 'M4 4h7v7H4zM13 4h1a6 6 0 0 1 6 6v1h-7zM4 13h7v7h-1a6 6 0 0 1-6-6zM13 13h7v7h-7z' },
]
export type CreatorFolderStyle = { color: number; pattern: number }

const keyPrefix = 'bilimusic-creator-folder-style-v1:'
const styleEvent = 'bilimusic-creator-folder-style'
function subscribe(listener: () => void) {
  window.addEventListener(styleEvent, listener)
  window.addEventListener('storage', listener)
  return () => {
    window.removeEventListener(styleEvent, listener)
    window.removeEventListener('storage', listener)
  }
}

export function useCreatorFolderStyle(id: string): CreatorFolderStyle {
  const snapshot = useSyncExternalStore(subscribe, () => {
    try { return localStorage.getItem(keyPrefix + id) } catch { return null }
  }, () => null)
  const match = /^(\d+):(\d+)$/.exec(snapshot ?? '')
  if (match) {
    const color = Number(match[1]), pattern = Number(match[2])
    if (folderColors[color] && folderPatterns[pattern]) return { color, pattern }
  }
  let hash = 0
  for (const char of id) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0
  return { color: hash % folderColors.length, pattern: Math.floor(hash / folderColors.length) % folderPatterns.length }
}

export function saveCreatorFolderStyle(id: string, { color, pattern }: CreatorFolderStyle) {
  localStorage.setItem(keyPrefix + id, `${color}:${pattern}`)
  window.dispatchEvent(new Event(styleEvent))
}

export function FolderPattern({ index }: { index: number }) {
  const { solid, outline } = folderPatterns[index]
  return <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden="true" data-folder-pattern={index}>
    {solid && <path d={solid} fill="currentColor"/>}
    {outline && <path d={outline} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>}
  </svg>
}

export function FolderStyleTile({ color, pattern }: CreatorFolderStyle) {
  return <span className="creator-folder-tile" data-folder-color={color} aria-hidden="true"><FolderPattern index={pattern}/></span>
}

export function CreatorFolderArtwork({ id }: { id: string }) {
  const style = useCreatorFolderStyle(id)
  return <span className="artwork creator-folder-artwork"><FolderStyleTile {...style}/></span>
}
