import test from 'node:test'
import assert from 'node:assert/strict'
import {build} from 'esbuild'

const built = await build({entryPoints: ['src/domain/recommendation.ts'], bundle: true, write: false, format: 'esm'})
const {
  recommendationDay, recommendationDayLabel, defaultRecommendationSourceName, recommendationSourceName,
  validateRecommendationSourceName, canApplyAutomaticMatch, bindRecommendationSong,
  playableRecommendationTracks, recommendationPlaybackNotice,
  recommendationMatchSummary, recommendationPendingSongs, replaceRecommendationSong,
  recommendationRetryDelay, qrPollingCanRetry, isNeteaseLoginCancelled, commandErrorCode,
  recommendationPlaylistName, folderPlayableTracks,
} = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const track = (id, bvid = `BV${id.padEnd(10, '0')}`) => ({
  id, source: {provider: 'bilibili', bvid, cid: 1, page: 1}, title: `B 站 ${id}`, durationSeconds: 180, liked: false,
})
const song = (id, position, extra = {}) => ({
  sourceId: 'source-1', day: '2026-11-24', position, neteaseSongId: id, title: `歌 ${id}`, artists: ['歌手'],
  matchState: 'pending', entryRevision: 0, matchAttempts: 0, ...extra,
})

test('the recommendation day changes at 06:00 Asia/Shanghai, not at UTC midnight', () => {
  assert.equal(recommendationDay(new Date('2026-11-25T21:59:59.999Z')), '2026-11-25')
  assert.equal(recommendationDay(new Date('2026-11-25T22:00:00.000Z')), '2026-11-26')
  assert.equal(recommendationDay(new Date('2026-11-25T00:00:00.000Z')), '2026-11-25')
})

test('the day bucket handles month and year rollovers', () => {
  assert.equal(recommendationDay(new Date('2026-12-31T21:59:59.999Z')), '2026-12-31')
  assert.equal(recommendationDay(new Date('2026-12-31T22:00:00.000Z')), '2027-01-01')
  assert.equal(recommendationDay(new Date('2025-12-31T22:00:00.000Z')), '2026-01-01')
})

test('the banner label is DD / MM and tolerates a missing day', () => {
  assert.deepEqual(recommendationDayLabel('2026-11-24'), {day: '24', month: '11', display: '24 / 11'})
  assert.deepEqual(recommendationDayLabel('invalid'), {day: '--', month: '--', display: '-- / --'})
})

test('default source names follow the nickname and fall back to an ordinal', () => {
  assert.equal(defaultRecommendationSourceName('小明'), '网易云音乐 · 小明')
  assert.equal(defaultRecommendationSourceName('  小明  '), '网易云音乐 · 小明')
  assert.equal(defaultRecommendationSourceName('', 2), '推荐源 2')
  assert.equal(recommendationSourceName({name: '旧的默认名', nameCustom: false, nickname: '小明'}), '网易云音乐 · 小明')
  assert.equal(recommendationSourceName({name: '我的推荐', nameCustom: true, nickname: '小明'}), '我的推荐')
})

test('source names reject empty, overlong and control-character values', () => {
  assert.equal(validateRecommendationSourceName('我的推荐'), undefined)
  assert.ok(validateRecommendationSourceName('   '))
  assert.ok(validateRecommendationSourceName('名'.repeat(41)))
  assert.ok(validateRecommendationSourceName('坏\u0000名'))
})

test('automatic matching cannot overwrite a manual choice or a stale revision', () => {
  assert.equal(canApplyAutomaticMatch(song('1', 1), 0), true)
  assert.equal(canApplyAutomaticMatch(song('1', 1, {entryRevision: 2}), 1), false)
  assert.equal(canApplyAutomaticMatch(song('1', 1, {matchMode: 'manual', entryRevision: 2}), 2), false)
  assert.equal(bindRecommendationSong(song('1', 1, {matchMode: 'manual', entryRevision: 2}), track('1'), 'automatic', 2, 1), undefined)
  assert.equal(bindRecommendationSong(song('1', 1), track('1'), 'automatic', 1, 1), undefined)
})

