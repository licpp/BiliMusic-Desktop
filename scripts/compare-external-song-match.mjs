// Local, offline comparison. Input contains public metadata collected with permission.
// No API keys, network calls, or user-library mutations happen in this script.
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(process.argv[2] || 'artifacts/playlist-match-sm0ker')
const { outputFiles } = await build({ entryPoints: ['src/services/externalSongMatch.ts'], bundle: true, write: false, format: 'esm' })
const { rankSongCandidates, scoreSongCandidate, rankDurationFirstSongCandidates } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
const read = async name => JSON.parse(await readFile(resolve(root, name), 'utf8'))
const cases = await read('search-cases.json'), details = await read('video-details.json')
const prepared = cases.map((item, index) => {
  // Primary and optional fallback searches use the same candidate pool for all methods.
  const entries = [...item.candidates.slice(0, 8), ...(item.fallback?.candidates || []).slice(0, 8)]
  const seen = new Set()
  const candidates = entries.flatMap(entry => {
    const video = details[entry.bvid]
    if (!video || seen.has(entry.bvid)) return []
    seen.add(entry.bvid)
    let parts = video.pages.map(part => ({
      bvid: video.bvid, cid: part.cid, title: video.pages.length === 1 ? video.title : part.title,
      videoTitle: video.title, partTitle: part.title, uploaderName: video.uploaderName, durationSeconds: part.durationSeconds,
      detailsVerified: true, partCount: video.pages.length, playCount: video.playCount,
      description: video.description.slice(0, 200),
    }))
    if (parts.length > 12) {
      parts = parts.sort((a, b) => scoreSongCandidate(item.source, b).score - scoreSongCandidate(item.source, a).score
        || Math.abs(a.durationSeconds - item.source.durationSeconds) - Math.abs(b.durationSeconds - item.source.durationSeconds)).slice(0, 3)
    }
    return parts
  }).map((candidate, candidateIndex) => ({ ...candidate, candidateId: `${index + 1}-${candidateIndex + 1}` }))
  const duration = [...candidates].sort((a, b) => Math.abs(a.durationSeconds - item.source.durationSeconds) - Math.abs(b.durationSeconds - item.source.durationSeconds))[0]
  const rules = rankSongCandidates(item.source, candidates)
  const revised = rankDurationFirstSongCandidates(item.source, candidates)
  return { source: item.source, candidates, durationChoice: duration?.candidateId || null,
    ruleChoice: rules.ranked[0]?.candidate.candidateId || null, ruleDecision: rules.decision,
    ruleReasons: rules.ranked[0]?.reasons || [], ruleMargin: rules.margin,
    revisedChoice: revised.ranked[0]?.candidate.candidateId || null, revisedDecision: revised.decision }
})
await writeFile(resolve(root, 'prepared-cases.json'), JSON.stringify(prepared, null, 2))
await writeFile(resolve(root, 'llm-input.json'), JSON.stringify(prepared.map(({ source, candidates }) => ({
  source, candidates: candidates.map(({ candidateId, title, videoTitle, partTitle, uploaderName, durationSeconds, partCount, description }) => ({ candidateId, title, videoTitle, partTitle, uploaderName, durationSeconds, partCount, description })),
})), null, 2))
let llm
try { llm = await read('deepseek-result.json') } catch {}
const summarize = (item, id) => {
  const candidate = item.candidates.find(candidate => candidate.candidateId === id)
  return candidate ? { id, bvid: candidate.bvid, cid: candidate.cid, title: candidate.title,
    durationSeconds: candidate.durationSeconds, differenceSeconds: Number(Math.abs(candidate.durationSeconds - item.source.durationSeconds).toFixed(3)) } : null
}
const results = prepared.map(item => {
  const chosen = llm?.result?.results?.find(result => String(result.sourceId) === String(item.source.sourceId))
  return { source: item.source, candidateCount: item.candidates.length,
    duration: summarize(item, item.durationChoice), rules: summarize(item, item.ruleChoice), ruleDecision: item.ruleDecision,
    ruleReasons: item.ruleReasons, deepseek: summarize(item, chosen?.candidateId), llmDecision: chosen || null,
    revised: summarize(item, item.revisedChoice), revisedDecision: item.revisedDecision,
    invalidLlmId: Boolean(chosen?.candidateId && !item.candidates.some(candidate => candidate.candidateId === chosen.candidateId)) }
})
await writeFile(resolve(root, 'comparison.json'), JSON.stringify(results, null, 2))
console.log(JSON.stringify(results, null, 2))
