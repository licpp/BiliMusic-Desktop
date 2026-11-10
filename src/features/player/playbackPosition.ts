import { invoke, isTauri } from '@tauri-apps/api/core'

export async function readPlaybackPosition(id: string) {
  return isTauri() ? invoke<number>('playback_position', { trackId: id }).catch(() => 0) : 0
}

export function playbackPositionScope() {
  return isTauri() ? invoke<string>('listening_scope').catch(() => undefined) : Promise.resolve(undefined)
}

export async function writePlaybackPosition(id: string, seconds: number, observedAt: number, scope: string | undefined, collectionRef?: string) {
  if (scope !== undefined) await invoke('playback_position', { trackId: id, seconds, observedAt, scope, collectionRef }).catch(() => undefined)
}

export function usablePlaybackPosition(position: number, duration: number) {
  return Number.isFinite(position) && position >= 1 && (!duration || position < duration - 1) ? position : 0
}
