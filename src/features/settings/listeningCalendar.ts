const dayKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`

export function listeningCalendar(year: number, daily: { day: string; seconds: number }[], today: string) {
  const values = new Map(daily.map(d => [d.day, d.seconds]))
  const first = new Date(Date.UTC(year, 0, 1)), end = new Date(Date.UTC(year + 1, 0, 1))
  const offset = (first.getUTCDay() + 6) % 7
  first.setUTCDate(first.getUTCDate() - offset)
  const count = Math.ceil((end.getTime() - first.getTime()) / 86400000 / 7) * 7
  return Array.from({ length: count }, (_, i) => {
    const date = new Date(first.getTime() + i * 86400000), key = dayKey(date), seconds = values.get(key) || 0
    const outside = date.getUTCFullYear() !== year, future = key > today
    return { key, date, seconds, outside, future, level: seconds <= 0 ? 0 : seconds < 900 ? 1 : seconds < 3600 ? 2 : seconds < 10800 ? 3 : 4 }
  })
}

