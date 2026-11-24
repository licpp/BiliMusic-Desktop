export function randomUuid(): string | undefined {
  if (typeof crypto === 'undefined') return undefined
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  if (typeof crypto.getRandomValues !== 'function') return undefined
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, byte => ('0' + byte.toString(16)).slice(-2)).join('')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

export function requireRandomUuid() {
  const id = randomUuid()
  if (!id) throw new Error('当前环境无法生成安全标识')
  return id
}
