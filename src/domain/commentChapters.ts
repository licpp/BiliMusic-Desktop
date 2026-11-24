import type { BiliComment } from './comments'

export type CommentChapter = { startMs: number; title: string }
export type CommentChapterCandidate = CommentChapter & { author?: string }
export const MAX_COMMENT_CHAPTERS = 200
export const MAX_COMMENT_CHAPTER_TITLE = 160

const listPrefix = /^(?:[•·*+▶▷◆]\s*|[\-–—]\s+|[0-9]{1,3}[.．、)]\s*|[（(][0-9]{1,3}[）)]\s*)/u
const spacedNumberPrefix = /^[0-9]{1,3}\s+(?:[-–—]\s*)?/u
const timelineHeading = /^(?:[【\[]\s*)?(?:时间[轴线表]|播放列表|曲目(?:表|清单)?|歌单|目录|章节)\s*(?:[:：]|[】\]]\s*[:：]?)\s*/u
const personalBookmark = /^(?:自留\s*(?:看到|听到|进度)?|(?:记|留|存)个进度|(?:看到|听到)(?:这里|这儿))$/u
const timeFields = '[0-9]{1,5}:[0-5][0-9](?::[0-5][0-9])?'
const exactTime = new RegExp(`^${timeFields}(?:\\.([0-9]{1,3}))?$`)
const timeToken = new RegExp(`${timeFields}(?:\\.[0-9]{1,3})?(?![0-9]|[.:][0-9:.])`, 'gu')
const timeBrackets: Readonly<Record<string, string>> = { '[': ']', '［': '］', '【': '】', '〖': '〗', '(': ')', '（': '）' }
type TimeMark = { start: number; end: number; startMs: number }

function normalizeTime(text: string) {
  return text.replace(/[０-９：．]/gu, char => char.normalize('NFKC'))
}

export function parseChapterTime(value: string): number | undefined {
  const text = normalizeTime(value.trim())
  const match = exactTime.exec(text)
  if (!match) return undefined
  const parts = text.split('.')[0].split(':')
  if (parts.length === 3 && Number(parts[1]) >= 60) return undefined
  return parts.reduce((seconds, part) => seconds * 60 + Number(part), 0) * 1000 + Number((match[1] ?? '').padEnd(3, '0'))
}

function timeMarks(line: string): TimeMark[] {
  const text = normalizeTime(line)
  const marks: TimeMark[] = []
  for (const match of text.matchAll(timeToken)) {
    const offset = match.index
    const before = text[offset - 1] ?? ''
    const ordinal = before === '.' && /(?:^|\s)([0-9]{1,3}\.)$/u.exec(text.slice(0, offset))
    if (/[0-9.:/]/u.test(before) && !ordinal) continue
    const startMs = parseChapterTime(match[0])
    if (startMs === undefined) continue
    let start = ordinal ? offset - ordinal[1].length : offset
    let end = offset + match[0].length
    const close = timeBrackets[line[start - 1]]
    if (close && line[end] === close) {
      start--
      end++
    }
    const previous = marks[marks.length - 1]
    if (previous && startMs > previous.startMs && /^\s*[-–—~～至到]\s*$/u.test(line.slice(previous.end, start))) {
      previous.end = end
    } else marks.push({ start, end, startMs })
  }
  return marks
}

function cleanChapterTitle(raw: string, timeAtEnd: boolean) {
  const trimmed = raw.trim()
  const text = trimmed.replace(listPrefix, '')
  return (timeAtEnd && text === trimmed ? text.replace(spacedNumberPrefix, '') : text)
    .replace(/^[\s:：|｜,，、;；\-–—]+|[\s:：|｜,，、;；]+$/gu, '')
    .replace(/^《([^《》]+)》$/u, '$1')
    .replace(/&#(?:0*39|x0*27);|&apos;/giu, "'").replace(/&quot;/gu, '"').replace(/&amp;/gu, '&')
    .trim()
}

function titlesBeforeNumberedTimes(line: string, marks: readonly TimeMark[]) {
  if (marks.length < 2) return undefined
  // Some pinned tracklists start immediately after an introduction and finish
  // with a remark. The successive numbers delimit titles in that format.
  const first = /(?:^|[\s:：)）\]】〗])([0-9]{1,3})[.．、)]\s*(.+)$/u.exec(line.slice(0, marks[0].start))
  if (!first) return undefined
  const startNumber = Number(first[1])
  const titles = [first[2]]
  for (let index = 1; index < marks.length; index++) {
    const between = line.slice(marks[index - 1].end, marks[index].start)
    const nextPrefix = new RegExp(`^[\\s,，、;；]*0*${startNumber + index}[.．、)]\\s*(.+)$`, 'u')
    const match = nextPrefix.exec(between)
    if (!match) return undefined
    titles.push(match[1])
  }
  return titles
}

