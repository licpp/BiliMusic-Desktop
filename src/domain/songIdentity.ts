import { Converter } from 'opencc-js/t2cn'
const simplified = Converter({ from: 't', to: 'cn' })
export type ExternalSong = { title:string; artists:string[]; aliases?:string[]; durationSeconds?:number }

/** Shared song text recognition. No network, UI, account or persistence policy. */
export type SongQueryInput = { title: string; artist?: string; source?: { uploaderName?: string } }
export type SongQuery = { title: string; artist: string }

export type SongEdition = 'live' | 'cover' | 'instrumental' | 'orchestral' | 'remix' | 'sped' | 'slowed' | 'remastered' | 'acoustic' | 'short' | 'cantonese' | 'mandarin'
const editions: Record<SongEdition, RegExp> = {
  live: /现场|演唱会|音乐会|\b(?:live|concert|the first take)\b/iu,
  cover: /翻唱|翻弹|歌ってみた|歌ってみました|弾いてみた|\bcover(?:ed)?\b/iu,
  instrumental: /伴奏|纯音乐|无人声|\b(?:instrumental|off[ -]?vocal|karaoke|inst)\b\.?/iu,
  orchestral: /管弦|交响|\b(?:orchestral|orchestra|orch)\b\.?/iu,
  remix: /混音|重混|\b(?:remix|dj)\b/iu,
  sped: /加速|\b(?:sped[ -]?up|nightcore)\b/iu,
  slowed: /降速|慢速|\bslowed\b/iu,
  remastered: /重制|重置|\bremaster(?:ed)?\b/iu,
  acoustic: /不插电|\bacoustic\b/iu,
  short: /片段|剪辑版|\b(?:short ver|tv size|tvサイズ)\b/iu,
  cantonese: /粤语|粵語|\bcantonese\b/iu,
  mandarin: /国语|國語|普通话|\bmandarin\b/iu,
}

export function decodeSongText(text: string): string {
  return text.replace(/<[^>]*>/g, ' ').replace(/&#(x[\da-f]+|\d+);/gi, (_, code: string) => {
    const value = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code)
    return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ' '
  }).replace(/&(?:amp|quot|apos|lt|gt|nbsp);/gi, entity => ({
    '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ',
  })[entity.toLowerCase()] || ' ').normalize('NFKC')
}

export const readableSongText = (text: string) => decodeSongText(text).toLowerCase()

export function songWords(text: string): string {
  return simplified(readableSongText(text)).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
}
export const songTextIdentity = (text: string) => songWords(text).replace(/ /g, '')
export function coreSongTitle(text: string): string {
  return readableSongText(text)
    .replace(/[（(【\[]([^）)】\]]*)[）)】\]]/gu, (whole, label: string) =>
      Object.values(editions).some(pattern => pattern.test(label)) || /^(?:official\s*)?(?:mv|audio|lyrics?|video)|官方|无损|音质|字幕|\b[248]k\b/iu.test(label) ? ' ' : whole)
    .replace(/(?:\b(?:live|remix|instrumental|karaoke|cover|sped[ -]?up|slowed)\b|现场版|演唱会版|伴奏版|翻唱版|加速版|降速版)/giu, ' ').trim()
}
export function containsSongTitle(candidate: string, title: string): boolean {
  const phrase = songWords(title)
  if (!phrase) return false
  // Latin titles must match whole words: “Star” must not match “Starlight”.
  if (/^[\x00-\x7f]+$/.test(phrase)) return ` ${songWords(candidate)} `.includes(` ${phrase} `)
  return songTextIdentity(candidate).includes(songTextIdentity(title))
}
export function songEditSimilarity(a: string, b: string): number {
  // Fuzzy matches are review-only. Cap input to keep batch matching bounded.
  const left = [...songTextIdentity(a)].slice(0, 160), right = [...songTextIdentity(b)].slice(0, 160)
  if (!left.length || !right.length) return 0
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i)
  left.forEach((letter, i) => {
    const row = [i + 1]
    right.forEach((other, j) => row.push(Math.min(row[j] + 1, previous[j + 1] + 1, previous[j] + (letter === other ? 0 : 1))))
    previous = row
  })
  return 1 - previous[right.length] / Math.max(left.length, right.length)
}
export const songEditions = (text: string) => new Set((Object.keys(editions) as SongEdition[]).filter(key => editions[key].test(readableSongText(text))))

export function songVersionConflict(left: string, right: string) {
  const wanted = songEditions(left), actual = songEditions(right)
  return [...new Set([...wanted, ...actual])].some(edition => wanted.has(edition) !== actual.has(edition))
}

