export class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
export function validateFeedback(input, policyVersion) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '反馈格式不正确。');
  const text = (key, min, max) => {
    if (typeof input[key] !== 'string') throw new HttpError(400, '请填写完整的反馈信息。');
    const value = input[key].trim();
    if (value.length < min || value.length > max || /\u0000/.test(value)) throw new HttpError(400, '请检查标题、描述和联系方式的长度。');
    return value;
  };
  if (input.website) throw new HttpError(400, '提交未通过验证。');
  if (input.consent !== true || input.policyVersion !== policyVersion) throw new HttpError(400, '请阅读并同意最新的使用与隐私说明。');
  if (!['bug','suggestion','copyright','other'].includes(input.category)) throw new HttpError(400, '请选择反馈类型。');
  if (!['macOS','Windows','Android','website','other'].includes(input.platform)) throw new HttpError(400, '请选择平台。');
  const result = { category: input.category, platform: input.platform, title: text('title', 3, 120), message: text('message', 10, 5000), contact: text('contact', 0, 200), version: text('version', 0, 40) };
  if (result.category === 'copyright' && !result.contact) throw new HttpError(400, '版权与权利反馈请留下联系方式，以便核实和回复。');
  return result;
}
