import type {Track} from '../../domain/track'
export type NativeCapabilities = { autonomousQueue: boolean; seamlessSourceSwitch: boolean; nativeSleepTimer: boolean; snapshotRebind: boolean }
export type NativeAudioState = { capabilities?: NativeCapabilities; engineInstanceId?: string; sessionId?: string; sourceRevision?: number; autonomousQueue?: boolean; queueVersion?: number; track?: Track; expandedEntries?: Record<string, Track[]>; recoveryAttempted?: boolean; sleepDeadline?: number; sleepDuration?: number; sleepExpired?: boolean; revision?: number; sequence?: number; seekRevision?: number; stopped?: boolean; floatingLyricsEnabled?: boolean; floatingLyricsFontSize?: number; floatingLyricsStyleRevision?: number; floatingLyricsLocked?: boolean; id?: string; status?: 'playing' | 'paused' | 'buffering' | 'error'; position?: number; rate?: number; duration?: number; error?: string; action?: 'next' | 'previous' | 'ended' | 'resume' }

export type PlayerSnapshot = NativeAudioState & { engineInstanceId: string; sessionId: string; sourceRevision: number; sequence: number; capabilities: NativeCapabilities }
export function normalizeNativeSnapshot(state: NativeAudioState): PlayerSnapshot {
  return { ...state, engineInstanceId: state.engineInstanceId ?? 'legacy', sessionId: state.sessionId ?? `legacy:${state.id ?? ''}`,
    sourceRevision: state.sourceRevision ?? state.revision ?? 0, sequence: state.sequence ?? 0,
    capabilities: state.capabilities ?? { autonomousQueue: state.autonomousQueue === true, seamlessSourceSwitch: false, nativeSleepTimer: false, snapshotRebind: false } }
}

export type NativeControlAction = 'loudness' | 'pause' | 'resume' | 'stop' | 'next' | 'previous' | 'seek' | 'rate' | 'volume' | 'sleepStart' | 'sleepRepeat' | 'sleepDismiss' | 'sleepCancel' | 'videoFullscreen' | 'keyboard' | 'keepAwake' | 'largeScreen'
export type ControlCommand = { action: NativeControlAction; value?: number }
