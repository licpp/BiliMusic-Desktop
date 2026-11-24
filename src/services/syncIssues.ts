export type SyncIssueKind = 'retry' | 'connection' | 'account' | 'limit' | 'data' | 'conflict'
export type SyncIssue = { kind: SyncIssueKind; message: string; status?: string }

export function describeSyncIssue(error: unknown): SyncIssue {
  const raw = typeof error === 'string' ? error
    : error && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : ''
  const status = raw.match(/\bHTTP (\d{3})\b/i)?.[1]
  const issue = (kind: SyncIssueKind, message: string): SyncIssue => ({ kind, message, status })
  if (/请(?:先)?登录.*(?:B站|账号)|登录已失效|请重新登录|账号会话已变更/.test(raw)) {
    return issue('account', '请在「我的」中登录用于同步的 B 站账号，然后重试。')
  }
  if (status === '401' || /凭据|授权失效|授权失败|重新连接|尚未连接同步/.test(raw)) {
    return issue('connection', '请在连接设置中重新填写坚果云账号和应用密码。')
  }
  if (status === '403' || status === '404' || status === '405' || status?.startsWith('3') || /服务器地址|证书/.test(raw)) {
    return issue('connection', '请检查 WebDAV 地址、访问权限和网络设置，然后重试。')
  }
  if (status === '507') return issue('limit', '坚果云空间不足。释放空间后重试同步。')
  if (status === '413' || /超过.*(?:上限|限制)|数量上限/.test(raw)) {
    return issue('limit', '同步资料超过容量或数量上限。请整理音乐库以减少同步记录，然后重试。')
  }
  if (status === '429' || /限流|冷却|请求过于频繁/.test(raw)) {
    return issue('retry', '坚果云暂时限制了请求，请稍后重试。')
  }
  if (status === '412' || /候选已变化|冲突.*重新预览|本机资料已变化|本机数据发生冲突|其他设备正在修改|其它设备正在修改|请一并处理恢复|请同时保留|父记录恢复材料/.test(raw)) {
    return issue('conflict', '同步资料或选择需要重新确认。请刷新冲突，按更新后的内容选择。')
  }
  if (/暂不可见|尚未完整|锁定|网络|连接超时|无法连接|传输中断/.test(raw) || status === '423' || status?.startsWith('5')) {
    return issue('retry', '同步服务暂时不可用或资料仍在传输，请稍后重试。')
  }
  if (/损坏|校验|身份不一致|身份无效|分叉|水位|缺少歌曲|同步对象.*无效|哈希|同步资料库账号或版本/.test(raw)) {
    return issue('data', '同步资料校验未通过。请重试，或复制诊断信息反馈。')
  }
  return issue('retry', '同步暂未完成，可以重试。若反复出现，可复制诊断信息反馈。')
}
