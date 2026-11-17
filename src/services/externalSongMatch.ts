import { coreSongTitle as core, containsSongTitle as containsTitle, songEditSimilarity as similarity, readableSongText as readable, songTextIdentity as compact, songVersionConflict, primarySongTitle, recognizeSong } from '../domain/songIdentity'
/** Pure ranking evidence. Import acceptance is separate from manual search;
 * resolved BVID/CID is always required before a selection can be stored. */
export type { ExternalSong } from '../domain/songIdentity'
import type { ExternalSong } from '../domain/songIdentity'

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
  const artistHits = artists.filter(artist => containsTitle(context, artist))
  if (artists.length && artistHits.length === artists.length) { score += 25; reasons.push('标题包含全部歌手') }
  else if (artistHits.length) { score += 20; reasons.push('标题包含部分歌手') }
  else if (artists.some(artist => containsTitle(candidate.uploaderName || '', artist))) {
    score += 4; reasons.push('仅 UP 主名称相符，不能确认歌手')
  } else reasons.push('缺少歌手证据')

  const versionConflict = songVersionConflict(song.title, context)
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

/** Frozen baseline evaluator retained for comparative regression fixtures.
 * Production import acceptance uses rankImportSongCandidates below. */
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

/** Import ranking uses shared identities. Duration and popularity refine a
 * relevant result; neither can turn a different song/edition into a match. */
export function rankImportSongCandidates(song: ExternalSong, candidates: SongCandidate[]) {
  const source = recognizeSong(song)
  const artists = source.artists
  const unique = new Map<string, SongCandidate>()
  const resolved = new Set(candidates.filter(c=>c.detailsVerified).map(c=>c.bvid))
  for (const c of candidates) {
    if (!c.detailsVerified && resolved.has(c.bvid)) continue
    const key = `${c.bvid}:${c.cid || 'unresolved'}`
    if (!unique.has(key) || c.detailsVerified) unique.set(key,c)
  }
  const ranked = [...unique.values()].flatMap(candidate => {
    // For a verified multi-part BV only the selected part proves the song name.
    const title = candidate.partTitle && (candidate.partCount || 0) > 1 ? candidate.partTitle : candidate.title
    const identity = recognizeSong({title, artistHints:artists, uploaderName:candidate.uploaderName})
    const context = `${title} ${candidate.videoTitle || ''}`
    const exact = source.titles.some(wanted=>identity.titles.some(actual=>containsTitle(actual,wanted)))
    const fuzzy = Math.max(0,...source.titles.flatMap(wanted=>identity.titles.map(actual=>similarity(wanted,actual)))) >= .84
    const titleEvidence: ScoredSongCandidate['titleEvidence'] = exact ? 'exact' : fuzzy ? 'fuzzy' : 'none'
    if (titleEvidence === 'none') return []
    const artistHits = artists.filter(artist=>containsTitle(context,artist) || identity.artists.some(a=>compact(a)===compact(artist))).length
    const explicitArtists=identity.queries.filter(q=>source.titles.some(t=>containsTitle(core(q.title),t))).map(q=>q.artist).filter(Boolean)
    const artistConflict=artists.length>0 && explicitArtists.length>0 && artistHits===0
    const versionConflict = songVersionConflict(song.title, context)
    const actual = candidate.detailsVerified ? candidate.durationSeconds || 0 : 0
    const duration = song.durationSeconds || 0
    const delta = actual > 0 && duration > 0 ? Math.abs(actual-duration) : undefined
    const sigma = Math.max(12,duration*.08)
    const durationScore = delta === undefined ? 0 : 8*Math.exp(-.5*(Math.max(0,delta-2)/sigma)**2)
    const artistScore = artists.length && artistHits===artists.length ? 24 : artistHits ? 19 : 0
    // A recording-room presentation can be the most useful upload. Its title
    // format is not evidence of a wrong song or a low-quality source.
    const capturePenalty = /录屏|屏幕录制|\bscreen\s*record/iu.test(title) ? 4
      : /麦克风.{0,12}(?:现场收录|收音)|外放录制/iu.test(candidate.description || '') ? 1 : 0
    const plays = Number.isFinite(candidate.playCount) ? Math.max(0,candidate.playCount || 0) : 0
    const popularityScore = Math.min(12,Math.log10(1+plays)*2)
    const publicationScore = artistHits > 0 && /官方|\bofficial\b|\bMV\b|音乐录影带/iu.test(title) ? 2 : 0
    const verified = candidate.detailsVerified === true && Number.isSafeInteger(candidate.cid) && (candidate.cid || 0)>0
    const quotes=[...title.matchAll(/《([^《》]+)》|「([^「」]+)」|“([^“”]+)”/g)]
    const quotedSongs = new Set(quotes.filter(match => !/(?:动画|動漫|动漫|番剧|电影|電影|电视剧|電視劇|游戏|遊戲|漫画|專輯|专辑)[\s:：]*$/u.test(title.slice(Math.max(0,(match.index||0)-12),match.index)))
      .map(match=>compact(match[1]||match[2]||match[3])))
    const medley = quotedSongs.size>1 || /串烧|连唱|\b(?:medley|mashup)\b/iu.test(title) && !/串烧|连唱|\b(?:medley|mashup)\b/iu.test(song.title)
    const giantDurationConflict = delta !== undefined && delta > Math.max(45,duration*.3)
    const titleSize = Math.max(0,...source.titles.map(t=>compact(t).length))
    const strongIdentity = artistHits>0 || (titleSize>4 && delta !== undefined && delta<=Math.max(15,duration*.08))
    const shortClear = titleSize>2 || identity.titles.some(actual=>source.titles.some(t=>compact(actual)===compact(t))) || /[《「“]/.test(title)
    const score = Math.max(0,(exact?50:32)+artistScore+durationScore+popularityScore+publicationScore-capturePenalty-(versionConflict?70:0)-(giantDurationConflict?35:0)-(artistConflict?40:0))
    const reasons = [exact?'曲名一致':'曲名近似',artistHits?'歌手相符':'缺少歌手证据',...(versionConflict?['版本不一致']:[]),...(artistConflict?['歌手不一致']:[]),...(giantDurationConflict?['时长差异较大']:[])]
    return [{candidate,score,titleEvidence,reasons,automaticEligible:verified && exact && strongIdentity && shortClear && !versionConflict && !artistConflict && !medley && !giantDurationConflict,
      possibleScoreAfterDetails:!verified && exact && !versionConflict?100:0,durationDifference:delta,durationScore,capturePenalty,versionConflict,popularityScore}]
  }).sort((a,b)=>Number(b.automaticEligible)-Number(a.automaticEligible) || b.score-a.score || (a.durationDifference??Infinity)-(b.durationDifference??Infinity) || a.candidate.bvid.localeCompare(b.candidate.bvid) || (a.candidate.cid||0)-(b.candidate.cid||0))
  const best=ranked[0], margin=best?best.score-(ranked[1]?.score||0):0
  const unresolvedCompetitor=ranked.slice(1).some(c=>!c.candidate.detailsVerified&&c.possibleScoreAfterDetails>0)
  const decision:'automatic'|'review'|'missing'=!best?'missing':best.automaticEligible&&!unresolvedCompetitor?'automatic':'review'
  return {ranked,decision,margin}
}

/** Historical export retained for callers/tests; the active ranker is identity-first. */
export const rankDurationFirstSongCandidates = rankImportSongCandidates
