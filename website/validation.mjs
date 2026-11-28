export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export const feedbackCategories = ['bug', 'suggestion', 'copyright', 'other'];
export const feedbackPlatforms = ['macOS', 'Windows', 'Linux', 'Android', 'Android Large Screen', 'iOS', 'HarmonyOS', 'website', 'other'];

export function isBilibiliUid(value) {
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) &&
    (value.length < 19 || value <= '9223372036854775807');
}

export function isFeedbackEmail(value) {
  if (typeof value !== 'string' || value.length > 254) return false;
  const [mailbox, domain, extra] = value.split('@');
  if (!domain || extra !== undefined || mailbox.length > 64 ||
      !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(mailbox) ||
      mailbox.startsWith('.') || mailbox.endsWith('.') || mailbox.includes('..')) return false;
  const labels = domain.split('.');
  return labels.length > 1 && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label));
}

function feedbackEnvironment(input) {
  const error = new HttpError(400, '设备环境信息格式不正确，请重新选择后提交。');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw error;
  const fields = { system: 193, systemBuild: 96, deviceModel: 96, architecture: 96, webview: 96, webviewPackage: 96 };
  const environment = {};
  for (const [field, value] of Object.entries(input)) {
    if (field === 'apiLevel') {
      if (!Number.isSafeInteger(value) || value < 1) throw error;
      environment.apiLevel = value;
    } else if (field === 'largeScreen') {
      if (typeof value !== 'boolean') throw error;
      environment.largeScreen = value;
    } else if (Object.hasOwn(fields, field)) {
      if (typeof value !== 'string' || !value.trim() || value.trim().length > fields[field] ||
          /[:\\=\u0000-\u001f\u007f\u2028\u2029]/.test(value)) throw error;
      environment[field] = value.trim();
    } else {
      throw error;
    }
  }
  if (!environment.system || !environment.webview) throw error;
  return environment;
}

export function validateFeedback(input, policyVersion, { app = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '反馈格式不正确。');
  const text = (key, min, max) => {
    if (typeof input[key] !== 'string') throw new HttpError(400, '请填写完整的反馈信息。');
    const value = input[key].trim();
    if (value.length < min || value.length > max || /\u0000/.test(value)) throw new HttpError(400, '请检查标题、描述和联系方式的长度。');
    return value;
  };
  if (input.website) throw new HttpError(400, '提交未通过验证。');
  const policyMessage = '请阅读并同意最新的使用与隐私说明。';
  if (input.consent !== true) throw new HttpError(400, policyMessage);
  if (input.policyVersion !== policyVersion) {
    throw new HttpError(app ? 409 : 400, policyMessage, app ? 'feedback_policy_changed' : undefined);
  }
  if (!feedbackCategories.includes(input.category)) throw new HttpError(400, '请选择反馈类型。');
  if (!feedbackPlatforms.includes(input.platform)) throw new HttpError(400, '请选择平台。');
  const contact = app && typeof input.anonymous === 'boolean' && input.contact === undefined ? '' : text('contact', 0, 200);
  const result = { category: input.category, platform: input.platform, title: text('title', 3, 120), message: text('message', 10, 5000), contact, version: text('version', 0, 40) };
  if (app) {
    const { shareBilibiliUid, bilibiliUid, environment, email, anonymous, trackingKeyHash } = input;
    if (email !== undefined) {
      const address = typeof email === 'string' ? email.trim() : email;
      if (address !== '' && !isFeedbackEmail(address)) throw new HttpError(400, '请填写有效的邮箱地址。');
      if (address) result.email = address;
    }
    if (shareBilibiliUid === true) {
      if (!isBilibiliUid(bilibiliUid)) throw new HttpError(400, 'B 站 UID 格式不正确。');
      result.bilibiliUid = bilibiliUid;
    } else if (bilibiliUid !== undefined || (shareBilibiliUid !== undefined && shareBilibiliUid !== false)) {
      throw new HttpError(400, '请先同意附带 B 站 UID。');
    }
    if (environment !== undefined) result.environment = feedbackEnvironment(environment);
    if (anonymous === true) {
      if (result.bilibiliUid || trackingKeyHash !== undefined ||
          (result.category !== 'copyright' && (result.email || result.contact))) {
        throw new HttpError(400, '匿名反馈不能附带账号或联系方式。');
      }
      result.anonymous = true;
    } else if (anonymous === false) {
      if (!result.bilibiliUid || typeof trackingKeyHash !== 'string' || !/^[0-9a-f]{64}$/.test(trackingKeyHash)) {
        throw new HttpError(400, '查看反馈进度需要提供 B 站 UID 和查询凭据。');
      }
      result.anonymous = false;
      result.trackingKeyHash = trackingKeyHash;
    } else if (anonymous !== undefined || trackingKeyHash !== undefined) {
      throw new HttpError(400, '反馈匿名选项格式不正确。');
    }
  }
  if (result.category === 'copyright' && !result.contact && !result.email) {
    throw new HttpError(400, '版权与权利反馈请留下联系方式，以便核实和回复。');
  }
  return result;
}
