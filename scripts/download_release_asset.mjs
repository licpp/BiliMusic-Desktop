import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const runCommand = promisify(execFile)
import { inspectDownloadHeaders } from './release_content_types.mjs'

// Small independent ranges avoid stalled bulk transfers on some workstation
// routes. Every byte is still fetched from the public URL and hashed in order.
export async function verifyPublicAsset(platform, channel, request = fetch) {
  const chunkSize = 256 * 1024
  let headers
  const ensureResponse = response => {
    if (!response.ok || !response.url.startsWith('https://')) throw new Error('Download unavailable')
    headers = inspectDownloadHeaders(platform.file, response.headers)
  }
  const hash = createHash('sha256')
  let size = 0
  if (channel.id === 'github' && platform.size > chunkSize) {
    const bytes = Buffer.alloc(platform.size)
    let next = 0, etag, cancelled = false
    const worker = async () => {
      while (next < platform.size && !cancelled) {
        const start = next, end = Math.min(start + chunkSize, platform.size) - 1
        next = end + 1
        const response = await request(channel.url, { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'BiliMusic-release-verification', Range: `bytes=${start}-${end}`, Connection: 'close' } })
        try {
          ensureResponse(response)
          if (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${platform.size}`) throw new Error('Public download range mismatch')
          const current = response.headers.get('etag')
          if (!current || etag && etag !== current) throw new Error('Public download changed during verification')
          etag = current
          let offset = start
          for await (const chunk of response.body) {
            if (offset + chunk.length > end + 1) throw new Error('Download range exceeded manifest')
            bytes.set(chunk, offset); offset += chunk.length
          }
          if (offset !== end + 1) throw new Error('Incomplete public download range')
        } catch (error) { cancelled = true; throw error }
      }
    }
    const workers = await Promise.allSettled(Array.from({ length: 4 }, worker))
    const failed = workers.find(result => result.status === 'rejected')
    if (failed) throw failed.reason
    hash.update(bytes); size = bytes.length
  } else {
    const response = await request(channel.url, { signal: AbortSignal.timeout(180_000), headers: { 'user-agent': 'BiliMusic-release-verification' } })
    ensureResponse(response)
    for await (const chunk of response.body) {
      size += chunk.length
      if (size > platform.size) throw new Error('Download size exceeded manifest')
      hash.update(chunk)
    }
  }
  const sha256 = hash.digest('hex')
  if (size !== platform.size || sha256 !== platform.sha256) throw new Error('Downloaded size or SHA-256 mismatch')
  return { url: channel.url, size, sha256, platform: platform.id, channel: channel.id, verification: 'full-download', ...headers }
}

export function uploadProofMatches(proof, platform, channel) {
  return Boolean(proof && proof.channel === channel.id && proof.name === platform.file &&
    proof.size === platform.size && proof.sha256 === platform.sha256 &&
    Number.isSafeInteger(proof.assetId) && proof.assetId > 0 &&
    Number.isSafeInteger(proof.releaseId) && proof.releaseId > 0 &&
    (proof.method === 'downloaded-sha256' || channel.id === 'github' && proof.method === 'server-sha256'))
}

// Respect workstation proxy rules when the Node HTTPS route stalls. Curl is
// bounded to headers / at most 1 KiB even when a provider ignores Range.
export async function curlPublicHeaders(url, options, run = runCommand) {
  let lastError
  for (const direct of [false, true]) {
    const args = ['--silent','--location','--proto','=https','--proto-redir','=https','--max-time','12','--dump-header','-','--output','/dev/null',
      '--write-out','\nBILIMUSIC_EFFECTIVE_URL:%{url_effective}\n',...(direct ? ['--noproxy','*'] : []),
      ...(options.method === 'HEAD' ? ['--head'] : ['--range','0-0','--max-filesize','1024']),url]
    try {
      let output
      try { output = (await run('curl',args,{maxBuffer:256*1024,timeout:14000,signal:options.signal})).stdout }
      catch (error) { if (options.method !== 'GET' || error.code !== 63) throw error; output = error.stdout }
      const effective = output.match(/BILIMUSIC_EFFECTIVE_URL:([^\r\n]+)/)?.[1]
      const blocks = output.split(/\r?\n\r?\n/).map(x=>x.trim()).filter(x=>/^HTTP\//.test(x))
      const lines = blocks.at(-1)?.split(/\r?\n/), status = Number(lines?.[0].split(/\s+/)[1])
      if (!effective || !status) throw Error('Invalid public download header response')
      const headers = new Headers()
      for (const line of lines.slice(1)) { const split = line.indexOf(':'); if (split > 0) headers.append(line.slice(0,split),line.slice(split+1).trim()) }
      const response = new Response(null,{status,headers})
      Object.defineProperty(response,'url',{value:effective})
      return response
    } catch (error) { lastError = error }
  }
  throw Error('Public download headers unavailable', {cause:lastError})
}

async function requestPublicHeaders(url, options) {
  try { return await fetch(url,{...options,signal:AbortSignal.any([options.signal,AbortSignal.timeout(2500)])}) }
  catch { return curlPublicHeaders(url,options) }
}

export async function probePublicAsset(platform, channel, proof, request = requestPublicHeaders) {
  if (!uploadProofMatches(proof, platform, channel)) throw Error('Upload hash proof does not match the package')
  const options = { signal: AbortSignal.timeout(30_000), headers: { 'user-agent': 'BiliMusic-release-verification' } }
  let probeMethod = 'HEAD'
  let response = await request(channel.url, { ...options, method: 'HEAD' })
  try {
    const length = response.headers.get('content-length')
    if (!response.ok || !length) {
      if (!response.ok && ![405,501].includes(response.status)) throw Error('Public download unavailable')
      await response.body?.cancel()
      probeMethod = 'GET bytes=0-0'
      response = await request(channel.url, { ...options, method: 'GET', headers: { ...options.headers, Range: 'bytes=0-0' } })
      if (!response.ok) throw Error('Public download unavailable')
      if (response.status === 206) {
        if (response.headers.get('content-range') !== `bytes 0-0/${platform.size}`) throw Error('Public download size mismatch')
      } else if (response.status !== 200 || response.headers.get('content-length') !== String(platform.size)) throw Error('Public download size missing or mismatched')
    } else if (length !== String(platform.size)) throw Error('Public download size mismatch')
    if (!response.url.startsWith('https://')) throw Error('Insecure public download redirect')
    const headers = inspectDownloadHeaders(platform.file, response.headers)
    if (headers.contentType === 'text/html') throw Error('Public download returned an HTML page')
    return { url: channel.url, size: platform.size, sha256: platform.sha256, platform: platform.id, channel: channel.id,
      verification: 'uploaded-hash-and-public-headers', probeMethod, uploadProof: proof, ...headers }
  } finally { await response.body?.cancel() }
}
