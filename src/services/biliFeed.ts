import { invoke } from '@tauri-apps/api/core'
import type { BiliFeedPage } from '../domain/bilibili'
import { accountEpoch } from './accountScope'

export async function getBilibiliFeed(page: number): Promise<BiliFeedPage> {
  const epoch = accountEpoch()
  const expectedAccountSession = await invoke<string>('account_session')
  if (epoch !== accountEpoch()) throw new Error('ACCOUNT_SESSION_EXPIRED')
  const feed = await invoke<BiliFeedPage>('bili_personalized_feed', { page, expectedAccountSession })
  if (epoch !== accountEpoch()) throw new Error('ACCOUNT_SESSION_EXPIRED')
  return feed
}
