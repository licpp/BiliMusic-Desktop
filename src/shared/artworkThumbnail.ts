export function artworkThumbnail(src?: string): string | undefined {
  if (!src) return
  let url: URL
  try {
    url = new URL(src.replace(/^(?:http:)?\/\//, 'https://'))
  } catch {
    return
  }
  if (url.protocol !== 'https:' || url.search || url.hash) return

  const { hostname, pathname } = url
  if (/^i\d+\.hdslb\.com$/.test(hostname) && /^\/bfs\/[^@]+\.(?:jpe?g|png|webp)$/i.test(pathname)) {
    return `${url.href}@160w.jpg`
  }
  if (/^p\d+\.music\.126\.net$/.test(hostname) && /\.(?:jpe?g|png|webp)$/i.test(pathname)) {
    return `${url.href}?param=160y160`
  }
  if (hostname === 'y.gtimg.cn' && /^\/music\/photo_new\/T002R(?:180x180|300x300|500x500|800x800)M000[\w]+\.jpg$/.test(pathname)) {
    return url.href.replace(/T002R\d+x\d+M000/, 'T002R150x150M000')
  }
}