const editionLabels: Record<SongEdition, string> = { live:'Live', cover:'Cover', instrumental:'Instrumental', orchestral:'Orchestral', remix:'Remix', sped:'Sped Up', slowed:'Slowed', remastered:'Remastered', acoustic:'Acoustic', short:'Short Ver', cantonese:'粤语', mandarin:'国语' }
function versionSuffix(text: string, alreadyIncluded = '') {
  const included = songEditions(alreadyIncluded)
  return [...songEditions(text)].filter(edition => !included.has(edition)).map(edition => ` (${editionLabels[edition]})`).join('')
}
export function songTitleIdentity(text: string) {
  return `${songTextIdentity(coreSongTitle(text))}|${[...songEditions(text)].sort().join(',')}`
}

/** Catalog-provided aliases and featured credits may improve recall. Edition
 * tags remain in the identity and are never silently converted to aliases. */
export function primarySongTitle(title: string) {
  return decodeSongText(title).replace(/[（(]([^）)]*)[）)]/gu, (whole, label: string) => {
    const bilingual = /[^\x00-\x7f]/.test(title.replace(whole, '')) && /^[\x00-\x7f\s]+$/.test(label)
    return /^\s*(?:feat\.?|ft\.?|featuring)\s/iu.test(label) || bilingual && !songEditions(label).size ? ' ' : whole
  }).replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.+$/iu, '').replace(/\s+/g, ' ').trim()
}

// Dice similarity is used by lyric / metadata result ordering. Playlist ranking
// retains its edit-distance metric and its independent decision thresholds.
export function songTokenSimilarity(left: string, right: string) {
  const a = songTextIdentity(left), b = songTextIdentity(right)
  if (!a || !b) return 0
  if (a === b) return 1
  if (a.length < 2 || b.length < 2) return 0
  const pairs = (s: string) => new Set(Array.from({length:s.length-1}, (_,i)=>s.slice(i,i+2)))
  const first=pairs(a), second=pairs(b)
  return 2 * [...first].filter(pair=>second.has(pair)).length / (first.size+second.size)
}

const trimEdges = (text: string) => text.replace(/^[\s:：|丨/·,，!！—–-]+|[\s:：|丨/·,，!！—–-]+$/g, '').trim()
const numberedTitle = (text: string) => text.normalize('NFKC').replace(/^\s*(?:P\s*)?\d+\s*[.、)]\s*/i, '').trim()
// Only remove presentation labels. Brackets can also contain the actual song name.
const presentation = /^(?:私藏馆|音乐分享|音乐推荐|每日一歌|每日推荐|经典老歌|高音质|无损(?:音质)?|Hi-?Res|4K|8K|高清|歌词版|纯享版|完整版|中字|中英字幕|双语字幕|MV|官方音源)[\s\p{P}\p{N}A-Za-z]*$/iu
const cleanLabels = (text: string) => text.replace(/【([^】]*)】|\[([^\]]*)\]|\(([^()]*)\)/g, (all, a, b, c) => {
  const label = a || b || c
  return presentation.test(label) && !versionSuffix(label) ? '' : all
}).trim()
const stripListeningPrefix = (text: string) => text
  .replace(/^.*?(?:录音棚|录音室|音响|音箱|耳机)(?:里|中)?(?:一起)?(?:聆听|听)(?:一首)?\s*/, '')
  .replace(/^(?:带你|一起|一起来|来|今天来)?(?:欣赏|聆听)(?:一首)?\s*/, '')
  .replace(/^(?:一起来听|听一首|戴上耳机听)\s*/, '')

function artistNearSong(text: string): string {
  const value = trimEdges(stripListeningPrefix(cleanLabels(text)).replace(/^听\s*/, '').split(/[:：|丨]/).at(-1) || '')
    .replace(/^(?:一首|歌手|原唱|演唱)\s*/, '')
    .replace(/(?:原唱|演唱|演绎|献唱)?的$|(?:原唱|演唱|演绎|献唱)\s*$/u, '').trim()
  // A long caption is not artist metadata. Leave it unconstrained rather than
  // passing the uploader/channel or advertising copy as the singer.
  if (!value || value.length > 60 || /(?:版|字幕)$/.test(value) || /(?:\b(?:remaster(?:ed)?|acoustic|studio|karaoke|edit|demo|version)\b|伴奏|钢琴|吉他|器乐|演奏)/i.test(value) || /[《》「」『』“”!?！？:：。]|(?:爆火|神曲|祝大家|节日|录音|翻唱|翻弹|推荐|合集|盘点|这首|歌曲|带你|私藏馆)/u.test(value)) return ''
  return /^[\p{L}\p{N}\s·・.&/＋+_-]+$/u.test(value) ? value : ''
}

function metadataArtist(track: SongQueryInput) {
  const artist = track.artist?.trim() || ''
  const uploader = track.source?.uploaderName?.trim()
  return artist && !/^(?:未知|歌手未知|未知歌手|unknown(?: artist)?)$/i.test(artist)
    && (!uploader || songTextIdentity(artist) !== songTextIdentity(uploader)) ? artist : ''
}

