import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

function frontendProvenance(edition: string): Plugin {
  let target: string | string[] | false
  let publicDir = ''
  async function publicFiles(directory: string, prefix = ''): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true })
    const files = await Promise.all(entries.map(entry => {
      const name = prefix + entry.name
      return entry.isDirectory() ? publicFiles(join(directory, entry.name), name + '/') : [name]
    }))
    return files.flat()
  }
  return {
    name: 'bilimusic-frontend-provenance',
    apply: 'build',
    configResolved(config) {
      target = config.build.target
      publicDir = config.build.copyPublicDir ? config.publicDir : ''
    },
    async writeBundle(options, bundle) {
      if (!options.dir) throw new Error('Missing frontend output directory')
      const folder = options.dir
      const copiedFiles = publicDir ? await publicFiles(publicDir) : []
      const filenames = [...new Set([...Object.keys(bundle), ...copiedFiles])].sort()
      const files = Object.fromEntries(await Promise.all(filenames.map(async name => [
        name,
        createHash('sha256').update(await readFile(join(folder, name))).digest('hex'),
      ])))
      await writeFile(join(folder, 'frontend-build.json'), JSON.stringify({
        edition,
        platform: process.env.TAURI_ENV_PLATFORM || process.env.VITE_BILIMUSIC_PLATFORM || 'shared',
        target,
        files,
      }, null, 2))
    },
  }
}

const androidWebViewPreflight: Plugin = {
  name: 'bilimusic-android-webview-preflight',
  apply: 'build',
  transformIndexHtml: {
    order: 'post',
    handler(html) {
      const entry = /<script type="module" crossorigin src="([^"]+)"><\/script>/
      if (!entry.test(html)) throw new Error('Missing module entry for Android WebView preflight')
      return html
        .replace(entry, '<meta name="bilimusic-android-entry" content="$1">')
        .replace(/<link rel="modulepreload"[^>]*>/g, '')
    },
  },
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), frontendProvenance(mode === 'large-screen' ? 'large-screen' : 'standard'), ...(mode === 'large-screen' ? [{
    name: 'bilimusic-large-screen-entry',
    transformIndexHtml: { order: 'pre' as const, handler: (html: string) => html.replace('/src/main.tsx', '/src/large-screen/main.tsx') },
  }] : process.env.TAURI_ENV_PLATFORM === 'android' ? [androidWebViewPreflight] : [])],
  define: {
    'import.meta.env.VITE_BILIMUSIC_EDITION': JSON.stringify(mode === 'large-screen' ? 'large-screen' : 'standard'),
    __BILIMUSIC_BUILD_NUMBER__: Number(process.env.BILIMUSIC_BUILD_NUMBER ?? '1'),
  },
  clearScreen: false,
  server: {
    host: process.env.TAURI_DEV_HOST || '127.0.0.1',
    port: 1420,
    strictPort: true,
    // The Tauri build owns src-tauri. Watching target/ crashes Vite on Windows
    // when Cargo replaces a locked .exe (EBUSY) and is wasted work everywhere else.
    watch: { ignored: ['**/artifacts/**', '**/dist-large-screen/**', '**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    outDir: mode === 'large-screen' ? 'dist-large-screen' : 'dist',
    // Many car head units have a vendor-pinned Android WebView.
    target: mode === 'large-screen' ? 'chrome66'
      : ['windows', 'android'].includes(process.env.TAURI_ENV_PLATFORM || '') ? 'chrome105' : 'safari13',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
}))
