import { Fragment } from 'react'
import { commentTimeline } from '../../domain/commentTimeline'

export function CommentBody({ body, emotes, timeline }: { body: string; emotes?: Record<string, string>; timeline?: { duration: number; seek: (seconds: number) => void } }) {
  return body.split(/(\[[^\[\]\n]{1,80}\])/gu).map((text, index) => {
    const url = emotes && Object.hasOwn(emotes, text) ? emotes[text] : undefined
    if (url) return <img key={index} className="comment-emote" src={url} alt={text} title={text} loading="lazy" referrerPolicy="no-referrer" />
    if (!timeline) return text
    return <Fragment key={index}>{commentTimeline(text, timeline.duration).map(({ text, timestamp }, i) => timestamp === undefined ? text :
      <button type="button" key={i} className="comment-timestamp" aria-label={`跳转到 ${text}`} onClick={event => { event.stopPropagation(); timeline.seek(timestamp) }}>{text}</button>)}</Fragment>
  })
}
