import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'

const built = await build({ entryPoints: ['src/domain/commentChapters.ts'], bundle: true, write: false, format: 'esm', platform: 'node' })
const { parseChapterTime, parseCommentChapters, isCommentChapterList, isCommentThreadChapterList, commentChapterCandidates, flattenCommentThread } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

test('comment chapter rows accept tight Chinese text, hours, labels, and numbered lines', () => {
  const message = '@楼主：0:00:00过火\n2. [0：05：00] 爱的代价\n• 09:24｜当你：直播版\n1:03:49 借我一点爱'
  assert.deepEqual(parseCommentChapters(message, 8000), [
    { startMs: 0, title: '过火' }, { startMs: 300000, title: '爱的代价' },
    { startMs: 564000, title: '当你：直播版' }, { startMs: 3829000, title: '借我一点爱' },
  ])
  assert.equal(isCommentChapterList(message, 8000), true)
  assert.equal(parseChapterTime('1:12:30.04'), 4350040)
  assert.equal(parseChapterTime('68:09'), 4089000)
  assert.equal(parseChapterTime('0:89:08'), undefined)
  assert.deepEqual(parseCommentChapters('•0:03：测试\n0:04.125 小节\n0:04:12:34 无效', 60), [
    { startMs: 3000, title: '测试' }, { startMs: 4125, title: '小节' },
  ])
})

test('ordinary timestamp mentions, links, reversed lists, and out-of-part times do not qualify', () => {
  const message = '精彩在 0:12，0:15 而后结束\n0:23 https://www.example.com \n0:35 剩余\n1:60 错误\n10:00 越界'
  assert.deepEqual(parseCommentChapters(message, 60), [{ startMs: 35000, title: '剩余' }])
  assert.equal(isCommentChapterList(message, 60), false)
  assert.equal(isCommentChapterList('0:03 三\n0:01 一\n0:02 二', 60), false)
  assert.equal(isCommentChapterList('0:00 开场\n0:00 重复\n0:01 第二', 60), false)
})

test('a one-line pinned song list accepts titles before the time and keeps title punctuation', () => {
  // BV1tZt9znEaj, first three entries from the pinned comment.
  const message = '歌单说明（歌名见视频）1.可爱女人00:01  2.半岛铁盒01:03  3.暗号03:30 （衔接很好）'
  assert.equal(isCommentChapterList(message, 2499), true)
  assert.deepEqual(parseCommentChapters(message, 2499), [
    { startMs: 1000, title: '可爱女人' }, { startMs: 63000, title: '半岛铁盒' }, { startMs: 210000, title: '暗号' },
  ])
  assert.deepEqual(parseCommentChapters('续帖：17.可爱女人（续1.）25:24  18.夜曲26:06  19.以父之名27:56 （接上面）', 2499), [
    { startMs: 1524000, title: '可爱女人（续1.）' }, { startMs: 1566000, title: '夜曲' }, { startMs: 1676000, title: '以父之名' },
  ])
})

test('a pinned index grouped by headings strips consecutive numbering after Chinese commas', () => {
  // BV1DpJMzMEWB uses a new line for each category, not each chapter.
  const message = '市井奇闻:\n1.牧童奇梦00：13，2.客舫奇遇06：57，3.转运汉14：04\n'
    + '民间传说:\n26.白娘子(上)4：13：11，27.白娘子(下)4：21：38，28.再会出师表4：31：24'
  assert.equal(isCommentChapterList(message, 17838), true)
  assert.deepEqual(parseCommentChapters(message, 17838), [
    { startMs: 13000, title: '牧童奇梦' }, { startMs: 417000, title: '客舫奇遇' }, { startMs: 844000, title: '转运汉' },
    { startMs: 15191000, title: '白娘子(上)' }, { startMs: 15698000, title: '白娘子(下)' }, { startMs: 16284000, title: '再会出师表' },
  ])
})

