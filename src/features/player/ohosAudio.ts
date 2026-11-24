import { writeNativeQueue } from './nativeQueue'
import type { Track } from '../../domain/track'
import type { RepeatMode, QueueSource } from './playerStore'
import type { ResumeThreshold } from './resumePolicy'
import { createNativeAudio } from './nativeAudio'
import { Channel, invoke } from '@tauri-apps/api/core'
const audio = createNativeAudio('ohos-player', async callback => {
  const handler = new Channel<Parameters<typeof callback>[0]>()
  handler.onmessage = callback
  await invoke('plugin:ohos-player|observe', { handler })
  callback(await invoke('plugin:ohos-player|snapshot'))
  return handler
})
export const { observe: observeOHOSAudio, play: playOHOSAudio, setCollection: setOHOSCollection, control: controlOHOSAudio, snapshot: snapshotOHOSAudio, playbackClock: ohosPlaybackClock, prepare: prepareOHOSAudio } = audio

export const syncOHOSQueue = (tracks: Track[], repeatMode: RepeatMode, shuffled: boolean, threshold: ResumeThreshold = 0, source?: QueueSource) => writeNativeQueue('ohos-player', tracks, repeatMode, shuffled, threshold, source)