export function songQueries(track: SongQueryInput): SongQuery[] {
  const title = cleanLabels(numberedTitle(decodeSongText(track.title)))
  const artist = metadataArtist(track)
  const queries: SongQuery[] = []
  const add = (song: string, singer = artist) => {
    const next = { title: trimEdges(song), artist: singer }
    if (next.title && !queries.some(q => songTitleIdentity(q.title) === songTitleIdentity(next.title) && songTextIdentity(q.artist) === songTextIdentity(next.artist))) queries.push(next)
  }

  // Require exactly one quoted song: medleys and multi-song compilations must
  // not silently receive the lyrics of just their first song.
  const quotes = [...title.matchAll(/《([^《》]+)》|「([^「」]+)」|『([^『』]+)』|“([^“”]+)”|"([^"\n]+)"/g)]
  if (quotes.length === 1) {
    const match = quotes[0]
    const song = (match[1] || match[2] || match[3] || match[4] || match[5]).trim()
    const before = title.slice(0, match.index)
    const after = title.slice(match.index! + match[0].length)
    const afterArtist = after.match(/^\s*(?:[-—–:：]|原唱[:：]?|演唱[:：]?)\s*(.+)$/)
    const inferredArtist = artistNearSong(before) || (afterArtist ? artistNearSong(afterArtist[1]) : '')
    // Version information outside the quotes must not disappear during cleanup.
    add(song + versionSuffix(before + ' ' + after, song), artist || inferredArtist)
    return queries
  }
  if (quotes.length > 1) return [{ title, artist }]

  const cleaned = trimEdges(stripListeningPrefix(title))
  // A separator is ambiguous: both “song - singer” and “singer - song” occur.
  const pair = cleaned.match(/^(.{1,80}?)\s*[-–—]\s*(.{1,80})$/)
  if (pair) {
    const [, left, right] = pair
    if (artist) {
      if (songTextIdentity(left) === songTextIdentity(artist)) add(right)
      else if (songTextIdentity(right) === songTextIdentity(artist)) add(left)
      else add(cleaned)
    } else if (/\s[-–—]\s/.test(cleaned)) {
      add(left, right); add(right, left)
    } else { add(right, left); add(left, right) }
  } else {
    // Other common wrappers: 王菲：红豆 / 红豆（王菲）. Avoid arbitrary
    // splitting on whitespace, which would damage English song/artist names.
    const colon = cleaned.match(/^([^:：]{1,40})[:：]\s*(.+)$/)
    const trailingArtist = cleaned.match(/^(.+?)\s*\(([^()]+)\)$/)
    if (colon && artistNearSong(colon[1])) add(colon[2], artist || artistNearSong(colon[1]))
    else if (primarySongTitle(cleaned) !== cleaned) add(primarySongTitle(cleaned))
    else if (trailingArtist && !versionSuffix(trailingArtist[2]) && !presentation.test(trailingArtist[2]) && artistNearSong(trailingArtist[2])) add(trailingArtist[1], artist || artistNearSong(trailingArtist[2]))
    else add(cleaned)
  }
  return queries.length ? queries.slice(0, 2) : [{ title, artist }]
}
export const firstSongQuery = (track: SongQueryInput) => songQueries(track)[0]

export type RecognizedSong = {
  titles: string[]
  artists: string[]
  editions: Set<SongEdition>
  queries: SongQuery[]
}
/** Parse both catalog identities and noisy video captions. A performer suffix is
 * removable only when it names an artist supplied by the catalog; arbitrary
 * “XX版” labels and all edition requirements remain part of the identity. */
export function recognizeSong(input: {title: string; artists?: string[]; artist?: string; aliases?: string[]; uploaderName?: string; artistHints?:string[]}): RecognizedSong {
  const artists = (input.artists || (input.artist ? [input.artist] : [])).map(a => a.trim()).filter(Boolean)
  const performerHints = [...artists,...(input.artistHints || [])]
  const title = decodeSongText(input.title).replace(/\(([^()]*)\)/gu, (whole, label: string) => {
    if (songEditions(label).size) return whole
    const performer = label.replace(/(?:版本|版)$/u, '').trim()
    return /版$/u.test(label) && performerHints.some(a => songTextIdentity(a) === songTextIdentity(performer)) ? '' : whole
  }).replace(/\s+/g, ' ').trim()
  const queries = songQueries({title, artist: artists[0] || '', source: {uploaderName:input.uploaderName}})
  const titles = [...new Set([...queries.map(q => coreSongTitle(primarySongTitle(q.title))), ...(input.aliases || []).filter(a => !/电视剧|影视|主题曲|片头曲|片尾曲|插曲|\bOST\b/iu.test(a)).map(a => coreSongTitle(primarySongTitle(a)))].filter(Boolean))]
  return {titles, artists:artists.length ? artists : [...new Set(queries.map(q=>q.artist).filter(Boolean))], editions:songEditions(title), queries}
}
