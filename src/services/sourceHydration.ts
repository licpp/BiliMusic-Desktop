import { invoke } from '@tauri-apps/api/core'
import { accountEpoch } from './accountScope'

export async function hydrateSources(epoch: number, selection: { trackIds?: string[]; titleIds?: string[] } = {}) {
  if (epoch !== accountEpoch()) return 0
  const expectedAccountSession = await invoke<string>('account_session')
  if (epoch !== accountEpoch()) return 0
  const changed = await invoke<number>('sync_hydrate_sources', { ...selection, expectedAccountSession })
  return epoch === accountEpoch() ? changed : 0
}
