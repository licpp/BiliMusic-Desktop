export function formatDuration(seconds: number, showHours = false) {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor(total / 60) % 60
  const remainder = String(total % 60).padStart(2, '0')
  return hours || showHours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}`
    : `${minutes}:${remainder}`
}

export const formatTrackDuration = (seconds: number) => seconds > 0 ? formatDuration(seconds) : '—'
