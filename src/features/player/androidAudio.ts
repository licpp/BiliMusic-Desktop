import { createNativeAudio } from './nativeAudio'
const audio = createNativeAudio('android-player')
export const { observe: observeAndroidAudio, play: playAndroidAudio, setCollection: setAndroidCollection, control: controlAndroidAudio, snapshot: snapshotAndroidAudio, playbackClock: androidPlaybackClock, prepare: prepareAndroidAudio } = audio
