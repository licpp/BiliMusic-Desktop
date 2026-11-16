import { nativeQueueEnvelope } from './nativeQueue'
import { createNativeAudio } from './nativeAudio'
import { invoke } from '@tauri-apps/api/core'
import type { Track } from '../../domain/track'
import type { QueueSource, RepeatMode } from './playerStore'
import type { ResumeThreshold } from './resumePolicy'
const audio = createNativeAudio('android-player')
export const syncAndroidQueue = async (tracks: Track[], repeatMode: RepeatMode, shuffled: boolean, resumeThresholdSeconds: ResumeThreshold = 0, source?: QueueSource) => invoke('plugin:android-player|queue', { data: JSON.stringify(await nativeQueueEnvelope(tracks, repeatMode, shuffled, resumeThresholdSeconds, source)) })
export const { observe: observeAndroidAudio, play: playAndroidAudio, setCollection: setAndroidCollection, control: controlAndroidAudio, snapshot: snapshotAndroidAudio, playbackClock: androidPlaybackClock, prepare: prepareAndroidAudio } = audio
