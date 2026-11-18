export type CommentSegment = { text: string; timestamp?: number }

export function commentTimeline(message: string, duration: number): CommentSegment[] {
  if (!(duration > 0)) return [{ text: message }]
  const segments: CommentSegment[] = []
  let end = 0
  // Keep URL fragments, longer clock expressions and digit runs as ordinary text.
  for (const match of message.matchAll(/([^\s]*https?:\/\/\S+)|(^|[^0-9:/：])([0-9]{1,3}:[0-5][0-9](?::[0-5][0-9])?)(?![0-9:/：])/gu)) {
    if (!match[3]) continue
    const seconds = match[3].split(':').reduce((sum, field) => sum * 60 + Number(field), 0)
    if (seconds >= duration) continue
    const start = match.index + match[2].length
    if (start > end) segments.push({ text: message.slice(end, start) })
    segments.push({ text: match[3], timestamp: seconds })
    end = start + match[3].length
  }
  if (end < message.length) segments.push({ text: message.slice(end) })
  return segments
}
