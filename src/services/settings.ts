import { open } from '@tauri-apps/plugin-dialog'
import { load } from '@tauri-apps/plugin-store'

export const settingsFile = 'settings.json'

export async function getDownloadDirectory() {
  const store = await load(settingsFile, { autoSave: true })
  return (await store.get<string>('downloadDirectory')) || ''
}

export async function chooseDownloadDirectory() {
  const selected = await open({ directory: true, multiple: false, title: '选择音乐下载目录' })
  if (!selected) return ''
  const store = await load(settingsFile, { autoSave: true })
  await store.set('downloadDirectory', selected)
  await store.save()
  return selected
}
