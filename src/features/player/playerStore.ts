import { create } from 'zustand'
import type { Track } from '../../domain/track'
import { demoTracks } from '../library/demoTracks'

export type PlaybackStatus = 'idle' | 'resolving' | 'buffering' | 'playing' | 'paused' | 'error'

type PlayerState = {
  current: Track | null
  queue: Track[]
  status: PlaybackStatus
  queueOpen: boolean
  play: (track: Track) => void
  toggle: () => void
  toggleQueue: () => void
  next: () => void
  previous: () => void
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  current: demoTracks[1],
  queue: demoTracks,
  status: 'paused',
  queueOpen: true,
  play: (track) => set({ current: track, status: 'playing' }),
  toggle: () => set(({ status, current }) => ({
    status: !current ? 'idle' : status === 'playing' ? 'paused' : 'playing',
  })),
  toggleQueue: () => set(({ queueOpen }) => ({ queueOpen: !queueOpen })),
  next: () => {
    const { current, queue } = get()
    if (!queue.length) return
    const index = current ? queue.findIndex((track) => track.id === current.id) : -1
    set({ current: queue[(index + 1) % queue.length], status: 'playing' })
  },
  previous: () => {
    const { current, queue } = get()
    if (!queue.length) return
    const index = current ? queue.findIndex((track) => track.id === current.id) : 0
    set({ current: queue[(index - 1 + queue.length) % queue.length], status: 'playing' })
  },
}))
