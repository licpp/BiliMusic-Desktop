/** External playlist matching prototype. No requests or library writes happen here.
 * Scores rank evidence; they are not calibrated probabilities. Only resolved parts
 * can be automatically selected. The importer must let users review every choice.
 */
export type ExternalSong = {
  title: string
  artists: string[]
  aliases?: string[]
  durationSeconds?: number
}

export type SongCandidate = {
  bvid: string
  cid?: number
  title: string
  videoTitle?: string
  partTitle?: string
  description?: string
  uploaderName?: string
  durationSeconds?: number
  partCount?: number
  /** True only after fetching video detail, never inferred from search duration. */
  detailsVerified?: boolean
  playCount?: number
}

type Edition = 'live' | 'cover' | 'instrumental' | 'remix' | 'sped' | 'slowed' | 'remastered' | 'acoustic' | 'short' | 'cantonese' | 'mandarin'
const editions: Record<Edition, RegExp> = {
  live: /现场|演唱会|音乐会|\b(?:live|concert|the first take)\b/iu,
  cover: /翻唱|翻弹|\bcover(?:ed)?\b/iu,
  instrumental: /伴奏|纯音乐|无人声|\b(?:instrumental|off[ -]?vocal|karaoke|inst)\b\.?/iu,
  remix: /混音|重混|\b(?:remix|dj)\b/iu,
  sped: /加速|\b(?:sped[ -]?up|nightcore)\b/iu,
  slowed: /降速|慢速|\bslowed\b/iu,
  remastered: /重制|重置|\bremaster(?:ed)?\b/iu,
  acoustic: /不插电|\bacoustic\b/iu,
  short: /片段|剪辑版|\b(?:short ver|tv size|tvサイズ)\b/iu,
  cantonese: /粤语|粵語|\bcantonese\b/iu,
  mandarin: /国语|國語|普通话|\bmandarin\b/iu,
}

function readable(text: string): string {
  return text.replace(/<[^>]*>/g, ' ').replace(/&#(x[\da-f]+|\d+);/gi, (_, code: string) => {
    const value = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code)
    return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : ' '
  }).replace(/&(?:amp|quot|apos|lt|gt|nbsp);/gi, entity => ({
    '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>', '&nbsp;': ' ',
  })[entity.toLowerCase()] || ' ').normalize('NFKC').toLowerCase()
}

function words(text: string): string {
  return readable(text).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ')
}
const compact = (text: string) => words(text).replace(/ /g, '')
function core(text: string): string {
  return readable(text)
    .replace(/[（(【\[]([^）)】\]]*)[）)】\]]/gu, (whole, label: string) =>
      Object.values(editions).some(pattern => pattern.test(label)) || /^(?:official\s*)?(?:mv|audio|lyrics?|video)|官方|无损|音质|字幕|\b[248]k\b/iu.test(label) ? ' ' : whole)
    .replace(/(?:\b(?:live|remix|instrumental|karaoke|cover|sped[ -]?up|slowed)\b|现场版|演唱会版|伴奏版|翻唱版|加速版|降速版)/giu, ' ').trim()
}
function containsTitle(candidate: string, title: string): boolean {
  const phrase = words(title)
  if (!phrase) return false
  // Latin titles must match whole words: “Star” must not match “Starlight”.
  if (/^[\x00-\x7f]+$/.test(phrase)) return ` ${words(candidate)} `.includes(` ${phrase} `)
  return compact(candidate).includes(compact(title))
}
function similarity(a: string, b: string): number {
  // Fuzzy matches are review-only. Cap input to keep batch matching bounded.
  const left = [...compact(a)].slice(0, 160), right = [...compact(b)].slice(0, 160)
  if (!left.length || !right.length) return 0
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i)
  left.forEach((letter, i) => {
    const row = [i + 1]
    right.forEach((other, j) => row.push(Math.min(row[j] + 1, previous[j + 1] + 1, previous[j] + (letter === other ? 0 : 1))))
    previous = row
  })
  return 1 - previous[right.length] / Math.max(left.length, right.length)
}
const artistPresent = (text: string, artist: string) => containsTitle(text, artist)
const editionSet = (text: string) => new Set((Object.keys(editions) as Edition[]).filter(key => editions[key].test(readable(text))))

export type ScoredSongCandidate = {
  candidate: SongCandidate
  score: number
  titleEvidence: 'exact' | 'alias' | 'fuzzy' | 'none'
  reasons: string[]
  automaticEligible: boolean
  /** Upper bound for unresolved evidence; do not mistake missing detail for a losing candidate. */
  possibleScoreAfterDetails: number
}

