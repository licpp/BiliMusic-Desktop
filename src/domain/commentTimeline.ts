export type CommentSegment = { text: string; timestamp?: number }

export function commentTimeline(message: string, duration: number): CommentSegment[] {
  if (!(duration > 0)) return [{ text: message }]
  // Match fullwidth timecodes without changing what the comment displays.
  const normalized = message.replace(/[０-９：]/gu, character => character.normalize('NFKC'))
  const segments: CommentSegment[] = []
  let end = 0
  // Keep URL fragments, longer clock expressions and digit runs as ordinary text.
  for (const match of normalized.matchAll(/([^\s]*https?:\/\/\S+)|(^|[^0-9:/])([0-9]{1,3}:[0-5][0-9](?::[0-5][0-9])?)(?![0-9:/])/gu)) {
    if (!match[3]) continue
    const seconds = match[3].split(':').reduce((sum, field) => sum * 60 + Number(field), 0)
    if (seconds >= duration) continue
    const start = match.index + match[2].length
    if (start > end) segments.push({ text: message.slice(end, start) })
    end = start + match[3].length
    segments.push({ text: message.slice(start, end), timestamp: seconds })
  }
  if (end < message.length) segments.push({ text: message.slice(end) })
  return segments
}
