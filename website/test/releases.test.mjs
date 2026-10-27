import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveDownload } from '../releases.mjs';
const request = { platform:'mac',source:'github',consent:true,policyVersion:'current' };
test('only declared release files are returned after current consent', () => {
  const result = resolveDownload(request,'current');
  assert.ok(result.url.endsWith('.dmg')); assert.match(result.sha256,/^[a-f0-9]{64}$/);
  for (const patch of [{consent:false},{policyVersion:'old'},{source:'https://example.com'},{platform:'android'}]) assert.throws(() => resolveDownload({...request,...patch},'current'));
});
test('reject unavailable mirror and external redirect configuration', () => {
  const manifest = {platforms:[{id:'mac',status:'available',channels:[{id:'gitee',url:null},{id:'github',url:'https://github.com.evil.test/file'}]}]};
  assert.throws(() => resolveDownload({...request,source:'gitee'},'current',manifest));
  assert.throws(() => resolveDownload(request,'current',manifest));
});