export function scoreSongCandidate(song: ExternalSong, candidate: SongCandidate): ScoredSongCandidate {
  const reasons: string[] = []
  const mainTitle = core(song.title), candidateTitle = core(candidate.title)
  const artists = song.artists.map(value => value.trim()).filter(Boolean)
  let fuzzyTitle = candidateTitle
  for (const artist of artists) fuzzyTitle = fuzzyTitle.split(readable(artist)).join(' ')
  // The parent BV title is artist/version context, never proof that every part is this song.
  let titleEvidence: ScoredSongCandidate['titleEvidence'] = 'none'
  let score = 0
  if (containsTitle(candidateTitle, mainTitle)) { titleEvidence = 'exact'; score = 50 }
  else if (song.aliases?.some(alias => containsTitle(candidateTitle, core(alias)))) { titleEvidence = 'alias'; score = 46 }
  else if (similarity(mainTitle, fuzzyTitle) >= 0.78) { titleEvidence = 'fuzzy'; score = 30 }
  if (titleEvidence === 'none') return { candidate, score: 0, titleEvidence, reasons: ['曲名不符'], automaticEligible: false, possibleScoreAfterDetails: 0 }
  reasons.push(titleEvidence === 'exact' ? '曲名一致' : titleEvidence === 'alias' ? '来源别名一致' : '曲名近似，需确认')
  const context = `${candidate.title} ${candidate.videoTitle || ''}`
  const artistHits = artists.filter(artist => artistPresent(context, artist))
  if (artists.length && artistHits.length === artists.length) { score += 25; reasons.push('标题包含全部歌手') }
  else if (artistHits.length) { score += 20; reasons.push('标题包含部分歌手') }
  else if (artists.some(artist => artistPresent(candidate.uploaderName || '', artist))) {
    score += 4; reasons.push('仅 UP 主名称相符，不能确认歌手')
  } else reasons.push('缺少歌手证据')

  const wanted = editionSet(song.title), actual = editionSet(context)
  const versionConflict = [...new Set([...wanted, ...actual])].some(key => wanted.has(key) !== actual.has(key))
  if (versionConflict) { score -= 30; reasons.push('原唱 / 现场 / 翻唱等版本不一致') }
  else { score += 5; reasons.push('未发现版本冲突') }

  const duration = song.durationSeconds || 0, actualDuration = candidate.durationSeconds || 0
  // Multi-part BV search duration is the whole video, not a playable part.
  const partDuration = candidate.detailsVerified || candidate.partCount === 1
  const delta = Math.abs(duration - actualDuration)
  let durationClose = false, durationConflict = false
  if (duration > 0 && actualDuration > 0 && partDuration) {
    if (delta <= Math.max(5, duration * 0.03)) { score += 20; durationClose = true; reasons.push('时长接近') }
    else if (delta <= Math.max(12, duration * 0.06)) { score += 12; reasons.push('时长略有差异') }
    else if (delta <= Math.max(30, duration * 0.1)) { score += 6; reasons.push('时长需确认') }
    else { durationConflict = true; score -= 20; reasons.push('时长差异较大') }
  } else reasons.push('尚无可用的分 P 时长')
  const verified = candidate.detailsVerified === true && Boolean(candidate.cid && candidate.cid > 0)
    && Number.isInteger(candidate.partCount) && (candidate.partCount || 0) >= 1
  if (!verified) reasons.push('需要获取视频详情确认分 P')
  const shortTitle = compact(mainTitle).length <= 2
  const shortTitleClear = !shortTitle || compact(candidateTitle) === compact(mainTitle)
    || [`《${mainTitle}》`, `「${mainTitle}」`, `“${mainTitle}”`].some(label => readable(candidate.title).includes(label))
  if (!shortTitleClear) reasons.push('短曲名容易撞名，需确认')
  const identityClear = titleEvidence !== 'fuzzy' && artists.length > 0 && artistHits.length === artists.length
    && !versionConflict && shortTitleClear
  return {
    candidate, score: Math.max(0, Math.min(100, score)), titleEvidence, reasons,
    automaticEligible: verified && identityClear && durationClose && !durationConflict,
    possibleScoreAfterDetails: !verified && identityClear && duration > 0 ? (titleEvidence === 'alias' ? 96 : 100) : 0,
  }
}

