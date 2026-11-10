import { isIOS } from '../../services/platform'
import { setAndroidCollection, observeAndroidAudio, prepareAndroidAudio, playAndroidAudio, controlAndroidAudio, snapshotAndroidAudio, androidPlaybackClock } from './androidAudio'
import { setIOSCollection, observeIOSAudio, prepareIOSAudio, playIOSAudio, controlIOSAudio, snapshotIOSAudio, iosPlaybackClock } from './iosAudio'
export const observeMobileAudio = isIOS ? observeIOSAudio : observeAndroidAudio
export const prepareMobileAudio = isIOS ? prepareIOSAudio : prepareAndroidAudio
export const setMobileCollection = isIOS ? setIOSCollection : setAndroidCollection
export const playMobileAudio = isIOS ? playIOSAudio : playAndroidAudio
export const controlMobileAudio = isIOS ? controlIOSAudio : controlAndroidAudio
export const snapshotMobileAudio = isIOS ? snapshotIOSAudio : snapshotAndroidAudio
export const mobilePlaybackClock = isIOS ? iosPlaybackClock : androidPlaybackClock
