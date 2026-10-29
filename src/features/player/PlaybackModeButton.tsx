import { ListOrdered, Repeat2, Repeat1, Shuffle } from 'lucide-react'
import { usePlayerStore } from './playerStore'
export function PlaybackModeButton() {
  const shuffled = usePlayerStore(s => s.shuffled)
  const repeat = usePlayerStore(s => s.repeatMode)
  const cycle = usePlayerStore(s => s.cyclePlaybackMode)
  const label = shuffled ? '随机播放' : repeat === 'one' ? '单曲循环' : repeat === 'all' ? '列表循环' : '顺序播放'
  const Icon = shuffled ? Shuffle : repeat === 'one' ? Repeat1 : repeat === 'all' ? Repeat2 : ListOrdered
  return <button className="playback-mode" aria-label={`播放模式：${label}，点击切换`} title={label} onClick={cycle}><Icon size={18} /></button>
}
