import { create } from 'zustand'
import type { Track } from '../../domain/track'
import { getPlaybackSource, inDesktopShell, recordPlayedTrack } from '../../services/desktopApi'
import { demoTracks } from '../library/demoTracks'

export type PlaybackStatus = 'idle' | 'resolving' | 'buffering' | 'playing' | 'paused' | 'error'
export type RepeatMode = 'off' | 'all' | 'one'
type PlayerState = { current: Track | null; queue: Track[]; status: PlaybackStatus; error: string | null; queueOpen: boolean; progressSeconds: number; durationSeconds: number; volume: number; shuffled: boolean; repeatMode: RepeatMode; play: (track: Track) => Promise<void>; toggle: () => Promise<void>; toggleQueue: () => void; next: (fromEnded?: boolean) => Promise<void>; previous: () => Promise<void>; seek: (seconds: number) => void; setVolume: (volume: number) => void; toggleShuffle: () => void; cycleRepeat: () => void; updateTrack: (track: Track) => void }

let audio: HTMLAudioElement | null = null
function playerAudio() {
  if (audio) return audio
  audio = new Audio(); audio.preload = 'metadata'
  audio.addEventListener('waiting', () => usePlayerStore.setState({ status: 'buffering' }))
  audio.addEventListener('playing', () => usePlayerStore.setState({ status: 'playing', error: null }))
  audio.addEventListener('pause', () => { if (usePlayerStore.getState().status !== 'resolving') usePlayerStore.setState({ status: 'paused' }) })
  audio.addEventListener('timeupdate', () => usePlayerStore.setState({ progressSeconds: audio?.currentTime || 0 }))
  audio.addEventListener('durationchange', () => { if (Number.isFinite(audio?.duration)) usePlayerStore.setState({ durationSeconds: audio?.duration || 0 }) })
  audio.addEventListener('ended', () => void usePlayerStore.getState().next(true))
  audio.addEventListener('error', () => usePlayerStore.setState({ status: 'error', error: '音频流加载失败，请重新播放' }))
  return audio
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  current: inDesktopShell ? null : demoTracks[1], queue: inDesktopShell ? [] : demoTracks, status: 'paused', error: null, queueOpen: false, progressSeconds: 0, durationSeconds: inDesktopShell ? 0 : demoTracks[1].durationSeconds, volume: .7, shuffled: false, repeatMode: 'off',
  play: async (track) => {
    set({ current: track, status: 'resolving', progressSeconds: 0, durationSeconds: track.durationSeconds, error: null })
    if (!inDesktopShell) { set({ status: 'playing' }); return }
    try {
      const storedTrack = await recordPlayedTrack(track)
      const queue = get().queue.some((item) => item.id === storedTrack.id) ? get().queue.map((item) => item.id === storedTrack.id ? storedTrack : item) : [...get().queue, storedTrack]
      set({ current: storedTrack, queue, durationSeconds: storedTrack.durationSeconds })
      const source = await getPlaybackSource(storedTrack.source.bvid, storedTrack.source.cid)
      const element = playerAudio(); element.src = source.audioUrl; element.currentTime = 0; await element.play()
    } catch (error) {
      const message = error && typeof error === 'object' && 'message' in error ? String(error.message) : '无法解析播放地址'
      set({ status: 'error', error: message })
    }
  },
  toggle: async () => {
    const { current, status } = get(); if (!current) return
    if (!inDesktopShell) { set({ status: status === 'playing' ? 'paused' : 'playing' }); return }
    const element = playerAudio()
    if (status === 'playing' || status === 'buffering') element.pause()
    else if (element.src) await element.play().catch(() => set({ status: 'error', error: '恢复播放失败' }))
    else await get().play(current)
  },
  toggleQueue: () => set(({ queueOpen }) => ({ queueOpen: !queueOpen })),
  next: async (fromEnded = false) => { const { current, queue, shuffled, repeatMode } = get(); if (!queue.length) return; if (fromEnded && repeatMode === 'off' && current?.id === queue[queue.length - 1]?.id) { set({ status: 'paused', progressSeconds: 0 }); return } if (fromEnded && repeatMode === 'one' && current) { await get().play(current); return } const index = current ? queue.findIndex((track) => track.id === current.id) : -1; const nextIndex = shuffled && queue.length > 1 ? randomOtherIndex(queue.length, index) : (index + 1) % queue.length; await get().play(queue[nextIndex]) },
  previous: async () => { const { current, queue } = get(); if (!queue.length) return; const element = playerAudio(); if (element.currentTime > 4) { element.currentTime = 0; return }; const index = current ? queue.findIndex((track) => track.id === current.id) : 0; await get().play(queue[(index - 1 + queue.length) % queue.length]) },
  seek: (seconds) => { const element = playerAudio(); element.currentTime = Math.max(0, Math.min(seconds, element.duration || seconds)); set({ progressSeconds: element.currentTime }) },
  setVolume: (volume) => { const normalized = Math.max(0, Math.min(1, volume)); playerAudio().volume = normalized; set({ volume: normalized }) },
  toggleShuffle: () => set(({ shuffled }) => ({ shuffled: !shuffled })),
  cycleRepeat: () => set(({ repeatMode }) => ({ repeatMode: repeatMode === 'off' ? 'all' : repeatMode === 'all' ? 'one' : 'off' })),
  updateTrack: (track) => set(({ current, queue }) => ({ current: current?.id === track.id ? track : current, queue: queue.map((item) => item.id === track.id ? track : item) })),
}))

function randomOtherIndex(length: number, current: number) {
  const offset = 1 + Math.floor(Math.random() * (length - 1))
  return (Math.max(0, current) + offset) % length
}
