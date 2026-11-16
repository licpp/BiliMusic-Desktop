import { accountEpoch } from '../../services/accountScope'
/** A session is a logical play, not a track ID or a media URL. */
export function createOperationScope() {
  let session = 0
  const versions = new Map<string, number>()
  return {
    invalidate() { ++session; versions.clear() },
    begin(lane: string) {
      const epoch = accountEpoch(), captured = session
      const version = (versions.get(lane) || 0) + 1
      versions.set(lane, version)
      return () => epoch === accountEpoch() && captured === session && versions.get(lane) === version
    },
  }
}
