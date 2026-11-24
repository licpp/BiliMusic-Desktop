import { writeNativeQueue } from './nativeQueue'
import { createNativeAudio } from './nativeAudio'
import type { Track } from '../../domain/track'
import type { QueueSource, RepeatMode } from './playerStore'
import type { ResumeThreshold } from './resumePolicy'
const audio = createNativeAudio('android-player')
export const syncAndroidQueue = (tracks: Track[], repeatMode: RepeatMode, shuffled: boolean, resumeThresholdSeconds: ResumeThreshold = 0, source?: QueueSource) => writeNativeQueue('android-player', tracks, repeatMode, shuffled, resumeThresholdSeconds, source)
export const { observe: observeAndroidAudio, play: playAndroidAudio, setCollection: setAndroidCollection, control: controlAndroidAudio, snapshot: snapshotAndroidAudio, playbackClock: androidPlaybackClock, prepare: prepareAndroidAudio } = audio
