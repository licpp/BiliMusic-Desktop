import { invoke } from '@tauri-apps/api/core'
import { accountEpoch } from '../../services/accountScope'
import type { Track } from '../../domain/track'
import type { ResumeThreshold } from './resumePolicy'
import { sourceTrack } from '../../domain/importedPresentation'

let version = 0
const owner = `${Date.now()}-${Math.random().toString(36).slice(2)}`
export async function nativeQueueEnvelope(tracks: Track[], repeatMode: string, shuffled: boolean, threshold: ResumeThreshold, source?: { offlineOnly?: boolean; collectionRef?: string; kind: string; entryOrigins?:Record<string,string[]>;entryOrder?:string[] }) {
  const epoch = accountEpoch(), currentVersion = ++version
  const accountSession = await invoke<string>('account_session')
  if (epoch !== accountEpoch()) throw new Error('ACCOUNT_SESSION_EXPIRED')
  return { tracks: tracks.map(sourceTrack), entryOrder: source?.entryOrder ?? tracks.map(t=>t.id), entryOrigins: source?.entryOrigins ?? {}, repeatMode, shuffled, autoResume: threshold !== null, resumeThresholdSeconds: threshold,
    collectionPlayback: Boolean(source?.collectionRef) || source?.kind === 'season', collectionRef: source?.collectionRef,
    ...(source?.offlineOnly ? { offlineOnly: true } : {}),
    accountSession, version: currentVersion, owner }
}

export async function writeNativeQueue(plugin: 'android-player' | 'ios-player' | 'ohos-player', ...args: Parameters<typeof nativeQueueEnvelope>) {
  const envelope = await nativeQueueEnvelope(...args)
  await invoke(`plugin:${plugin}|queue`, plugin === 'android-player' ? { data: JSON.stringify(envelope) } : envelope)
  return envelope.accountSession
}
