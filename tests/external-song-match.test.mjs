import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { readFile } from 'node:fs/promises'

const { outputFiles } = await build({ entryPoints: ['src/services/externalSongMatch.ts'], bundle: true, write: false, format: 'esm' })
const { rankSongCandidates, rankDurationFirstSongCandidates } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
const song = (title = '晴天', artists = ['周杰伦'], durationSeconds = 269) => ({ title, artists, durationSeconds })
const candidate = (title = '周杰伦《晴天》官方 MV', extra = {}) => ({
  bvid: 'BV_FIXTURE', cid: 101, title, durationSeconds: 270, partCount: 1, detailsVerified: true, ...extra,
})

const scenarios = [
  ['原唱：歌名歌手与时长一致', song(), [candidate()], 'automatic'],
  ['UP 名称相同不能代替歌手', song(), [candidate('晴天', { uploaderName: '周杰伦' })], 'review'],
  ['播放量很高也不能消除翻唱冲突', song(), [candidate('周杰伦《晴天》翻唱', { playCount: 1e9 })], 'review'],
  ['相同时长的 Live 不能自动代替录音室版', song(), [candidate('周杰伦《晴天》Live')], 'review'],
  ['伴奏不能自动代替有人声的歌曲', song(), [candidate('周杰伦《晴天》伴奏')], 'review'],
  ['Remix 不能自动代替原版', song(), [candidate('周杰伦《晴天》Remix')], 'review'],
  ['用户明确要 Live 时保留对应版本', song('晴天 (Live)'), [candidate('周杰伦《晴天》Live')], 'automatic'],
  ['用户明确要伴奏时保留对应版本', song('晴天 (伴奏)'), [candidate('周杰伦《晴天》伴奏')], 'automatic'],
  ['用户明确要 Live 不能选无版本证据的原版', song('晴天 (Live)'), [candidate()], 'review'],
  ['高分近似的两个版本不擅自选一个', song(), [candidate(), candidate('周杰伦《晴天》官方音频', { bvid: 'BV_OTHER', cid: 102 })], 'review'],
  ['时长明显不符需要确认', song(), [candidate(undefined, { durationSeconds: 140 })], 'review'],
  ['外部歌单未提供时长需要确认', song('晴天', ['周杰伦'], 0), [candidate()], 'review'],
  ['搜索结果尚未确认分 P 时不能直接导入', song(), [candidate(undefined, { cid: undefined, detailsVerified: false, partCount: undefined })], 'review'],
  ['多 P 整体时长不能作为分 P 证据', song(), [candidate(undefined, { cid: undefined, detailsVerified: false, partCount: 30 })], 'review'],
  ['真实分 P 可继承父视频歌手上下文', song(), [candidate('晴天', { partCount: 30, videoTitle: '周杰伦音乐合集' })], 'automatic'],
  ['父视频包含目标歌名不代表子分 P 就是这首歌', song(), [candidate('七里香', { partCount: 30, videoTitle: '周杰伦：晴天 / 七里香合集' })], 'missing'],
  ['没有歌手不擅自确认', song('晴天', []), [candidate()], 'review'],
  ['空标题不能匹配任意候选', song(''), [candidate()], 'missing'],
  ['英文曲名必须按词匹配', song('Star', ['Artist'], 200), [candidate('Artist - Starlight', { durationSeconds: 200 })], 'missing'],
  ['HTML 实体与全角字符可正常归一化', song("Don't Stop", ['Artist'], 200), [candidate('Ａｒｔｉｓｔ — Don&#39;t Stop', { durationSeconds: 201 })], 'automatic'],
  ['多歌手逐个识别', song('因为爱情', ['陈奕迅', '王菲'], 215), [candidate('陈奕迅 / 王菲《因为爱情》', { durationSeconds: 216 })], 'automatic'],
  ['曲名拼写近似只进人工确认', song('Beautiful World', ['Artist'], 200), [candidate('Artist Beautiful Wrold', { durationSeconds: 200 })], 'review'],
  ['短曲名嵌入另一标题不能自动确认', song('十年', ['陈奕迅'], 205), [candidate('陈奕迅 这十年的回顾', { durationSeconds: 205 })], 'review'],
  ['加速版不能自动代替原版', song(), [candidate('周杰伦《晴天》Sped Up')], 'review'],
  ['不同语言版本需要确认', song(), [candidate('周杰伦《晴天》粤语版')], 'review'],
  ['重制版不能直接等同原版', song('晴天 (Remastered 2022)'), [candidate()], 'review'],
  ['合唱只命中一位歌手不能自动确认', song('因为爱情', ['陈奕迅', '王菲'], 215), [candidate('陈奕迅《因为爱情》', { durationSeconds: 216 })], 'review'],
  ['竞争候选缺少详情不能制造虚假的分差', song(), [candidate(), candidate('周杰伦《晴天》', { bvid: 'BV_UNRESOLVED', cid: undefined, partCount: undefined, detailsVerified: false })], 'review'],
  ['已确认的其他版本不应挤占正确原版的排序', song(), [candidate('周杰伦《晴天》Live', { bvid: 'BV_LIVE', cid: 102, playCount: 1e9 }), candidate()], 'automatic'],
]
for (const [name, source, candidates, expected] of scenarios) {
  test(`外部歌单匹配：${name}`, () => assert.equal(rankSongCandidates(source, candidates).decision, expected))
}
test('来源提供的别名可以参与匹配，不自行编造译名', () => {
  const result = rankSongCandidates({ ...song('Original Title', ['Artist'], 200), aliases: ['官方译名'] }, [candidate('Artist《官方译名》', { durationSeconds: 200 })])
  assert.equal(result.decision, 'automatic')
})
test('重复搜索结果不会人为降低置信度，同 BV 不同 CID 不会合并', () => {
  const first = candidate()
  assert.equal(rankSongCandidates(song(), [first, { ...first }]).decision, 'automatic')
  assert.equal(rankSongCandidates(song(), [first, candidate(undefined, { cid: 102 })]).ranked.length, 2)
  assert.equal(rankSongCandidates(song(), [first, candidate(undefined, { cid: undefined, detailsVerified: false })]).ranked.length, 1)
})
test('分 P 详情请求去重并最多给出三个候选 BV', () => {
  const result = rankSongCandidates(song(), Array.from({ length: 20 }, (_, i) => candidate(undefined, { bvid: `BV_${i}`, cid: undefined, detailsVerified: false })))
  assert.equal(result.detailBvids.length, 3)
})
const live = JSON.parse(await readFile(new URL('./fixtures/external-song-match-live.json', import.meta.url), 'utf8'))
test('时长优先实验：同版本中连续时长分能区分旧规则的同档候选', () => {
  const result = rankDurationFirstSongCandidates(song(), [candidate(undefined, { cid: 101, durationSeconds: 274 }), candidate(undefined, { cid: 102, durationSeconds: 269 })])
  assert.equal(result.ranked[0].candidate.cid, 102)
})
test('时长优先实验：时长吻合不能让翻唱压过原版', () => {
  const result = rankDurationFirstSongCandidates(song(), [candidate('周杰伦《晴天》翻唱', { cid: 101, durationSeconds: 269 }), candidate(undefined, { cid: 102, durationSeconds: 271 })])
  assert.equal(result.ranked[0].candidate.cid, 102)
})
test('时长优先实验：优先直接音轨，降低外放翻录优先级', () => {
  const result = rankDurationFirstSongCandidates(song(), [candidate('周杰伦《晴天》车载音响', { cid: 101, durationSeconds: 269 }), candidate(undefined, { cid: 102, durationSeconds: 270 })])
  assert.equal(result.ranked[0].candidate.cid, 102)
})
test('时长优先实验：双语括号名可用主标题召回，Live 括号不会当译名去掉', () => {
  assert.equal(rankDurationFirstSongCandidates(song('晚安 (Good Night)'), [candidate('周杰伦《晚安》')]).ranked.length, 1)
  assert.equal(rankDurationFirstSongCandidates(song('晴天 (Live)'), [candidate()]).ranked[0].versionConflict, true)
})
test('时长优先实验：简介能识别标题未标注的外放翻录', () => {
  const result = rankDurationFirstSongCandidates(song(), [candidate(undefined, { cid: 101, durationSeconds: 269, description: '音响：设备A，麦克风现场收录' }), candidate(undefined, { cid: 102, durationSeconds: 270 })])
  assert.equal(result.ranked[0].candidate.cid, 102)
})
test('时长优先实验：竞争者缺少详情仍需确认', () => {
  const result = rankDurationFirstSongCandidates(song(), [candidate(), candidate(undefined, { bvid: 'BV_UNRESOLVED', cid: undefined, detailsVerified: false, partCount: undefined })])
  assert.equal(result.decision, 'review')
})
test('真实接口快照：网易云普通版本与 B 站官方 MV 的曲名歌手时长可对上', () => {
  const ordinary = live.songs.filter(source => !source.title.includes('Remastered'))
  assert.equal(ordinary.length, 4)
  for (const source of ordinary) {
    const result = rankSongCandidates(source, [live.candidate])
    assert.equal(result.decision, 'automatic')
    assert.equal(result.ranked[0].candidate.cid, 137649199)
  }
})
test('真实接口快照：重制版来源不擅自匹配为普通官方 MV', () => {
  const remaster = live.songs.find(source => source.title.includes('Remastered'))
  assert.ok(remaster)
  assert.equal(rankSongCandidates(remaster, [live.candidate]).decision, 'review')
})
