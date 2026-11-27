import type { Track } from '../../domain/track'
import { accountEpoch } from '../../services/accountScope'
import { toTrack } from '../../services/collectionTrack'
import { getVideoParts, saveLibraryTrack } from '../../services/desktopApi'

export async function prepareEditableTrack(track: Track, current: () => boolean) {
  const epoch = accountEpoch()
  if (track.source.provider === 'bilibili' && track.source.cid <= 0) {
    const detail = await getVideoParts(track.source.bvid)
    if (!current() || accountEpoch() !== epoch) return
    if (detail.parts.length > 1) throw new Error('请展开分 P，再选择要编辑的一首')
    const part = detail.parts[0]
    if (!part || part.cid <= 0) throw new Error('没有可编辑的歌曲')
    track = toTrack(detail, part)
  }
  if (current() && accountEpoch() === epoch) return saveLibraryTrack(track)
}
