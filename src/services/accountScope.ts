let epoch = 0
export const accountEpoch = () => epoch
export function advanceAccountEpoch() { epoch++; window.dispatchEvent(new Event('bilimusic-account-changing')) }