test('manual binding overrides an automatic match and increments the row revision', () => {
  const bound = bindRecommendationSong(song('1', 1, {matchState: 'matched', matchMode: 'automatic', entryRevision: 1}), track('1'), 'manual', 1, 99)
  assert.equal(bound.matchMode, 'manual')
  assert.equal(bound.matchState, 'matched')
  assert.equal(bound.entryRevision, 2)
  assert.equal(bound.matchAttempts, 1)
  assert.equal(bound.bvid, 'BV1000000000')
  assert.equal(bound.cid, 1)
  assert.equal(bound.matchedAt, 99)
})

test('a successful bind clears the previous retry and error state', () => {
  const bound = bindRecommendationSong(
    song('1', 1, {matchState: 'failed', matchRetryAt: 500, matchErrorCode: 'provider_error'}),
    track('1'), 'automatic', 0, 99,
  )
  assert.equal(bound.matchState, 'matched')
  assert.equal(bound.matchRetryAt, undefined)
  assert.equal(bound.matchErrorCode, undefined)
})

test('the match summary counts every state exactly once', () => {
  const summary = recommendationMatchSummary([
    song('1', 1, {matchState: 'matched'}),
    song('2', 2, {matchState: 'missing'}),
    song('3', 3, {matchState: 'failed'}),
    song('4', 4),
    song('5', 5, {matchState: 'pending'}),
  ])
  assert.deepEqual(summary, {total: 5, matched: 1, pending: 2, missing: 1, failed: 1})
  assert.deepEqual(recommendationMatchSummary([]), {total: 0, matched: 0, pending: 0, missing: 0, failed: 0})
})

test('only pending songs whose retry time has passed are matched again', () => {
  const songs = [
    song('1', 1),
    song('2', 2, {matchRetryAt: 200}),
    song('3', 3, {matchRetryAt: 100}),
    song('4', 4, {matchRetryAt: 300}),
    song('5', 5, {matchState: 'matched'}),
    song('6', 6, {matchState: 'missing'}),
    song('7', 7, {matchState: 'failed'}),
  ]
  assert.deepEqual(recommendationPendingSongs(songs, 150).map(item => item.neteaseSongId), ['1', '3'])
  assert.deepEqual(recommendationPendingSongs(songs, 0).map(item => item.neteaseSongId), ['1'])
  assert.deepEqual(recommendationPendingSongs(songs, 250).map(item => item.neteaseSongId), ['1', '2', '3'])
})

test('a single row update replaces only its own entry in the snapshot', () => {
  const snapshot = {
    source: {id: 'source-1'}, day: '2026-11-24', songCount: 2,
    songs: [song('1', 1), song('2', 2)],
  }
  const updated = replaceRecommendationSong(snapshot, song('2', 2, {matchState: 'matched'}))
  assert.equal(updated.songs[0], snapshot.songs[0])
  assert.equal(updated.songs[1].matchState, 'matched')
  assert.equal(updated.songCount, 2)
  const otherDay = replaceRecommendationSong(snapshot, song('2', 2, {day: '2026-11-23', matchState: 'matched'}))
  assert.equal(otherDay.songs[1].matchState, 'pending')
})

test('the retry delay is clamped and ignores a missing timestamp', () => {
  assert.equal(recommendationRetryDelay(undefined, 100), undefined)
  assert.equal(recommendationRetryDelay(Number.NaN, 100), undefined)
  assert.equal(recommendationRetryDelay(500, 100), 400)
  assert.equal(recommendationRetryDelay(50, 100), 0)
})

test('play-all keeps upstream order, includes only matched tracks and de-duplicates', () => {
  const tracks = playableRecommendationTracks([
    song('3', 3, {matchState: 'matched', track: track('3')}),
    song('1', 1, {matchState: 'matched', track: track('1')}),
    song('2', 2, {matchState: 'missing'}),
    song('4', 4, {matchState: 'matched', track: track('1')}),
  ])
  assert.deepEqual(tracks.map(item => item.id), ['1', '3'])
})

