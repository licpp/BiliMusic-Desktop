import { useQuery } from '@tanstack/react-query'
import { invoke } from '@tauri-apps/api/core'
import { useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { accountEpoch } from '../../services/accountScope'
import { commandErrorMessage } from '../../services/desktopApi'
import { parseEmotePackages } from './emotes'

export function useCommentEmotes() {
  return useQuery({ queryKey: ['comment-emotes', accountEpoch()], queryFn: async () => parseEmotePackages(await invoke('bili_comment_emotes')), staleTime: 5 * 60_000, retry: false })
}
export function CommentEmotes({ onChoose }: { onChoose: (text: string) => void }) {
  const query = useCommentEmotes()
  const [packageId, setPackageId] = useState('')
  const pack = query.data?.find(item => item.id === packageId) ?? query.data?.[0]
  return <div className="comment-emote-picker" aria-label="B 站表情">
    {query.isPending ? <span role="status"><LoaderCircle size={16} className="spin"/>正在读取表情</span> : query.isError ? <button type="button" onClick={() => void query.refetch()}>{commandErrorMessage(query.error)} · 重试</button> : <>
      <div className="comment-emote-tabs" role="tablist" aria-label="表情包">{query.data?.map(item => <button type="button" role="tab" key={item.id} aria-selected={pack?.id === item.id} onClick={() => setPackageId(item.id)}>{item.name}</button>)}</div>
      <div className="comment-emote-grid" role="tabpanel" aria-label={pack?.name}>{pack?.emotes.map((item, index) => <button type="button" key={`${item.text}-${index}`} title={item.text} aria-label={`插入${item.text}`} onPointerDown={event => event.preventDefault()} onClick={() => onChoose(item.text)}>{item.url ? <img src={item.url} alt={item.text} loading="lazy" referrerPolicy="no-referrer"/> : item.text}</button>)}</div>
      {!pack && <small>当前账号没有可用的表情包</small>}
    </>}
  </div>
}
