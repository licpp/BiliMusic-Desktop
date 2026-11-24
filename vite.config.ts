import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

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
  plugins: [react(), ...(mode === 'large-screen' ? [{
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
    watch: { ignored: ['**/artifacts/**', '**/dist-large-screen/**'] },
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