test('play-all explains skipped songs instead of silently dropping them', () => {
  assert.equal(recommendationPlaybackNotice(0, 0), '今天还没有推荐歌曲')
  assert.equal(recommendationPlaybackNotice(3, 0), '共 3 首，暂无可播放的 B 站匹配')
  assert.equal(recommendationPlaybackNotice(3, 2), '共 3 首，已匹配 2 首；未匹配的 1 首不会播放')
  assert.equal(recommendationPlaybackNotice(2, 2), undefined)
})

test('qr polling stops for terminal errors and keeps retrying transient ones', () => {
  // Terminal: the attempt is gone or the account needs a verification the app
  // cannot perform by polling again.
  assert.equal(qrPollingCanRetry({code: 'netease_login_attempt_unknown', retryable: false}), false)
  assert.equal(qrPollingCanRetry({code: 'netease_verification_required', retryable: false}), false)
  // Transient: an outage or a rate limit can heal on its own.
  assert.equal(qrPollingCanRetry({code: 'netease_unavailable', retryable: true}), true)
  assert.equal(qrPollingCanRetry({code: 'netease_rate_limited', retryable: true}), true)
  // Errors without the flag keep the previous retry behaviour.
  assert.equal(qrPollingCanRetry(new Error('boom')), true)
  assert.equal(qrPollingCanRetry('boom'), true)
  assert.equal(qrPollingCanRetry(undefined), true)
})

test('closing the embedded login window returns to the login intro rather than an error', () => {
  assert.equal(isNeteaseLoginCancelled({code: 'netease_login_cancelled', message: '已取消网易云登录'}), true)
  assert.equal(isNeteaseLoginCancelled({code: 'netease_login_timeout'}), false)
  assert.equal(isNeteaseLoginCancelled(new Error('netease_login_cancelled')), false)
  assert.equal(isNeteaseLoginCancelled(undefined), false)
})

test('only the safety gate offers the official-page login as a fallback', () => {
  // 8821 answers every QR poll the same way, so switching login method is the
  // one action that can still succeed on Android.
  assert.equal(commandErrorCode({code: 'netease_verification_required', retryable: false}), 'netease_verification_required')
  assert.equal(commandErrorCode({code: 'netease_login_timeout', retryable: true}), 'netease_login_timeout')
  // Anything without a stable command code must not open the fallback.
  assert.equal(commandErrorCode(new Error('boom')), undefined)
  assert.equal(commandErrorCode({code: 42}), undefined)
  assert.equal(commandErrorCode(null), undefined)
  assert.equal(commandErrorCode('netease_verification_required'), undefined)
})

test('a playlist created from today starts with a readable default name', () => {
  assert.equal(recommendationPlaylistName('2026-11-26'), '每日推荐 11月26日')
  assert.equal(recommendationPlaylistName('2026-01-05'), '每日推荐 1月5日')
  // An unexpected day must not produce "undefined月" in a name the user sees.
  assert.equal(recommendationPlaylistName(''), '每日推荐')
  assert.equal(recommendationPlaylistName('not-a-day'), '每日推荐')
})

test('a Bilibili folder only takes whole single-part videos and never repeats one', () => {
  const single = {...track('a'), partCount: 1}
  const multi = {...track('b'), partCount: 3}
  // Same video as `single`, reached through a different match.
  const duplicate = {...track('c'), partCount: 1, source: {provider: 'bilibili', bvid: single.source.bvid, cid: 7, page: 1}}
  // Unknown part count is treated as a single-part video.
  const unknown = track('d')
  const {included, skipped} = folderPlayableTracks([single, multi, duplicate, unknown])
  assert.deepEqual(included.map(item => item.id), ['a', 'd'])
  assert.equal(skipped, 2)
  assert.deepEqual(folderPlayableTracks([]), {included: [], skipped: 0})
})
