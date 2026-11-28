import type { ImportPlaylist, ImportSong } from './playlistImportModel'

const maxFileSize = 16 * 1024 * 1024
const trackUriPattern = /^spotify:track:[a-zA-Z0-9]{22}$/
const csvColumns = {
  uri: ['track uri', '曲目 uri', 'トラックuri'],
  title: ['track name', '曲目名称', '曲目名稱', 'トラック名'],
  artists: ['artist name(s)', '艺人名称', '藝人名稱', 'アーティスト名'],
  album: ['album name', '专辑名称', '專輯名稱', 'アルバム名'],
  duration: ['track duration (ms)', 'duration (ms)', '曲目时长(毫秒)', '曲目長度(毫秒)', 'トラックの長さ(ミリ秒)'],
}

function cleanText(value: unknown) {
  return typeof value === 'string' ? value.replace(/\0/g, '').trim() : ''
}

function limitCharacters(text: string, max: number) {
  if (text.length <= max) return text
  return Array.from(text.slice(0, max * 2)).slice(0, max).join('')
}

function song(
  titleValue: unknown,
  artists: string[],
  albumValue: unknown,
  uriValue: unknown,
  duration: number | undefined,
  index: number,
): ImportSong | undefined {
  const title = cleanText(titleValue)
  const uri = cleanText(uriValue)
  if (!title || (uri && !trackUriPattern.test(uri))) return
  const album = cleanText(albumValue)
  const durationSeconds = duration !== undefined && duration > 0 && duration <= 604_800_000
    ? duration / 1000
    : undefined
  return {
    sourceId: uri || `spotify:row:${index}`,
    title: limitCharacters(title, 1000),
    artists: artists.map(cleanText).filter(Boolean).slice(0, 50).map(artist => limitCharacters(artist, 250)),
    ...(album ? { album: limitCharacters(album, 500) } : {}),
    ...(durationSeconds ? { durationSeconds } : {}),
  }
}

function playlist<T>(name: string, rows: Iterable<T>, convert: (row: T, index: number) => ImportSong | undefined): ImportPlaylist {
  const songs: ImportSong[] = []
  const seen = new Set<string>()
  let reportedCount = 0
  let unavailableCount = 0
  for (const row of rows) {
    const candidate = convert(row, reportedCount++)
    if (!candidate) {
      unavailableCount++
    } else if (!seen.has(candidate.sourceId)) {
      seen.add(candidate.sourceId)
      songs.push(candidate)
    }
  }
  return { name: name || 'Spotify 歌单', source: 'spotify', songs, reportedCount, unavailableCount }
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
}

function parseSpotifyJson(text: string): ImportPlaylist[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('Spotify 歌单 JSON 格式有误，请重新选择导出文件')
  }
  const lists = record(data)?.playlists
  if (!Array.isArray(lists)) throw new Error('请选择 Spotify 账号资料中的 Playlist JSON 文件')
  if (!lists.length) throw new Error('这份文件没有 Spotify 歌单')
  return lists.map(value => {
    const entry = record(value)
    if (!entry || !Array.isArray(entry.items)) throw new Error('Spotify 歌单文件缺少歌曲列表')
    return playlist(cleanText(entry.name), entry.items, (value, index) => {
      const row = record(value)
      const track = record(row?.track)
      if (!track || row?.localTrack) return
      return song(track.trackName, [cleanText(track.artistName)], track.albumName, track.trackUri, undefined, index)
    })
  })
}

function* csvRecords(text: string): Generator<string[]> {
  let row: string[] = []
  let cell = ''
  let quoted = false
  let quoteEnded = false
  for (let offset = 0; offset < text.length; offset++) {
    const char = text[offset]
    if (quoted) {
      if (char !== '"') cell += char
      else if (text[offset + 1] === '"') {
        cell += '"'
        offset++
      } else {
        quoted = false
        quoteEnded = true
      }
    } else if (char === ',' || char === '\n' || char === '\r') {
      row.push(cell)
      cell = ''
      quoteEnded = false
      if (char === ',') continue
      if (char === '\r' && text[offset + 1] === '\n') offset++
      if (row.some(value => value.trim())) yield row
      row = []
    } else if (!quoteEnded && !cell && char === '"') {
      quoted = true
    } else {
      if (quoteEnded || char === '"') throw new Error('歌单 CSV 的引号格式有误，请重新导出')
      cell += char
    }
  }
  if (quoted) throw new Error('歌单 CSV 内容不完整，请重新导出')
  row.push(cell)
  if (row.some(value => value.trim())) yield row
}

function csvArtists(value: string, legacy: boolean): string[] {
  if (legacy) return value.split(';', 50)
  // Exportify uses commas to separate artists and escapes commas inside individual names.
  const names: string[] = []
  let name = ''
  for (let index = 0; index < value.length; index++) {
    const char = value[index]
    if (char === '\\' && value[index + 1] === ',') {
      name += ','
      index++
    } else if (char === ',') {
      names.push(name)
      if (names.length === 50) return names
      name = ''
    } else {
      name += char
    }
  }
  names.push(name)
  return names
}

function parseExportifyCsv(text: string, filename: string): ImportPlaylist {
  const rows = csvRecords(text)
  const headers = (rows.next().value ?? []).map((value: string) => value.normalize('NFKC').trim().toLowerCase())
  const column = (key: keyof typeof csvColumns) => headers.findIndex((value: string) => csvColumns[key].includes(value))
  const uri = column('uri'), title = column('title'), artists = column('artists')
  const album = column('album'), duration = column('duration')
  const legacy = headers[duration] === 'duration (ms)'
  if (uri < 0 || title < 0 || artists < 0) throw new Error('请选择 Exportify 导出的 Spotify 歌单 CSV 文件')
  return playlist(filename.replace(/\.csv$/i, '').trim(), rows, (row, index) => {
    if (row.length !== headers.length || !cleanText(row[uri])) return
    return song(row[title], csvArtists(row[artists], legacy), row[album], row[uri], Number(row[duration]), index)
  })
}

export function parseSpotifyPlaylistFile(text: string, filename: string): ImportPlaylist[] {
  if (text.length > maxFileSize) throw new Error('歌单文件超过 16 MB，请分批导出')
  const content = text.trim()
  if (!content) throw new Error('歌单文件为空')
  return /\.json$/i.test(filename) || content.startsWith('{')
    ? parseSpotifyJson(content)
    : [parseExportifyCsv(content, filename)]
}

export async function readSpotifyPlaylistFile(file: File): Promise<ImportPlaylist[]> {
  if (file.size > maxFileSize) throw new Error('歌单文件超过 16 MB，请分批导出')
  const text = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取歌单文件'))
    reader.onerror = reader.onabort = () => reject(new Error('无法读取歌单文件'))
    reader.readAsText(file, 'UTF-8')
  })
  return parseSpotifyPlaylistFile(text, file.name)
}
