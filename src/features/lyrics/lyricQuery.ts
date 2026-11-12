import type { Track } from '../../domain/track'

const clean = (text: string) => text.normalize('NFKC').replace(/【[^】]*】/g, '').replace(/\s*[(（](?:live|现场|完整版|歌词版|高清|无损)[^)）]*[)）]/gi, '').trim()
const key = (text: string) => text.toLocaleLowerCase().replace(/[\p{P}\p{Z}\s]/gu, '')
export function automaticLyricQueries(track: Pick<Track, 'title' | 'artist'>) {
  const title = clean(track.title).replace(/^\s*(?:P\s*)?\d+\s*[.．、)）]\s*/i, '').trim()
  const artist = track.artist?.trim() || ''
  // A separator is ambiguous: both “歌名 - 歌手” and “歌手 - 歌名” occur on B站.
  // Known metadata resolves the direction; otherwise try both, with strict candidate checks.
  const pair = title.match(/^(.{1,80}?)\s*[-–—]\s*(.{1,80})$/)
  if (!pair) return [{ title, artist }]
  const [, left, right] = pair
  if (artist) {
    if (key(left) === key(artist)) return [{ title: right, artist }]
    if (key(right) === key(artist)) return [{ title: left, artist }]
    return [{ title, artist }]
  }
  const songFirst = /\s[-–—]\s/.test(title)
  return songFirst ? [{ title: left, artist: right }, { title: right, artist: left }] : [{ title: right, artist: left }, { title: left, artist: right }]
}
export const automaticLyricQuery = (track: Pick<Track, 'title' | 'artist'>) => automaticLyricQueries(track)[0]
