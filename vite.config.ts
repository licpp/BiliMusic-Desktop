import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === 'large-screen' ? [{
    name: 'bilimusic-large-screen-entry',
    transformIndexHtml: { order: 'pre' as const, handler: (html: string) => html.replace('/src/main.tsx', '/src/large-screen/main.tsx') },
  }] : [])],
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
    target: ['windows', 'android'].includes(process.env.TAURI_ENV_PLATFORM || '') ? 'chrome105' : 'safari13',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
}))
