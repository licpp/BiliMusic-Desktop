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