test('real tracklist formats accept numbered lines, hour marks, ranges and timestamp brackets', () => {
  assert.deepEqual(parseCommentChapters('1 逆光 『逆光』 00:00\n2 第一天 04:57\n20 Let&#39;s Vino 01:15:35', 4756), [
    { startMs: 0, title: '逆光 『逆光』' }, { startMs: 297000, title: '第一天' }, { startMs: 4535000, title: "Let's Vino" },
  ])
  assert.deepEqual(parseCommentChapters('01 - 云宫迅音 \t0:00:05\n02 - 敢问路在何方\t0:02:59', 3090), [
    { startMs: 5000, title: '云宫迅音' }, { startMs: 179000, title: '敢问路在何方' },
  ])
  assert.deepEqual(parseCommentChapters('〖00:00:00〗001.黄昏 〖00:05:44〗002.男人海洋', 900), [
    { startMs: 0, title: '黄昏' }, { startMs: 344000, title: '男人海洋' },
  ])
  assert.deepEqual(parseCommentChapters('段落甲（0:00） 段落乙（1:30）\n1.18 and life 02:00～03:10\n【时间轴】３：１０《尾声》', 240), [
    { startMs: 0, title: '段落甲' }, { startMs: 90000, title: '段落乙' },
    { startMs: 120000, title: '18 and life' }, { startMs: 190000, title: '尾声' },
  ])
  assert.deepEqual(parseCommentChapters('1.00:01 开场  2.01:03 中段  3.03:30 尾声', 240), [
    { startMs: 1000, title: '开场' }, { startMs: 63000, title: '中段' }, { startMs: 210000, title: '尾声' },
  ])
})

const rootId = '90071992547409920'
function comment(idText, message, replies = [], rootIdText = rootId, userName = '楼主') {
  return { id: Number(idText), idText, rootId: Number(rootIdText), rootIdText, message, replies, userName }
}

test('all known nested replies in one floor are merged, with exact dedup and editable conflicts', () => {
  const nested = comment('90071992547409923', '1:03 续三', [], rootId, '另一位用户')
  const continuation = comment('90071992547409921', '0:30 续一\n0:40 原版', [nested])
  const root = comment(rootId, '0:00 开场\n0:10 上半\n0:20 下半', [continuation])
  const otherPage = comment('90071992547409922', '0:30 续一\n0:40 翻唱版\n0:52 续二', [], rootId, '另一位用户')
  const unrelated = comment('90071992547409930', '0:50 其他楼层', [], '90071992547409918')
  const replies = [continuation, otherPage, nested, unrelated]
  // These distinct B 站 IDs all round to the same JavaScript Number.
  assert.equal(new Set(flattenCommentThread(root, replies).map(row => row.id)).size, 1)
  assert.deepEqual(commentChapterCandidates(root, replies, 100).map(({ startMs, title }) => [startMs, title]), [
    [0, '开场'], [10000, '上半'], [20000, '下半'], [30000, '续一'],
    [40000, '原版'], [40000, '翻唱版'], [52000, '续二'], [63000, '续三'],
  ])
})

test('a timeline split across known same-floor replies can show the import action', () => {
  const root = comment(rootId, '目录见回复\n0:00 开场')
  const reply = comment('90071992547409921', '上半 0:10')
  const continuation = comment('90071992547409922', '0:20 下半')
  const unrelated = comment('90071992547409930', '尾声 0:30', [], '90071992547409918')
  assert.equal(isCommentThreadChapterList(root, [reply, unrelated], 120), false)
  assert.equal(isCommentThreadChapterList(root, [reply, continuation], 120), true)
})

test('personal progress replies cannot add a competing chapter to an existing index', () => {
  const root = comment(rootId, '4.张廷秀20：53，5.炼金术31：19，6.错占凤凰39：21')
  const reply = comment('90071992547409921', '自留看到 20:53')
  assert.deepEqual(parseCommentChapters(reply.message, 17838), [])
  assert.deepEqual(commentChapterCandidates(root, [reply], 17838).map(({ title }) => title), ['张廷秀', '炼金术', '错占凤凰'])
})
