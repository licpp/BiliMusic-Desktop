export function publicationDate(seconds?: number) {
  if (!seconds || !Number.isFinite(seconds) || seconds <= 0) return
  const date = new Date(seconds * 1000)
  if (!Number.isFinite(date.getTime())) return
  return { iso: date.toISOString(), label: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` }
}

export function PublishedDate({ value }: { value?: number }) {
  const date = publicationDate(value)
  return date ? <time className="published-date" dateTime={date.iso} title={`发布于 ${date.label}`} aria-label={`发布于 ${date.label}`}>{date.label}</time> : null
}
