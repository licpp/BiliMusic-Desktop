import type { LyricLine } from './lyrics'
import { isLyricCredit, simplifiedLyricText } from './lyricText'

export type LyricAlignment =
  | { ok: true; biasMs: number; matchedLines: number; spreadMs: number }
  | { ok: false; reason: 'insufficient' | 'ambiguous' | 'inconsistent' | 'range' }

type TextLine = { text: string; time: number; index: number }
type Block = { text: string; time: number; start: number; end: number }
type Anchor = { lyric: Block; caption: Block; offset: number; similarity: number; weight: number }
const tolerance = 1200
const normalized = (value: string) => simplifiedLyricText(value.normalize('NFKC')).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

function clean(lines: readonly LyricLine[]): TextLine[] {
  return lines.flatMap((line, index) => {
    if (!Number.isFinite(line.timeMs) || line.timeMs < 0 || isLyricCredit(line.text.normalize('NFKC'))) return []
    const text = normalized(line.text)
    return text.length && text.length <= 240 ? [{ text, time: line.timeMs, index }] : []
  }).sort((a, b) => a.time - b.time)
}

// Adjacent groups handle a sentence split differently by the lyric and ASR
// providers. Never concatenate across an instrumental break or removed credits.
function blocks(lines: TextLine[], maxGap = 7000) {
  const result: Block[] = []
  for (let i = 0; i < lines.length; i++) {
    let text = ''
    for (let size = 1; size <= 3 && i + size <= lines.length; size++) {
      const next = lines[i + size - 1]
      if (size > 1 && (next.index !== lines[i + size - 2].index + 1 || next.time - lines[i + size - 2].time > maxGap)) break
      text += next.text
      if (text.length > 180) break
      if (text.length >= 4) result.push({ text, time: lines[i].time, start: i, end: i + size - 1 })
    }
  }
  return result
}
function grams(text: string) {
  const chars = Array.from(text)
  return new Set(chars.slice(1).map((char, i) => chars[i] + char))
}
function similarity(a: string, b: string) {
  if (a === b) return 1
  if (Math.min(a.length, b.length) / Math.max(a.length, b.length) < .65) return 0
  const left = Array.from(a), right = Array.from(b)
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i)
  for (let i = 0; i < left.length; i++) {
    const row = [i + 1]
    for (let j = 0; j < right.length; j++) row.push(Math.min(row[j] + 1, previous[j + 1] + 1, previous[j] + Number(left[i] !== right[j])))
    previous = row
  }
  return 1 - previous[right.length] / Math.max(left.length, right.length)
}
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

// A text match can occur in several choruses. Require a monotone, nonoverlapping
// sequence, so repeated lines and overlapping groups cannot inflate confidence.
function orderedChain(anchors: Anchor[]) {
  const found = [...anchors].sort((a, b) => a.lyric.end - b.lyric.end || a.caption.end - b.caption.end)
  const scores = new Float64Array(found.length), parents = new Int32Array(found.length).fill(-1)
  let best = -1
  for (let i = 0; i < found.length; i++) {
    scores[i] = found[i].weight
    for (let j = 0; j < i; j++) if (found[j].lyric.end < found[i].lyric.start && found[j].caption.end < found[i].caption.start && scores[j] + found[i].weight > scores[i]) {
      scores[i] = scores[j] + found[i].weight; parents[i] = j
    }
    if (best < 0 || scores[i] > scores[best]) best = i
  }
  const chain: Anchor[] = []
  for (let at = best; at >= 0; at = parents[at]) chain.unshift(found[at])
  return { chain, score: best < 0 ? 0 : scores[best] }
}

function chainAt(anchors: Anchor[], offset: number) {
  let result = orderedChain(anchors.filter(a => Math.abs(a.offset - offset) <= tolerance))
  // A bucket's centre need not be the median of its winning chain. Refit before
  // assessing jitter instead of rejecting the entire song for one edge anchor.
  if (result.chain.length) {
    const centre = median(result.chain.map(a => a.offset))
    result = orderedChain(anchors.filter(a => Math.abs(a.offset - centre) <= tolerance))
  }
  // Refitting can move the median once more. Trim only the edge outliers until
  // the retained evidence agrees with its own centre; a single late ASR onset
  // must not turn otherwise consistent matches into a segment-change error.
  while (result.chain.length) {
    const centre = Math.round(median(result.chain.map(a => a.offset)))
    const chain = result.chain.filter(a => Math.abs(a.offset - centre) <= tolerance)
    if (chain.length === result.chain.length) break
    result = { chain, score: chain.reduce((sum, a) => sum + a.weight, 0) }
  }
  return result
}

function overlaps(a: Block, b: Block) { return a.start <= b.end && b.start <= a.end }

// A repeated chorus matching an earlier occurrence is not a timing change.
// Contradictions must fit between the SAME neighbouring matches on both axes,
// and must not reuse any line already explained by the winning clock.
function conflictingChain(anchors: Anchor[], chain: Anchor[], biasMs: number) {
  const remaining = anchors.filter(a => {
    if (a.similarity < .85 || Math.abs(a.offset - biasMs) <= 2400) return false
    for (const match of chain) {
      if (overlaps(a.lyric, match.lyric) || overlaps(a.caption, match.caption)) return false
      if ((a.lyric.end < match.lyric.start) !== (a.caption.end < match.caption.start)) return false
    }
    return true
  })
  return orderedChain(remaining).chain
}

