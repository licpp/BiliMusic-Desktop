import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)
const { outputFiles: [output] } = await build({
  stdin: {
    contents: "export { resolveVipBadge } from './src/domain/account'; export { ProfileBadges } from './src/features/account/ProfileBadges'",
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  external: ['react', 'react/jsx-runtime'],
  jsx: 'automatic',
})
const mod = { exports: {} }
new Function('exports', 'require', 'module', output.text)(mod.exports, require, mod)
const { resolveVipBadge, ProfileBadges } = mod.exports

test('resolveVipBadge classifies monthly, annual, 10-year and 100-year VIP tiers', () => {
  assert.equal(resolveVipBadge({ vipActive: false, vipType: 2, vipTheme: 'annual_vip', vipLabel: '年度大会员' }), null)
  assert.deepEqual(resolveVipBadge({ vipActive: true, vipType: 1, vipTheme: 'vip', vipLabel: '大会员' }), { tier: 'vip', label: '大会员' })
  assert.deepEqual(resolveVipBadge({ vipActive: true, vipType: 2, vipTheme: 'annual_vip', vipLabel: '年度大会员' }), { tier: 'annual', label: '年度大会员' })
  assert.deepEqual(resolveVipBadge({ vipActive: true, vipType: 2 }), { tier: 'annual', label: '年度大会员' })
  assert.deepEqual(resolveVipBadge({ vipActive: true, vipType: 2, vipTheme: 'ten_annual_vip', vipLabel: '十年大会员' }), { tier: 'ten_annual', label: '十年大会员' })
  assert.deepEqual(resolveVipBadge({ vipActive: true, vipType: 2, vipTheme: 'hundred_annual_vip', vipLabel: '百年大会员' }), { tier: 'hundred_annual', label: '百年大会员' })
})

test('ProfileBadges renders authentic LV6 senior bolt and tiered VIP emblems', () => {
  const html = renderToStaticMarkup(createElement(ProfileBadges, {
    level: 6,
    seniorMember: true,
    vipActive: true,
    vipType: 2,
    vipTheme: 'ten_annual_vip',
    vipLabel: '十年大会员',
  }))
  assert.match(html, /data-level="6"/)
  assert.match(html, /data-senior="true"/)
  assert.match(html, /account-senior-bolt/)
  assert.match(html, /data-vip-tier="ten_annual"/)
  assert.match(html, /十年大会员/)
})
