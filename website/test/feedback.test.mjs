import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFeedback } from '../validation.mjs';
const input = { category:'bug', platform:'macOS', title:'视频无法加载', message:'点击视频之后始终显示正在加载。',contact:'',version:'0.1.4',consent:true,policyVersion:'2026-10-26',website:'' };
test('normal feedback and optional contact', () => { assert.equal(validateFeedback(input,input.policyVersion).title,input.title); });
test('reject missing consent, stale policy, oversized input and honeypot', () => {
  for (const patch of [{consent:false},{policyVersion:'old'},{message:'x'.repeat(5001)},{website:'spam'},{category:'unknown'}]) assert.throws(() => validateFeedback({...input,...patch},input.policyVersion));
});
test('rights feedback requires a reply channel', () => { assert.throws(() => validateFeedback({...input,category:'copyright'},input.policyVersion)); assert.ok(validateFeedback({...input,category:'copyright',contact:'rights@example.com'},input.policyVersion)); });