/** Estimate an absolute offset from the original lyric time axis, never from
 * the current bias. Text/timestamps are read-only, including word timing. */
export function alignLyricTiming(lyrics: readonly LyricLine[], captions: readonly LyricLine[], maxBiasMs = 30_000): LyricAlignment {
  const left = clean(lyrics), right = clean(captions)
  if (left.length < 3 || right.length < 3 || left.length > 600 || right.length > 2000 || new Set(left.map(line => line.text)).size < 2) return { ok: false, reason: 'insufficient' }
  const lyricBlocks = blocks(left, 12000), captionBlocks = blocks(right)
  const index = new Map<string, number[]>()
  captionBlocks.forEach((block, i) => { for (const gram of grams(block.text)) { const rows = index.get(gram) || []; rows.push(i); index.set(gram, rows) } })
  const anchors: Anchor[] = []
  for (const lyric of lyricBlocks) {
    const hits = new Map<number, number>()
    for (const gram of grams(lyric.text)) for (const i of index.get(gram) || []) hits.set(i, (hits.get(i) || 0) + 1)
    // Bound edit-distance work even for long videos with many repeated phrases.
    const shortlist = [...hits].sort((a, b) => b[1] - a[1]).slice(0, 32)
    for (const [i] of shortlist) {
      const caption = captionBlocks[i]
      // Both sides grouped at once adds duplicate evidence without resolving a
      // split; either side may instead match one complete sentence.
      if (lyric.end > lyric.start && caption.end > caption.start) continue
      const score = similarity(lyric.text, caption.text)
      if (score < (Math.min(lyric.text.length, caption.text.length) < 6 ? 1 : .72)) continue
      const offset = caption.time - lyric.time
      if (Math.abs(offset) > 600_000) continue
      anchors.push({ lyric, caption, offset, similarity: score, weight: score * Math.min(lyric.text.length, 24) })
    }
  }
  if (anchors.length < 3) return { ok: false, reason: 'insufficient' }

  // Vote once per lyric start in each timing bucket. Dialogue and short common
  // phrases cannot dominate merely by appearing many times in the subtitles.
  const votes = new Map<number, Map<number, Anchor>>()
  for (const anchor of anchors) {
    const bin = Math.round(anchor.offset / 1000)
    for (const key of [bin - 1, bin, bin + 1]) {
      const rows = votes.get(key) || new Map<number, Anchor>()
      if (!rows.has(anchor.lyric.start) || rows.get(anchor.lyric.start)!.weight < anchor.weight) rows.set(anchor.lyric.start, anchor)
      votes.set(key, rows)
    }
  }
  const peaks = [...votes.values()].map(rows => ({ offset: median([...rows.values()].map(a => a.offset)), score: [...rows.values()].reduce((sum, a) => sum + a.weight, 0) })).sort((a, b) => b.score - a.score)
  const modes: number[] = []
  for (const peak of peaks) if (!modes.some(offset => Math.abs(offset - peak.offset) <= 2400)) { modes.push(peak.offset); if (modes.length === 8) break }
  const results = modes.map(offset => ({ ...chainAt(anchors, offset), offset })).sort((a, b) => b.score - a.score)
  const best = results[0]
  const chain = best.chain
  const distinct = new Set(chain.map(a => a.lyric.text))
  const matched = new Set(chain.flatMap(a => Array.from({ length: a.lyric.end - a.lyric.start + 1 }, (_, i) => a.lyric.start + i)))
  const span = chain.length ? chain.at(-1)!.lyric.time - chain[0].lyric.time : 0
  const characters = chain.reduce((sum, a) => sum + a.lyric.text.length, 0)
  // Long production-credit sections and unreliable ASR must not demand a
  // match for every fifth displayed row. Sparse evidence still needs several
  // distinct phrases and must extend over time, rather than one chorus fragment.
  const varied = distinct.size >= 3 || (distinct.size >= 2 && chain.length >= 5 && span >= 60_000)
  if (chain.length < 3 || !varied || characters < 24 || matched.size < Math.max(3, Math.ceil(left.length * .15)) || span < Math.min(15_000, (left.at(-1)!.time - left[0].time) * .5)) return { ok: false, reason: 'insufficient' }
  const biasMs = Math.round(median(chain.map(a => a.offset)))
  const spreadMs = Math.max(...chain.map(a => Math.abs(a.offset - biasMs)))
  if (spreadMs > tolerance) return { ok: false, reason: 'inconsistent' }
  if (results.some(other => other !== best && other.score >= best.score * .78 && Math.abs(other.offset - biasMs) > 2400)) return { ok: false, reason: 'ambiguous' }

  const conflicts = conflictingChain(anchors, chain, biasMs)
  const conflictCharacters = conflicts.reduce((sum, a) => sum + a.lyric.text.length, 0)
  if (conflicts.length >= 3 && new Set(conflicts.map(a => a.lyric.text)).size >= 3 && conflictCharacters >= 24 && conflicts.reduce((sum, a) => sum + a.weight, 0) >= best.score * .35) return { ok: false, reason: 'inconsistent' }
  if (Math.abs(biasMs) > maxBiasMs) return { ok: false, reason: 'range' }
  return { ok: true, biasMs, matchedLines: matched.size, spreadMs }
}
