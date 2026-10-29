import { invoke, isTauri } from '@tauri-apps/api/core'
import { version } from '../../package.json'
import { compareVersions } from '../shared/version'

export const currentRelease = version
const downloadPage = 'https://bilimusic.cn/#download'
export type UpdateRelease = { version: string; available: boolean }
export type UpdateCheck = UpdateRelease & { status: 'available' | 'current' | 'ahead' | 'unsupported' }

export async function checkForUpdate(): Promise<UpdateCheck> {
  if (!isTauri()) throw new Error('请在 BiliMusic 应用中检查更新')
  const release = await invoke<UpdateRelease>('app_check_update')
  const order = compareVersions(release.version, currentRelease)
  return { ...release, status: !release.available ? 'unsupported' : order > 0 ? 'available' : order < 0 ? 'ahead' : 'current' }
}

export async function openUpdateDownload() {
  if (isTauri()) await invoke('app_open_download_page')
  else window.open(downloadPage, '_blank', 'noopener,noreferrer')
}
