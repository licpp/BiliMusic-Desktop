function rawMessage(error: unknown) {
  if (typeof error === 'string') return error.trim()
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message.trim()
  return ''
}

export function isConnectionError(error: unknown) {
  return /could not connect|cannot connect|network connection|network error|failed to fetch|load failed|network request failed|error sending request|connection (?:refused|reset|closed)|not connected|unable to resolve host|NSURLErrorDomain|MEDIA_ERROR_IO|网络请求失败|无法连接|未能连接|不能连接|网络连接/i.test(rawMessage(error))
}

export function commandErrorMessage(error: unknown, fallback = '请求失败，请稍后重试'): string {
  const message = rawMessage(error)
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (code === 'database_error') return '无法读取或保存本机数据，请重试'
  if (/\b(?:412|429)\b|-352|-412|-509|-799/.test(message)) return '服务暂时限制了请求，请稍后重试'
  if (/\b(?:502|503|504)\b/.test(message)) return '服务暂时不可用，请稍后重试'
  if (/timed?\s*out|timeout|超时/i.test(message)) return '连接超时，请重试'
  if (isConnectionError(error)) return '暂时无法连接服务器，请检查网络后重试'
  if (/https?:\/\/|file:\/\/|\b(?:HTTP|SQLITE|Exception|AVFoundationErrorDomain)\b|响应缺少 data|^B站接口错误|^Bilibili 接口返回错误|数据解码失败|^下载失败[:：]/i.test(message)) return fallback
  return /[\p{Script=Han}]/u.test(message) ? message : fallback
}

// Sync errors retain an actionable status and operation, never a remote URL/body.
export function syncErrorMessage(error: unknown): string {
  const message = rawMessage(error)
  const status = message.match(/\bHTTP\s+(\d{3})\b/i)?.[1]
  const operation = message.match(/^(读取同步目录|读取同步对象|创建同步父目录|创建同步目录|恢复同步目录|上传同步对象|清理同步提交|检查坚果云根目录|检查坚果云服务器地址)(?:失败)?[:：]/)?.[1]
  if (!status) {
    const reason = commandErrorMessage(error, '同步失败，请稍后重试')
    return operation && !reason.startsWith(`${operation}失败：`) ? `${operation}失败：${reason}` : reason
  }
  const reasons: Record<string, string> = {
    '401': '授权失败，请使用坚果云应用密码重新连接',
    '403': '坚果云拒绝访问，请检查目录权限、账户状态及流量限制',
    '404': '找不到同步位置，请检查服务器地址及云端目录',
    '405': '服务器不允许此同步操作，请检查 WebDAV 地址与代理设置',
    '409': '云端目录缺失或发生冲突，请重试；持续出现时请反馈此状态码',
    '412': '云端资料已变化，请重新同步',
    '413': '同步文件超出服务器允许的大小',
    '423': '云端文件暂时被锁定，请稍后重试',
    '429': '坚果云请求过于频繁，请等待后重试，避免连续点击',
    '500': '坚果云服务器处理失败，请稍后重试',
    '502': '同步网关异常，请检查代理或稍后重试',
    '503': '坚果云服务暂不可用，请等待后重试',
    '504': '同步网关响应超时，请检查网络或稍后重试',
    '507': '坚果云无法保存文件，请检查剩余空间与账户存储限制',
  }
  const reason = reasons[status] || (status.startsWith('3') ? '同步地址发生重定向，请检查 WebDAV 服务器地址' : '同步服务器返回异常响应，请稍后重试或反馈此状态码')
  return `${operation ? `${operation}失败：` : ''}${reason}（HTTP ${status}）`
}

export const isExpiredPlaybackSource = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error && error.code === 'source_expired'