export function parseCommentChapters(message: string, durationSeconds: number): CommentChapter[] {
  if (!(durationSeconds > 0 && Number.isFinite(durationSeconds))) return []
  const rows: CommentChapter[] = []
  const body = message.replace(/^(?:回复\s*)?@[^\s:：]+\s*[:：]\s*/u, '')
  for (const rawLine of body.split(/\r?\n/u)) {
    const line = rawLine.trim().replace(timelineHeading, '')
    if (/https?:\/\//iu.test(line)) continue
    const marks = timeMarks(line)
    if (!marks.length) continue
    const before = line.slice(0, marks[0].start)
    const tail = line.slice(marks[marks.length - 1].end)
    const numbered = titlesBeforeNumberedTimes(line, marks)
    const timeAtEnd = Boolean(numbered || (!cleanChapterTitle(tail, false) && cleanChapterTitle(before, true)))
    if (!timeAtEnd && cleanChapterTitle(before, false)) continue
    marks.forEach(({ startMs, start, end }, index) => {
      if (startMs >= durationSeconds * 1000) return
      const raw = numbered?.[index] ?? (timeAtEnd
        ? line.slice(index ? marks[index - 1].end : 0, start)
        : line.slice(end, marks[index + 1]?.start))
      const title = cleanChapterTitle(raw, timeAtEnd && !numbered)
      if (title) rows.push({ startMs, title: Array.from(title).slice(0, MAX_COMMENT_CHAPTER_TITLE).join('') })
    })
  }
  return rows.length === 1 && personalBookmark.test(rows[0].title) ? [] : rows
}

function orderedChapterStarts(rows: readonly CommentChapter[]) {
  const distinct = [...new Set(rows.map(row => row.startMs))]
  return distinct.every((time, index) => index === 0 || time > distinct[index - 1]) ? distinct : []
}

export function isCommentChapterList(message: string, durationSeconds: number) {
  return orderedChapterStarts(parseCommentChapters(message, durationSeconds)).length >= 3
}

export function isCommentThreadChapterList(root: BiliComment, replies: readonly BiliComment[], durationSeconds: number) {
  const timestamps = new Set<number>()
  for (const comment of flattenCommentThread(root, replies)) {
    for (const time of orderedChapterStarts(parseCommentChapters(comment.message, durationSeconds))) timestamps.add(time)
    if (timestamps.size >= 3) return true
  }
  return false
}

export const commentId = (comment: BiliComment) => comment.idText ?? String(comment.id)
export const commentRootId = (comment: BiliComment) => comment.rootIdText ?? String(comment.rootId)

export function flattenCommentThread(root: BiliComment, replies: readonly BiliComment[]): BiliComment[] {
  const rootId = commentRootId(root)
  const thread = new Map([[commentId(root), root]])
  const pending = [...root.replies, ...replies.filter(reply => commentRootId(reply) === rootId)]
  // Embedded replies already belong to their parent; fetched top-level replies must identify this floor.
  const expanded = new WeakSet<BiliComment>()
  for (let index = 0; index < pending.length; index++) {
    const reply = pending[index]
    if (expanded.has(reply)) continue
    expanded.add(reply)
    const id = commentId(reply)
    if (id !== commentId(root) && !thread.has(id)) thread.set(id, reply)
    pending.push(...reply.replies)
  }
  // Prefer a paged copy of a reply if both an embedded preview and the full reply exist.
  for (const reply of replies) {
    const id = commentId(reply)
    if (id !== commentId(root) && commentRootId(reply) === rootId) thread.set(id, reply)
  }
  return [...thread.values()]
}

export function commentChapterCandidates(root: BiliComment, replies: readonly BiliComment[], durationSeconds: number): CommentChapterCandidate[] {
  const unique = new Map<string, CommentChapterCandidate>()
  for (const comment of flattenCommentThread(root, replies)) {
    for (const row of parseCommentChapters(comment.message, durationSeconds)) {
      const key = `${row.startMs}:${row.title.normalize('NFC')}`
      if (!unique.has(key)) unique.set(key, { ...row, author: comment.userName })
    }
  }
  return [...unique.values()].sort((a, b) => a.startMs - b.startMs)
}
