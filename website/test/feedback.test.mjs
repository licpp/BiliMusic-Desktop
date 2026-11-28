import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFeedback } from '../validation.mjs';
const input = { category:'bug', platform:'macOS', title:'视频无法加载', message:'点击视频之后始终显示正在加载。',contact:'',version:'0.1.4',consent:true,policyVersion:'2026-10-26',website:'' };
test('normal feedback and optional contact', () => { assert.equal(validateFeedback(input,input.policyVersion).title,input.title); });
test('reject missing consent, stale policy, oversized input and honeypot', () => {
  for (const patch of [{consent:false},{policyVersion:'old'},{message:'x'.repeat(5001)},{website:'spam'},{category:'unknown'}]) assert.throws(() => validateFeedback({...input,...patch},input.policyVersion));
});
test('rights feedback requires a reply channel', () => { assert.throws(() => validateFeedback({...input,category:'copyright'},input.policyVersion)); assert.ok(validateFeedback({...input,category:'copyright',contact:'rights@example.com'},input.policyVersion)); });

test('app feedback validates and separates reply email and other contact', () => {
  const app = { app: true };
  const email = ' Reply+Playback@example.com ';
  const result = validateFeedback({ ...input, email, contact: ' QQ 1234 ' }, input.policyVersion, app);
  assert.equal(result.email, email.trim());
  assert.equal(result.contact, 'QQ 1234');
  assert.equal(validateFeedback({ ...input, email: ' ' }, input.policyVersion, app).email, undefined);
  assert.equal(validateFeedback({ ...input, email }, input.policyVersion).email, undefined);
  for (const invalid of [null, 123, 'one@two', 'one@@example.com', 'one @example.com',
    '.one@example.com', 'o..ne@example.com', 'one.@example.com', 'one@example..com', 'one@-example.com',
    'one@exämple.com', `${'a'.repeat(65)}@example.com`, `one@${'a'.repeat(64)}.com`]) {
    assert.throws(() => validateFeedback({ ...input, email: invalid }, input.policyVersion, app), { status: 400 });
  }
});

test('app rights feedback accepts either reply channel and leaves UID as an optional clue', () => {
  const app = { app: true };
  const rights = { ...input, category: 'copyright', shareBilibiliUid: true, bilibiliUid: '123456' };
  assert.equal(validateFeedback({ ...rights, email: 'rights@example.com' }, input.policyVersion, app).email, 'rights@example.com');
  assert.equal(validateFeedback({ ...rights, contact: 'QQ 1234' }, input.policyVersion, app).contact, 'QQ 1234');
  assert.throws(() => validateFeedback(rights, input.policyVersion, app), { status: 400 });
});

test('explicit app feedback distinguishes anonymous and tracked modes without changing website input', () => {
  const app = { app: true };
  const optedUid = { shareBilibiliUid: true, bilibiliUid: '123456' };
  const trackingKeyHash = 'a'.repeat(64);
  const { contact, ...base } = input;
  const anon = { ...base, anonymous: true };
  const tracked = { ...base, ...optedUid, anonymous: false, trackingKeyHash };
  assert.equal(validateFeedback(anon, input.policyVersion, app).contact, '');
  assert.equal(validateFeedback(tracked, input.policyVersion, app).trackingKeyHash, trackingKeyHash);
  assert.equal(validateFeedback({ ...input, ...tracked }, input.policyVersion).trackingKeyHash, undefined);
  for (const data of [{ ...anon, ...optedUid }, { ...anon, trackingKeyHash }, { ...anon, email: 'reply@example.com' },
    { ...anon, contact: 'QQ 1234' }, { ...tracked, trackingKeyHash: 'A'.repeat(64) },
    { ...tracked, anonymous: undefined }, { ...tracked, shareBilibiliUid: false }, { ...base, anonymous: 'false' }]) {
    assert.throws(() => validateFeedback(data, input.policyVersion, app), { status: 400 });
  }
  assert.equal(validateFeedback({ ...anon, category: 'copyright', email: 'reply@example.com' },
    input.policyVersion, app).email, 'reply@example.com');
});

test('Android users can submit platform-specific feedback', () => { assert.equal(validateFeedback({...input,platform:'Android'},input.policyVersion).platform,'Android'); });
test('HarmonyOS testers can submit platform-specific feedback', () => { assert.equal(validateFeedback({...input,platform:'HarmonyOS'},input.policyVersion).platform,'HarmonyOS'); });

test('app feedback stores an exact UID only when the user opts in', () => {
  const app = { app: true };
  const bilibiliUid = '9007199254740993';
  assert.equal(validateFeedback({ ...input, platform: 'Linux' }, input.policyVersion, app).platform, 'Linux');
  assert.equal(validateFeedback({ ...input, shareBilibiliUid: true, bilibiliUid }, input.policyVersion, app).bilibiliUid, bilibiliUid);
  assert.equal(validateFeedback({ ...input, shareBilibiliUid: false }, input.policyVersion, app).bilibiliUid, undefined);
  assert.equal(validateFeedback({ ...input, shareBilibiliUid: true, bilibiliUid }, input.policyVersion).bilibiliUid, undefined);
  for (const patch of [
    { bilibiliUid }, { shareBilibiliUid: false, bilibiliUid }, { shareBilibiliUid: true },
    ...[123, '0123', '+123', '0', '9223372036854775808', '123 '].map(value => ({ shareBilibiliUid: true, bilibiliUid: value })),
    { category: 'copyright', shareBilibiliUid: true, bilibiliUid },
  ]) {
    assert.throws(() => validateFeedback({ ...input, ...patch }, input.policyVersion, app), { status: 400 });
  }
});

test('app feedback accepts the current structured device environment only', () => {
  const app = { app: true };
  const environment = {
    system: 'Android 10', systemBuild: 'QP1A.190711.020', apiLevel: 29, deviceModel: 'Car Head Unit',
    architecture: 'aarch64', webview: 'Android WebView 66.0.3359.158', webviewPackage: 'com.google.android.webview', largeScreen: true,
  };
  assert.deepEqual(validateFeedback({ ...input, environment }, input.policyVersion, app).environment, environment);
  assert.equal(validateFeedback({ ...input, environment }, input.policyVersion).environment, undefined);
  for (const patch of [
    { cookie: 'private' }, { deviceModel: 'https://other.example' }, { system: '' }, { webview: null },
    { apiLevel: 0 }, { apiLevel: '29' }, { largeScreen: 'true' },
  ]) {
    assert.throws(() => validateFeedback({ ...input, environment: { ...environment, ...patch } }, input.policyVersion, app), { status: 400 });
  }
  assert.throws(() => validateFeedback({ ...input, policyVersion: 'old' }, input.policyVersion, app), {
    status: 409, code: 'feedback_policy_changed',
  });
});
