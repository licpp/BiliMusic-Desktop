export function CommentBody({ body, emotes }: { body: string; emotes?: Record<string, string> }) {
  if (!emotes) return body
  return body.split(/(\[[^\[\]\n]{1,80}\])/gu).map((text, index) => {
    const url = Object.hasOwn(emotes, text) ? emotes[text] : undefined
    return url ? <img key={index} className="comment-emote" src={url} alt={text} title={text} loading="lazy" referrerPolicy="no-referrer" /> : text
  })
}
