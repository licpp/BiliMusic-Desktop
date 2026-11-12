import { isIOS, isOHOS } from '../../services/platform'
import { setAndroidCollection, observeAndroidAudio, prepareAndroidAudio, playAndroidAudio, controlAndroidAudio, snapshotAndroidAudio, androidPlaybackClock } from './androidAudio'
import { setIOSCollection, observeIOSAudio, prepareIOSAudio, playIOSAudio, controlIOSAudio, snapshotIOSAudio, iosPlaybackClock } from './iosAudio'
import { setOHOSCollection, observeOHOSAudio, prepareOHOSAudio, playOHOSAudio, controlOHOSAudio, snapshotOHOSAudio, ohosPlaybackClock } from './ohosAudio'
export const observeMobileAudio = isOHOS ? observeOHOSAudio : isIOS ? observeIOSAudio : observeAndroidAudio
export const prepareMobileAudio = isOHOS ? prepareOHOSAudio : isIOS ? prepareIOSAudio : prepareAndroidAudio
export const setMobileCollection = isOHOS ? setOHOSCollection : isIOS ? setIOSCollection : setAndroidCollection
export const playMobileAudio = isOHOS ? playOHOSAudio : isIOS ? playIOSAudio : playAndroidAudio
export const controlMobileAudio = isOHOS ? controlOHOSAudio : isIOS ? controlIOSAudio : controlAndroidAudio
export const snapshotMobileAudio = isOHOS ? snapshotOHOSAudio : isIOS ? snapshotIOSAudio : snapshotAndroidAudio
export const mobilePlaybackClock = isOHOS ? ohosPlaybackClock : isIOS ? iosPlaybackClock : androidPlaybackClock
