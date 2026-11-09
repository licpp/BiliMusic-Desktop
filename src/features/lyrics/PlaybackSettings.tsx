import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import type { Track } from '../../domain/track'
import { commandErrorMessage } from '../../services/desktopApi'
import { getMediaOptions, getMediaPreferences, setMediaPreferences } from '../../services/mediaSources'

export function PlaybackSettings({ track, kind, onChanged }: {
  track: Track
  kind: 'audio' | 'video'
  onChanged: () => void | Promise<void>
}) {
  const client = useQueryClient()
  const supported = track.source.provider === 'bilibili'
  const options = useQuery({
    queryKey: ['media-options', track.id],
    queryFn: () => getMediaOptions(track.source.bvid, track.source.cid),
    staleTime: 60_000,
    enabled: supported,
  })
  const preferences = useQuery({
    queryKey: ['media-preferences'],
    queryFn: getMediaPreferences,
    enabled: supported,
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const audio = kind === 'audio'
  const field = audio ? 'audioId' : 'videoHeight'
  const choices = options.data?.[kind]
  const selected = preferences.data?.[field] ?? 0
  const missing = selected !== 0 && choices && !choices.some(choice => choice.id === selected)
  const queryError = options.error || preferences.error

  async function change(value: number) {
    setBusy(true)
    setError('')
    try {
      const updated = await setMediaPreferences({ [field]: value })
      client.setQueryData(['media-preferences'], updated)
      await onChanged()
    } catch (cause) {
      setError(commandErrorMessage(cause))
    } finally {
      setBusy(false)
    }
  }

  if (!supported) return null
  return <div className="playback-quality-settings" data-kind={kind}>
    <label>
      {audio ? '音质' : '清晰度'}
      <select aria-label={audio ? '音频质量' : '视频清晰度'} disabled={busy || !preferences.data || !choices}
        value={selected} onChange={event => void change(Number(event.target.value))}>
        <option value={0}>{audio ? '自动 · 最佳音质' : '自动 · 优先流畅'}</option>
        {choices?.map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
        {missing && <option value={selected}>{audio ? '已记住偏好 · 本曲使用可用音质' : '已记住偏好 · 本片自动适配'}</option>}
      </select>
    </label>
    {(error || queryError) && <p role="alert">{error || commandErrorMessage(queryError)}</p>}
    {busy && <small role="status">正在切换…</small>}
  </div>
}