export function rankSongCandidates(song: ExternalSong, candidates: SongCandidate[]) {
  const unique = new Map<string, SongCandidate>()
  const resolvedBvids = new Set(candidates.filter(item => item.detailsVerified).map(item => item.bvid))
  for (const candidate of candidates) {
    if (!candidate.detailsVerified && resolvedBvids.has(candidate.bvid)) continue
    const key = `${candidate.bvid}:${candidate.cid || 'unresolved'}`
    const previous = unique.get(key)
    if (!previous || (!previous.detailsVerified && candidate.detailsVerified)) unique.set(key, candidate)
  }
  const ranked = [...unique.values()].map(candidate => scoreSongCandidate(song, candidate))
    .filter(item => item.titleEvidence !== 'none')
    // Play count is only a stable tie-breaker, never confidence evidence.
    .sort((a, b) => b.score - a.score || (b.candidate.playCount || 0) - (a.candidate.playCount || 0)
      || a.candidate.bvid.localeCompare(b.candidate.bvid) || (a.candidate.cid || 0) - (b.candidate.cid || 0))
  const best = ranked[0]
  const margin = best ? best.score - (ranked[1]?.score || 0) : 0
  const unresolvedCompetitor = ranked.slice(1).some(item => item.possibleScoreAfterDetails >= (best?.score || 0) - 10)
  const decision: 'automatic' | 'review' | 'missing' = !best ? 'missing'
    : best.automaticEligible && best.score >= 88 && margin >= 10 && !unresolvedCompetitor ? 'automatic' : 'review'
  // Caller may inspect up to three BVs; do not issue a detail request for every search result.
  const detailBvids = [...new Set(ranked.filter(item => !item.candidate.detailsVerified && item.score >= 50)
    .map(item => item.candidate.bvid))].slice(0, 3)
  return { decision, margin, ranked, detailBvids }
}

/** Experimental reranker, evaluated separately from the frozen first prototype.
 * Duration is continuous and dominant AFTER a title match. This is not an audio
 * fingerprint: equally long covers and undocumented live editions remain possible.
 */
export function rankDurationFirstSongCandidates(song: ExternalSong, candidates: SongCandidate[]) {
  const primary = song.title.replace(/[（(]([^）)]*)[）)]/gu, (whole, label: string) => {
    const bilingual = /\p{Script=Han}/u.test(song.title.replace(whole, '')) && /^[\x00-\x7f\s]+$/.test(label)
    return bilingual || /^\s*(?:feat\.?|ft\.?|featuring)\s/iu.test(label) ? ' ' : whole
  }).trim()
  const source = { ...song, aliases: [...(song.aliases || []).filter(alias=>!/电视剧|影视|主题曲|片头曲|片尾曲|插曲|\bOST\b/iu.test(alias)), ...(primary !== song.title ? [primary] : [])] }
  const titleContext = (candidate: SongCandidate) => `${candidate.title} ${candidate.videoTitle || ''}`
  const artists = song.artists.map(artist => artist.trim()).filter(Boolean)
  const unwantedCapture = /录音棚大声听|车载|车内|音响|外放|音箱|领克\s*\d|指弹|小提琴|钢琴版|\breaction\b|教学|教程/iu
  const ranked = rankSongCandidates(source, candidates).ranked.map(evidence => {
    const candidate = evidence.candidate
    const actual = candidate.detailsVerified || candidate.partCount === 1 ? candidate.durationSeconds || 0 : 0
    const duration = song.durationSeconds || 0
    const delta = actual > 0 && duration > 0 ? Math.abs(actual - duration) : undefined
    // A one-second dead zone accommodates integer-second Bilibili durations.
    const sigma = Math.max(2, duration * 0.01)
    const durationScore = delta === undefined ? 0 : 55 * Math.exp(-0.5 * (Math.max(0, delta - 1) / sigma) ** 2)
    const artistHits = artists.filter(artist => artistPresent(titleContext(candidate), artist)).length
    const artistScore = artists.length && artistHits === artists.length ? 15 : artistHits ? 10 : 0
    const titleScore = evidence.titleEvidence === 'exact' ? 25 : evidence.titleEvidence === 'alias' ? 24 : 10
    const wanted = editionSet(song.title), actualEdition = editionSet(titleContext(candidate))
    const versionConflict = [...new Set([...wanted, ...actualEdition])].some(key => wanted.has(key) !== actualEdition.has(key))
    const capturePenalty = unwantedCapture.test(`${titleContext(candidate)} ${candidate.description || ''}`) && !unwantedCapture.test(song.title) ? 20 : 0
    return { ...evidence, score: Math.max(0, durationScore + artistScore + titleScore + 5 - capturePenalty - (versionConflict ? 70 : 0)),
      durationDifference: delta, durationScore, capturePenalty, versionConflict }
  }).sort((a, b) => b.score - a.score || (a.durationDifference ?? Infinity) - (b.durationDifference ?? Infinity))
  const best = ranked[0], margin = best ? best.score - (ranked[1]?.score || 0) : 0
  const unresolvedCompetitor = ranked.slice(1).some(item => !item.candidate.detailsVerified && item.possibleScoreAfterDetails > 0)
  const decision: 'automatic' | 'review' | 'missing' = !best ? 'missing'
    : best.automaticEligible && best.capturePenalty === 0 && best.score >= 85 && margin >= 10 && !unresolvedCompetitor ? 'automatic' : 'review'
  return { ranked, decision, margin }
}
