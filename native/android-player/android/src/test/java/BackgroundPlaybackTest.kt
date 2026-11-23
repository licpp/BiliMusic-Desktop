package app.bilimusic.player

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.MediaPlayer
import android.media.session.MediaSession
import android.media.session.MediaSessionManager
import android.media.session.PlaybackState
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.WindowManager
import android.widget.LinearLayout
import androidx.media3.common.Player
import androidx.media3.session.MediaSession as Media3Session
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.Implements
import org.robolectric.annotation.Implementation
import org.robolectric.annotation.RealObject
import org.robolectric.shadow.api.Shadow
import org.robolectric.util.ReflectionHelpers.ClassParameter
import org.robolectric.shadows.ShadowMediaPlayer
import org.robolectric.shadows.ShadowMediaSession
import org.robolectric.shadows.ShadowSettings
import org.robolectric.shadows.ShadowWindowManagerImpl
import org.robolectric.shadows.util.DataSource
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28, 35], manifest = Config.NONE, shadows = [RecordingMediaSessionShadow::class])
class BackgroundPlaybackTest {
    private lateinit var service: PlaybackService
    private lateinit var profile: File
    private val requests = mutableListOf<Pair<Long, JSONObject>>()
    private val lyricRequests = mutableListOf<Pair<Long, JSONObject>>()
    private val url = "http://127.0.0.1:1234/token/test"
    private fun track(id: String) = JSONObject().put("id", id).put("title", "song $id").put("album", "album $id").put("durationSeconds", 120)
        .put("source", JSONObject().put("provider", "bilibili").put("bvid", "BV123").put("cid", id.toInt()).put("page", id.toInt()))
    private fun field(name: String): Any? = PlaybackService::class.java.getDeclaredField(name).apply { isAccessible = true }.get(service)
    private fun player() = field("player") as MediaPlayer
    private fun session() = field("session") as Media3Session
    private fun mediaSession() = checkNotNull(RecordingMediaSessionShadow.active)
    private fun idle() { shadowOf(android.os.Looper.getMainLooper()).idle() }
    private fun load(artist: String = "") {
        service.onStartCommand(Intent(service, PlaybackService::class.java).setAction("load").putExtra("id", "1")
            .putExtra("url", url).putExtra("title", "song 1").putExtra("artist", artist), 0, 1)
        idle()
        assertEquals("playing", service.snapshot().getString("status"))
    }
    private fun reply(request: Pair<Long, JSONObject>) {
        service.resolved(request.first, JSONObject().put("url", url).put("track", request.second.getJSONObject("track")).put("position", request.second.optDouble("position", 0.0)))
        idle()
    }
    @Before fun setup() {
        RecordingMediaSessionShadow.active = null
        profile = File.createTempFile("bilimusic-native-profile", ".txt").apply { writeText("account") }
        PlaybackService.profilePath = profile.path; PlaybackService.listener = null
        PlaybackService.queueData = JSONObject().put("tracks", JSONArray(listOf(track("1"), track("2"), track("3"))))
            .put("repeatMode", "off").toString()
        PlaybackService.resolveListener = { request, payload ->
            val destination = if (payload.optString("kind") == "lyrics") lyricRequests else requests
            destination.add(request to payload)
        }
        ShadowMediaPlayer.addMediaInfo(DataSource.toDataSource(url), ShadowMediaPlayer.MediaInfo(120_000, 0))
        service = Robolectric.buildService(PlaybackService::class.java).create().get()
    }
    @After fun cleanup() {
        service.onDestroy(); profile.delete()
        PlaybackService.listener = null; PlaybackService.resolveListener = null; PlaybackService.listeningListener = null
        PlaybackService.controllerListener = null; PlaybackService.queueData = null; PlaybackService.profilePath = null
    }
    @Test fun floatingLyricsReopenAtTheDraggedPositionAfterServiceRestart() {
        ShadowSettings.setCanDrawOverlays(true)
        fun enable(enabled: Boolean) {
            val result = FloatingLyricsOverlay.command(service,
                JSONObject().put("action", "enable").put("enabled", enabled).toString())
            assertEquals(enabled, result.getBoolean("enabled"))
            idle()
        }
        fun overlay(): LinearLayout {
            val manager = service.getSystemService(Context.WINDOW_SERVICE)
            return Shadow.extract<ShadowWindowManagerImpl>(manager).views.filterIsInstance<LinearLayout>().single()
        }
        fun position(view: LinearLayout): Pair<Int, Int> {
            val params = view.layoutParams as WindowManager.LayoutParams
            return params.x to params.y
        }
        enable(true)
        val row = overlay()
        val initial = position(row)
        val firstLyric = row.getChildAt(0)
        for ((action, y) in listOf(MotionEvent.ACTION_DOWN to 160f, MotionEvent.ACTION_MOVE to 30f, MotionEvent.ACTION_UP to 30f)) {
            val event = MotionEvent.obtain(0, 10, action, 32f, y, 0)
            try { assertTrue(firstLyric.dispatchTouchEvent(event)) } finally { event.recycle() }
        }
        val moved = position(row)
        assertTrue(moved.second < initial.second)
        enable(false)
        enable(true)
        assertEquals(moved, position(overlay()))
        service.onDestroy()
        service = Robolectric.buildService(PlaybackService::class.java).create().get()
        enable(true)
        assertEquals(moved, position(overlay()))
        enable(false)
    }
    @Test fun defaultOutputIsFullAndExplicitResumeClearsStaleDucking() {
        load()
        assertEquals(1f, shadowOf(player()).leftVolume, .000001f)
        val focus = shadowOf(service.getSystemService(AudioManager::class.java)).lastAudioFocusRequest
        focus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK)
        assertEquals(.2f, shadowOf(player()).leftVolume, .000001f)
        service.control("pause")
        service.control("resume")
        assertEquals(1f, shadowOf(player()).leftVolume, .000001f)
    }
    @Test fun loudnessSurvivesFocusVolumeAndNativeQueueWithoutDoubleAttenuation() {
        service.onStartCommand(Intent(service,PlaybackService::class.java).setAction("load").putExtra("id","1")
            .putExtra("url",url).putExtra("volume",.8).putExtra("loudnessGainDb",-6.0)
            .putExtra("loudnessEnabled",true).putExtra("loudnessRevision",2L),0,1)
        idle()
        val expected=(.8*Math.pow(10.0,-6.0/20)).toFloat()
        assertEquals(expected,shadowOf(player()).leftVolume,.000001f)
        val focus=shadowOf(service.getSystemService(AudioManager::class.java)).lastAudioFocusRequest
        focus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK)
        assertEquals(expected*.2f,shadowOf(player()).leftVolume,.000001f)
        focus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN)
        assertEquals(expected,shadowOf(player()).leftVolume,.000001f)
        service.control("volume",.6)
        assertEquals((.6*Math.pow(10.0,-6.0/20)).toFloat(),shadowOf(player()).leftVolume,.000001f)
        service.control("next")
        val request=requests.last()
        service.resolved(request.first,JSONObject().put("url",url).put("track",request.second.getJSONObject("track")).put("loudnessGainDb",-9.0))
        idle()
        assertEquals((.6*Math.pow(10.0,-9.0/20)).toFloat(),shadowOf(player()).leftVolume,.000001f)
        service.configureLoudness(false,3L)
        shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(340))
        assertEquals(.6f,shadowOf(player()).leftVolume,.000001f)
        service.configureLoudness(true,2L)
        assertEquals(.6f,shadowOf(player()).leftVolume,.000001f)
    }
    @Test fun completedTracksAdvanceWithoutAnyWebViewListener() {
        load(); shadowOf(player()).invokeCompletionListener()
        assertEquals("2", requests.single().second.getJSONObject("track").getString("id"))
        reply(requests.last()); assertEquals("2", service.snapshot().getString("id"))
        assertEquals("playing", service.snapshot().getString("status"))
        shadowOf(player()).invokeCompletionListener(); reply(requests.last())
        shadowOf(player()).invokeCompletionListener()
        assertEquals(2, requests.size); assertEquals("paused", service.snapshot().getString("status"))
    }
    @Test fun grantingNotificationsRepostsTheCurrentMediaSessionWithoutRestartingPlayback() {
        val manager = service.getSystemService(NotificationManager::class.java)
        service.refreshPlaybackNotification()
        assertTrue(manager.activeNotifications.isEmpty())

        load()
        service.control("next")
        reply(requests.last())
        service.control("seek", 21.0)
        idle()
        val currentPlayer = player()
        val previousNotification = manager.activeNotifications.single()
        manager.cancel(previousNotification.id)
        service.refreshPlaybackNotification()

        val notification = manager.activeNotifications.single().notification
        assertEquals(Notification.CATEGORY_TRANSPORT, notification.category)
        assertEquals("song 2", notification.extras.getCharSequence(Notification.EXTRA_TITLE))
        @Suppress("DEPRECATION")
        assertEquals(session().platformToken,
            notification.extras.getParcelable<MediaSession.Token>(Notification.EXTRA_MEDIA_SESSION))
        assertSame(currentPlayer, player())
        assertEquals("playing", service.snapshot().getString("status"))
        assertEquals(21.0, service.snapshot().getDouble("position"), 0.1)
    }
    @Test fun pauseAndRapidSkipInvalidateLateResolverReplies() {
        load(); service.control("next"); val old = requests.last()
        service.control("next"); val latest = requests.last()
        reply(old); assertEquals("3", service.snapshot().getString("id")); assertTrue(service.snapshot().getBoolean("stopped"))
        service.control("pause"); reply(latest)
        assertEquals("paused", service.snapshot().getString("status")); assertTrue(service.snapshot().getBoolean("stopped"))
        assertNull(field("transitionWakeLock"))
    }
    @Test fun accountChangeRejectsAnOldBackgroundReply() {
        load(); service.control("next"); profile.writeText("different-account"); reply(requests.last())
        assertEquals("error", service.snapshot().getString("status")); assertTrue(service.snapshot().getBoolean("stopped"))
        assertEquals("account_changed", service.snapshot().getString("errorCode"))
    }
    @Test fun aFreshGuestCanAdvanceAndRecoverBeforeTheAccountMarkerExists() {
        assertTrue(profile.delete())
        load()
        service.control("next")
        val next = requests.single()
        assertEquals("", next.second.getString("profile"))
        reply(next)
        assertEquals("2", service.snapshot().getString("id"))
        shadowOf(player()).invokeErrorListener(MediaPlayer.MEDIA_ERROR_UNKNOWN, MediaPlayer.MEDIA_ERROR_IO)
        val recovery = requests.last()
        assertTrue(recovery.second.getBoolean("refresh"))
        assertEquals("", recovery.second.getString("profile"))
        reply(recovery)
        assertEquals("playing", service.snapshot().getString("status"))
        assertFalse(service.snapshot().has("errorCode"))
    }
    @Test fun aDamagedProfileMarkerIsNotAnAccountChange() {
        load()
        profile.writeBytes(byteArrayOf(0xff.toByte()))
        service.control("next")
        assertTrue(requests.isEmpty())
        assertEquals("profile_unavailable", service.snapshot().getString("errorCode"))
    }
    @Test fun networkFailureRefreshesNativelyOnceAndExplicitRetryWorks() {
        load(); service.control("seek", 32.0); idle()
        shadowOf(player()).invokeErrorListener(MediaPlayer.MEDIA_ERROR_UNKNOWN, MediaPlayer.MEDIA_ERROR_IO)
        assertTrue(requests.last().second.getBoolean("refresh")); assertEquals(32.0, requests.last().second.getDouble("position"), 0.1)
        assertFalse(requests.last().second.optBoolean("compatibleAudio"))
        reply(requests.last()); shadowOf(player()).invokeErrorListener(MediaPlayer.MEDIA_ERROR_UNKNOWN, MediaPlayer.MEDIA_ERROR_IO)
        assertEquals(1, requests.size); assertEquals("error", service.snapshot().getString("status"))
        service.control("resume"); reply(requests.last())
        assertEquals("playing", service.snapshot().getString("status"))
        service.control("seek", 45.0); idle(); assertEquals(45.0, service.snapshot().getDouble("position"), 0.1)
    }
    @Test fun mediaServerDeathRecreatesThePlayerOnceAtTheCurrentPosition() {
        load()
        service.control("seek", 32.0)
        idle()
        val failed = player()
        shadowOf(failed).invokeErrorListener(MediaPlayer.MEDIA_ERROR_SERVER_DIED, 1)
        val recovery = requests.single()
        assertTrue(recovery.second.getBoolean("refresh"))
        assertEquals(32.0, recovery.second.getDouble("position"), 0.1)
        assertFalse(recovery.second.optBoolean("compatibleAudio"))
        reply(recovery)
        assertNotSame(failed, player())
        assertEquals("playing", service.snapshot().getString("status"))
        assertEquals(32.0, service.snapshot().getDouble("position"), 0.1)

        shadowOf(player()).invokeErrorListener(MediaPlayer.MEDIA_ERROR_SERVER_DIED, 1)
        assertEquals(1, requests.size)
        assertEquals("android_media:100:1", service.snapshot().getString("errorCode"))
    }
    @Test fun failedMediaServerRecoveryReportsBothErrors() {
        load()
        shadowOf(player()).invokeErrorListener(MediaPlayer.MEDIA_ERROR_SERVER_DIED, 1)
        val recovery = requests.single()
        service.resolved(recovery.first, JSONObject().put("error", "歌曲不存在").put("errorCode", "invalid_input"))
        val failed = service.snapshot()
        assertEquals("error", failed.getString("status"))
        assertEquals("invalid_input", failed.getString("errorCode"))
        assertEquals("android_media:100:1", failed.getString("initialErrorCode"))
    }
    @Test fun unrecognizedStreamRetriesWithCompatibleAudioWithoutLosingResumePosition() {
        val broken = "$url-broken"
        ShadowMediaPlayer.addMediaInfo(DataSource.toDataSource(broken), ShadowMediaPlayer.MediaInfo(120_000, 1000))
        service.onStartCommand(Intent(service, PlaybackService::class.java).setAction("load")
            .putExtra("id", "1").putExtra("title", "song 1").putExtra("url", broken).putExtra("position", 32.0), 0, 1)
        val sessionId = service.snapshot().getString("sessionId")
        // AOSP reports UNKNOWN / status_t::UNKNOWN_ERROR for an unrecognizable stream.
        shadowOf(player()).invokeErrorListener(MediaPlayer.MEDIA_ERROR_UNKNOWN, Int.MIN_VALUE)
        val recovery = requests.single()
        assertTrue(recovery.second.getBoolean("compatibleAudio"))
        assertTrue(recovery.second.getBoolean("refresh"))
        assertEquals(32.0, recovery.second.getDouble("position"), 0.1)
        reply(recovery)
        assertEquals("playing", service.snapshot().getString("status"))
        assertEquals(sessionId, service.snapshot().getString("sessionId"))
        assertEquals(32.0, service.snapshot().getDouble("position"), 0.1)
        shadowOf(player()).invokeErrorListener(MediaPlayer.MEDIA_ERROR_UNKNOWN, MediaPlayer.MEDIA_ERROR_UNSUPPORTED)
        assertEquals(1, requests.size)
        assertEquals("error", service.snapshot().getString("status"))
        assertEquals("当前音源无法解码，请尝试更换音质", service.snapshot().getString("error"))
        assertEquals("android_media:1:-1010", service.snapshot().getString("errorCode"))
    }
    @Test fun staleCompatibleAudioCannotReplaceANewerTrack() {
        load()
        shadowOf(player()).invokeErrorListener(MediaPlayer.MEDIA_ERROR_UNKNOWN, MediaPlayer.MEDIA_ERROR_MALFORMED)
        val recovery = requests.single()
        assertTrue(recovery.second.getBoolean("compatibleAudio"))
        service.control("next")
        reply(recovery)
        assertEquals("2", service.snapshot().getString("id"))
        assertTrue(service.snapshot().getBoolean("stopped"))
        reply(requests.last())
        assertEquals("playing", service.snapshot().getString("status"))
        assertEquals("2", service.snapshot().getString("id"))
    }
    @Test fun malformedOfflineAudioDoesNotRequestACompatibleNetworkSource() {
        service.updateQueue(JSONObject(PlaybackService.queueData!!).put("offlineOnly", true).toString())
        load()
        shadowOf(player()).invokeErrorListener(MediaPlayer.MEDIA_ERROR_UNKNOWN, MediaPlayer.MEDIA_ERROR_MALFORMED)
        assertTrue(requests.isEmpty())
        assertEquals("本地音频无法播放，请联网后重新下载", service.snapshot().getString("error"))
    }
    @Test fun aSlowQualitySeekRealignsBeforeSwitchingPlayers() {
        val alternate = "$url-slow-quality"
        ShadowMediaPlayer.addMediaInfo(DataSource.toDataSource(alternate), ShadowMediaPlayer.MediaInfo(120_000, 100))
        load()
        val original = player()
        shadowOf(original).setCurrentPosition(20_000)
        val replies = mutableListOf<String?>()
        service.switchSource(alternate, "1", reply = { replies.add(it) })
        val candidate = field("sourceCandidate") as MediaPlayer
        shadowOf(candidate).setSeekDelay(400)
        shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(100))
        assertSame(original, player())
        shadowOf(original).setCurrentPosition(23_000)
        shadowOf(candidate).setSeekDelay(0)
        shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(400))
        assertSame(candidate, player())
        assertEquals(listOf<String?>(null), replies)
        assertEquals(23.4, service.snapshot().getDouble("position"), 0.25)
    }
    @Test fun qualityChangePreservesPausedPositionAndPlaybackSession() {
        val alternate = "$url-quality"
        ShadowMediaPlayer.addMediaInfo(DataSource.toDataSource(alternate), ShadowMediaPlayer.MediaInfo(120_000, 0))
        load()
        service.control("seek", 27.0)
        idle()
        service.control("pause")
        val previous = service.snapshot()
        val original = player()
        val replies = mutableListOf<String?>()
        service.switchSource(alternate, "1", reply = { replies.add(it) })
        idle()
        val current = service.snapshot()
        assertEquals(listOf<String?>(null), replies)
        assertNotSame(original, player())
        assertEquals("paused", current.getString("status"))
        assertEquals(27.0, current.getDouble("position"), 0.1)
        assertEquals(previous.getString("sessionId"), current.getString("sessionId"))
        assertTrue(current.getLong("sourceRevision") > previous.getLong("sourceRevision"))
        service.control("resume")
        assertEquals("playing", service.snapshot().getString("status"))
    }
    @Test fun qualityFailureKeepsOriginalAudioAndDoesNotResolveTheQueue() {
        val alternate = "$url-unavailable"
        ShadowMediaPlayer.addMediaInfo(DataSource.toDataSource(alternate), ShadowMediaPlayer.MediaInfo(120_000, 1000))
        load()
        val original = player()
        val revision = service.snapshot().getLong("sourceRevision")
        val replies = mutableListOf<String?>()
        service.switchSource(alternate, "1", reply = { replies.add(it) })
        shadowOf(field("sourceCandidate") as MediaPlayer)
            .invokeErrorListener(MediaPlayer.MEDIA_ERROR_UNKNOWN, MediaPlayer.MEDIA_ERROR_IO)
        idle()
        assertEquals(listOf("新音源无法播放，已保留原音质"), replies)
        assertSame(original, player())
        assertEquals("playing", service.snapshot().getString("status"))
        assertEquals(revision, service.snapshot().getLong("sourceRevision"))
        assertTrue(requests.isEmpty())
    }
    @Test fun backgroundQueueKeepsOfflinePolicyAndAppliesResolvedResumePosition() {
        load()
        service.updateQueue(JSONObject().put("tracks", JSONArray(listOf(track("1"), track("2"))))
            .put("version", 1).put("owner", "test").put("repeatMode", "off").put("offlineOnly", true).toString())
        service.control("next")
        val request = requests.single()
        assertTrue(request.second.getBoolean("offlineOnly"))
        service.resolved(request.first, JSONObject().put("url", url).put("track", track("2")).put("position", 29.0))
        idle()
        assertEquals("2", service.snapshot().getString("id"))
        assertEquals("playing", service.snapshot().getString("status"))
        assertEquals(29.0, service.snapshot().getDouble("position"), 0.1)
    }
    @Test fun failureBeforePreparationStillAppliesTheAutomaticDurationThreshold() {
        ShadowMediaPlayer.addMediaInfo(DataSource.toDataSource(url), ShadowMediaPlayer.MediaInfo(120_000, 10_000))
        service.onStartCommand(Intent(service, PlaybackService::class.java).setAction("load").putExtra("id", "1")
            .putExtra("url", url).putExtra("position", 85.0).putExtra("automaticResume", true)
            .putExtra("resumeEnabled", true).putExtra("resumeThreshold", 600.0), 0, 1)
        assertEquals(0.0,service.snapshot().getDouble("position"),0.0)
        shadowOf(player()).invokeErrorListener(MediaPlayer.MEDIA_ERROR_UNKNOWN, MediaPlayer.MEDIA_ERROR_IO)
        assertEquals(85.0, requests.single().second.getDouble("position"), 0.0)
        ShadowMediaPlayer.addMediaInfo(DataSource.toDataSource(url), ShadowMediaPlayer.MediaInfo(120_000, 0))
        reply(requests.single())
        assertEquals("playing", service.snapshot().getString("status"))
        assertEquals(0.0, service.snapshot().getDouble("position"), 0.0)
    }
    @Test fun anotherPlayerTakingFocusDoesNotDestroyThePlayableTimeline() {
        load(); service.control("seek", 25.0); idle()
        val audio = shadowOf(service.getSystemService(AudioManager::class.java))
        val original = audio.lastAudioFocusRequest
        original.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS)
        assertEquals("paused", service.snapshot().getString("status"))
        original.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN)
        assertEquals("paused", service.snapshot().getString("status"))
        audio.setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
        service.control("resume")
        assertEquals("paused", service.snapshot().getString("status"))
        assertEquals("audio_focus_denied", service.snapshot().getString("errorCode"))
        assertEquals(25.0, service.snapshot().getDouble("position"), .1)
        audio.setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
        service.control("resume"); service.control("seek", 40.0); idle()
        assertEquals("playing", service.snapshot().getString("status")); assertEquals(40.0, service.snapshot().getDouble("position"), 0.1)
    }
    @Test fun transientFocusReturnsToTheSameTimelineUnlessTheUserPausesOrStops() {
        load(); service.control("seek", 25.0); idle()
        val audio = shadowOf(service.getSystemService(AudioManager::class.java))
        val focus = audio.lastAudioFocusRequest
        shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofSeconds(2))
        focus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        focus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        idle()
        val interruptedAt = player().currentPosition.toLong()
        assertTrue(interruptedAt > 25_000)
        assertEquals(interruptedAt, mediaSession().publishedPlaybackState!!.position)
        assertEquals("paused", service.snapshot().getString("status"))
        assertFalse(shadowOf(service).isForegroundStopped)
        audio.setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
        service.control("resume")
        assertEquals("paused", service.snapshot().getString("status"))
        assertEquals("audio_focus_denied", service.snapshot().getString("errorCode"))
        assertFalse(shadowOf(service).isForegroundStopped)
        focus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN); idle()
        audio.setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_GRANTED)
        assertEquals("playing", service.snapshot().getString("status"))
        assertEquals(interruptedAt / 1000.0, service.snapshot().getDouble("position"), .1)
        assertTrue(requests.isEmpty())
        focus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        service.control("pause")
        assertTrue(shadowOf(service).isForegroundStopped)
        focus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN); idle()
        assertEquals("paused", service.snapshot().getString("status"))
        service.control("resume")
        val currentFocus = shadowOf(service.getSystemService(AudioManager::class.java)).lastAudioFocusRequest
        currentFocus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        service.control("stop")
        currentFocus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN); idle()
        assertEquals("paused", service.snapshot().getString("status"))
        assertNull(field("player")); assertTrue(requests.isEmpty())
    }
    @Test fun manualResumeWaitsForDelayedFocusWithoutReplayingOrRequestingItAgainOnGain() {
        load()
        service.control("seek", 25.0); idle()
        val media = player()
        val audio = shadowOf(service.getSystemService(AudioManager::class.java))
        val oldFocus = audio.lastAudioFocusRequest
        oldFocus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS)
        audio.setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_DELAYED)
        service.control("resume")
        val delayed = audio.lastAudioFocusRequest
        assertEquals("paused", service.snapshot().getString("status"))
        assertFalse(media.isPlaying)
        assertFalse(shadowOf(service).isForegroundStopped)
        oldFocus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN)
        assertEquals("paused", service.snapshot().getString("status"))
        audio.setNextFocusRequestResponse(AudioManager.AUDIOFOCUS_REQUEST_FAILED)
        delayed.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN); idle()
        assertSame(media, player())
        assertTrue(media.isPlaying)
        assertEquals("playing", service.snapshot().getString("status"))
        assertEquals(25.0, service.snapshot().getDouble("position"), .1)
        assertTrue(requests.isEmpty())
    }
    @Test fun delayedLossFromTheInterruptedRequestCannotPauseAnExplicitResume() {
        load()
        service.control("seek", 25.0); idle()
        val media = player()
        val audio = shadowOf(service.getSystemService(AudioManager::class.java))
        val interrupted = audio.lastAudioFocusRequest
        interrupted.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        val handler = android.os.Handler(android.os.Looper.getMainLooper())
        handler.post { interrupted.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS) }

        service.control("resume")
        assertEquals("playing", service.snapshot().getString("status"))
        idle()

        assertEquals("playing", service.snapshot().getString("status"))
        assertSame(media, player())
        assertEquals(25.0, service.snapshot().getDouble("position"), .1)
        assertTrue(requests.isEmpty())

        audio.lastAudioFocusRequest.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS)
        assertEquals("paused", service.snapshot().getString("status"))
    }
    @Test fun interruptionDuringNativeQueueResolutionKeepsTheResolvedTrackAndPosition() {
        load()
        service.control("next")
        val request = requests.single()
        val focus = shadowOf(service.getSystemService(AudioManager::class.java)).lastAudioFocusRequest
        focus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        service.resolved(request.first, JSONObject().put("url", url).put("track", track("2")).put("position", 29.0))
        idle()
        assertEquals("2", service.snapshot().getString("id"))
        assertEquals("paused", service.snapshot().getString("status"))
        assertEquals(29.0, service.snapshot().getDouble("position"), .1)
        assertFalse(player().isPlaying)
        assertFalse(shadowOf(service).isForegroundStopped)
        focus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN); idle()
        assertEquals("playing", service.snapshot().getString("status"))
        assertEquals(29.0, service.snapshot().getDouble("position"), .1)
        assertEquals(1, requests.size)
    }
    @Test fun headsetReceiverTargetsThisServiceAndConsumesKeyUpOnce() {
        load()
        val receiver = MediaButtonReceiver()
        val keys = listOf(
            KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_NEXT),
            KeyEvent(0, 50, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_NEXT, 1),
            KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_MEDIA_NEXT),
        )
        for (key in keys) receiver.onReceive(service, mediaKeyIntent(key))
        assertEquals(1, requests.size); assertEquals("2", requests.single().second.getJSONObject("track").getString("id"))
    }
    private fun mediaKeyIntent(key: KeyEvent) = Intent(Intent.ACTION_MEDIA_BUTTON).putExtra(Intent.EXTRA_KEY_EVENT, key)
    private fun waitForHeadsetTap() = shadowOf(android.os.Looper.getMainLooper())
        .idleFor(java.time.Duration.ofMillis(android.view.ViewConfiguration.getDoubleTapTimeout().toLong() + 1))

    @Test fun headsetSingleTapTogglesAndDoubleTapSkipsAcrossDeliveryPaths() {
        load()
        val callback = mediaSession().transportCallback!!
        val receiver = MediaButtonReceiver()
        fun hook(at: Long) = mediaKeyIntent(KeyEvent(at, at, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_HEADSETHOOK, 0))
        assertTrue(callback.onMediaButtonEvent(hook(100)))
        assertEquals("playing", service.snapshot().getString("status"))
        assertTrue(callback.onMediaButtonEvent(mediaKeyIntent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_HEADSETHOOK))))
        receiver.onReceive(service, hook(100))
        assertTrue(requests.isEmpty())
        waitForHeadsetTap()
        assertEquals("paused", service.snapshot().getString("status"))

        callback.onPlay()
        assertTrue(callback.onMediaButtonEvent(hook(600)))
        receiver.onReceive(service, hook(700))
        assertTrue(callback.onMediaButtonEvent(hook(700)))
        receiver.onReceive(service, hook(600))
        assertEquals("buffering", service.snapshot().getString("status"))
        assertEquals("2", requests.single().second.getJSONObject("track").getString("id"))
        reply(requests.single())
        waitForHeadsetTap()
        assertEquals("playing", service.snapshot().getString("status"))
    }

    @Test fun explicitTransportCancelsPendingTapAndPlayDoesNotRestartResolution() {
        load()
        val callback = mediaSession().transportCallback!!
        callback.onMediaButtonEvent(mediaKeyIntent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE)))
        callback.onPause()
        waitForHeadsetTap()
        assertEquals("paused", service.snapshot().getString("status"))

        callback.onSkipToNext()
        callback.onPlay()
        callback.onPlay()
        assertEquals(1, requests.size)
        reply(requests.single())
        assertEquals("2", service.snapshot().getString("id"))
        assertEquals("playing", service.snapshot().getString("status"))
    }
    @Test fun mediaCardMovesOnlyTheLyricLineInBothTitleModes() {
        load("测试歌手")
        val session = mediaSession()
        val originalQueue = session.publishedQueue
        val notifications = service.getSystemService(NotificationManager::class.java)
        fun notification() = notifications.activeNotifications.single().notification
        fun assertCard(top: String, bottom: String) {
            idle()
            val metadata = session.publishedMetadata!!
            assertEquals(top, metadata.getString(MediaMetadata.METADATA_KEY_TITLE))
            assertEquals(top, metadata.getString(MediaMetadata.METADATA_KEY_DISPLAY_TITLE))
            assertEquals(top, metadata.description.title.toString())
            assertEquals(bottom, metadata.getString(MediaMetadata.METADATA_KEY_ARTIST))
            assertEquals(bottom, metadata.getString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE))
            assertEquals(bottom, metadata.description.subtitle.toString())
            val extras = notification().extras
            assertEquals(top, extras.getCharSequence(Notification.EXTRA_TITLE).toString())
            assertEquals(bottom, extras.getCharSequence(Notification.EXTRA_TEXT).toString())
            assertSame(originalQueue, session.publishedQueue)
        }

        val playback = service.snapshot()
        val lyricSession = playback.getString("engineInstanceId") + ":" + playback.getString("sessionId")
        assertCard("song 1", "测试歌手")
        try {
            FloatingLyricsOverlay.command(service, """{"action":"subtitle-preference","enabled":true}""")
            FloatingLyricsOverlay.command(service, """{"action":"update","id":"1","session":"$lyricSession","subtitles":true,"lines":[
                {"timeMs":0,"endTimeMs":2000,"text":"第一行歌词"},{"timeMs":2000,"endTimeMs":4000,"text":"第二行歌词"}]}""")
            assertCard("song 1", "第一行歌词")
            val before = notification()
            service.notifyLyricsChanged()
            assertCard("song 1", "第一行歌词")
            assertSame(before, notification())

            shadowOf(android.os.Looper.getMainLooper()).idleFor(java.time.Duration.ofMillis(2300))
            assertCard("song 1", "第二行歌词")
            FloatingLyricsOverlay.command(service, """{"action":"system-title","enabled":true}""")
            assertCard("第二行歌词", "测试歌手")
            service.control("pause")
            assertCard("第二行歌词", "测试歌手")
            service.control("seek", 1.0)
            assertCard("第一行歌词", "测试歌手")
            service.control("resume")
            assertCard("第一行歌词", "测试歌手")
            service.control("seek", 5.0)
            assertCard("song 1", "测试歌手")
            service.control("seek", 1.0)
            FloatingLyricsOverlay.command(service, """{"action":"system-title","enabled":false}""")
            assertCard("song 1", "第一行歌词")
            assertEquals("song 1", session.publishedQueue!!.first().description.title)
            assertEquals("song 1", service.snapshot().getJSONObject("track").getString("title"))
        } finally {
            FloatingLyricsOverlay.command(service, """{"action":"system-title","enabled":false}""")
            FloatingLyricsOverlay.command(service, """{"action":"subtitle-preference","enabled":false}""")
        }
    }

    @Test fun nativeQueueRefreshesMatchedLyricsAndSubtitlesWithTheWebViewSuspended() {
        fun displayed(field: String = MediaMetadata.METADATA_KEY_TITLE): String {
            idle()
            return mediaSession().publishedMetadata!!.getString(field)
        }
        fun overlayLine(): String {
            val manager = service.getSystemService(Context.WINDOW_SERVICE)
            val row = Shadow.extract<ShadowWindowManagerImpl>(manager).views.filterIsInstance<LinearLayout>().single()
            return row.getChildAt(0).contentDescription.toString()
        }
        fun lyricsReply(request: Pair<Long, JSONObject>, text: String, subtitles: Boolean = false) {
            val line = JSONObject().put("timeMs", 0).put("endTimeMs", 2_000).put("text", text)
            service.resolved(request.first, JSONObject().put("kind", "lyrics")
                .put("timeline", JSONObject().put("lines", JSONArray(listOf(line))).put("subtitles", subtitles)))
        }
        ShadowSettings.setCanDrawOverlays(true)
        FloatingLyricsOverlay.command(service, """{"action":"subtitle-preference","enabled":true,"language":"ai-en"}""")
        try {
            load()
            val old = lyricRequests.single()
            assertEquals("lyrics", old.second.getString("kind"))
            assertEquals("1", old.second.getString("id"))

            mediaSession().transportCallback!!.onSkipToNext()
            reply(requests[0])
            val matched = lyricRequests[1]
            assertEquals("2", matched.second.getString("id"))
            assertEquals("playing", service.snapshot().getString("status"))
            lyricsReply(old, "上一首迟到的歌词")
            assertEquals("song 2", displayed())
            lyricsReply(matched, "已匹配歌词")
            assertEquals("song 2", displayed())
            assertEquals("已匹配歌词", displayed(MediaMetadata.METADATA_KEY_ARTIST))
            FloatingLyricsOverlay.command(service, """{"action":"system-title","enabled":true}""")
            FloatingLyricsOverlay.command(service, """{"action":"enable","enabled":true}""")
            assertEquals(2, lyricRequests.size)
            assertEquals("已匹配歌词", displayed())
            assertEquals("已匹配歌词", overlayLine())
            val playback = service.snapshot()
            val scope = playback.getString("engineInstanceId") + ":" + playback.getString("sessionId")
            FloatingLyricsOverlay.command(service, """{"action":"update","id":"2","session":"$scope","lines":[]}""")
            assertEquals("已匹配歌词", displayed())

            mediaSession().transportCallback!!.onSkipToNext()
            reply(requests[1])
            val captions = lyricRequests[2]
            assertTrue(captions.second.getBoolean("subtitles"))
            assertEquals("ai-en", captions.second.getString("subtitleLanguage"))
            assertEquals("3", captions.second.getString("id"))
            FloatingLyricsOverlay.command(service, """{"action":"subtitle-preference","enabled":true,"language":"ai-ja"}""")
            val changed = lyricRequests.last()
            assertEquals("ai-ja", changed.second.getString("subtitleLanguage"))
            lyricsReply(captions, "Previous preference", subtitles = true)
            assertEquals("song 3", displayed())
            lyricsReply(changed, "日本語の字幕", subtitles = true)
            assertEquals("日本語の字幕", displayed())
            assertEquals("日本語の字幕", overlayLine())
            FloatingLyricsOverlay.command(service, """{"action":"subtitle-preference","enabled":false,"language":""}""")
            assertEquals("song 3", displayed())
            assertFalse(lyricRequests.last().second.getBoolean("subtitles"))
        } finally {
            FloatingLyricsOverlay.command(service, """{"action":"subtitle-preference","enabled":false}""")
            FloatingLyricsOverlay.command(service, """{"action":"system-title","enabled":false}""")
            FloatingLyricsOverlay.command(service, """{"action":"enable","enabled":false}""")
        }
    }
    @Test fun freshGuestPlaybackUsesTheNativeTimelineBeforeTheAccountMarkerExists() {
        assertTrue(profile.delete())
        load()
        val request = lyricRequests.single().second
        assertEquals("lyrics", request.getString("kind"))
        assertEquals("", request.getString("profile"))
    }
    @Test fun sessionPublishesMetadataAndControllerWithoutOpeningAnActivity() {
        var controller: android.media.session.MediaController? = null
        PlaybackService.controllerListener = { controller = it }; service.attachController(); load()
        assertNotNull(controller)
        assertSame(field("controller"), controller)
        // Robolectric's controller shadow does not receive Binder metadata updates.
        val metadata = mediaSession().publishedMetadata!!
        assertEquals("1", metadata.getString(android.media.MediaMetadata.METADATA_KEY_MEDIA_ID))
        assertEquals(listOf(session()), service.sessions)
    }
    @Test fun systemCoverIsPublishedWithItsTrackAndClearedOnTheNextTrack() {
        load()
        val field = PlaybackService::class.java.getDeclaredField("artwork").apply { isAccessible = true }
        val cover = field.type.getDeclaredConstructor(Bitmap::class.java, ByteArray::class.java).apply { isAccessible = true }
        field.set(service, cover.newInstance(Bitmap.createBitmap(16, 16, Bitmap.Config.ARGB_8888), byteArrayOf(1, 2, 3)))
        service.notifyLyricsChanged()
        idle()
        assertEquals(16, mediaSession().publishedMetadata!!.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART).width)
        mediaSession().transportCallback!!.onSkipToNext()
        reply(requests.single())
        val metadata = mediaSession().publishedMetadata!!
        assertEquals("2", metadata.getString(MediaMetadata.METADATA_KEY_MEDIA_ID))
        assertNull(metadata.getBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART))
    }
    @Test fun removingActivityTaskWhileResolvingKeepsTheNativeSessionAvailable() {
        load()
        val token = session().platformToken
        mediaSession().transportCallback!!.onSkipToNext()
        assertEquals("buffering", service.snapshot().getString("status"))
        service.onTaskRemoved(null)
        assertFalse(shadowOf(service).isStoppedBySelf)
        reply(requests.single())
        assertEquals("2", service.snapshot().getString("id"))
        assertSame(token, session().platformToken)
        assertFalse(session().player.isCommandAvailable(Player.COMMAND_SET_MEDIA_ITEM))
        assertFalse(session().player.isCommandAvailable(Player.COMMAND_CHANGE_MEDIA_ITEMS))
    }
    @Test fun bluetoothSeesCommandsAndMetadataAtTheFirstActivation() {
        assertNull(RecordingMediaSessionShadow.active)
        assertTrue(service.sessions.isEmpty())
        load()
        val recording = mediaSession()
        assertTrue(recording.readyAtActivation)
        val initial = recording.stateAtActivation!!
        assertEquals(PlaybackState.STATE_BUFFERING, initial.state)
        for (action in listOf(PlaybackState.ACTION_PLAY_PAUSE, PlaybackState.ACTION_PAUSE,
            PlaybackState.ACTION_SKIP_TO_NEXT, PlaybackState.ACTION_SKIP_TO_PREVIOUS)) {
            assertEquals(action, initial.actions and action)
        }
        assertEquals("song 1", recording.publishedMetadata!!.getString(MediaMetadata.METADATA_KEY_TITLE))
        assertEquals("album 1", recording.publishedMetadata!!.getString(MediaMetadata.METADATA_KEY_ALBUM))
        assertEquals(120_000L, recording.publishedMetadata!!.getLong(MediaMetadata.METADATA_KEY_DURATION))
        assertEquals(PlaybackState.STATE_PLAYING, recording.publishedPlaybackState!!.state)
        recording.transportCallback!!.onPause()
        idle()
        assertEquals(PlaybackState.ACTION_PLAY, recording.publishedPlaybackState!!.actions and PlaybackState.ACTION_PLAY)
    }
    @Test fun remoteTransportCallbacksWorkWithoutAWebView() {
        load()
        val callback = mediaSession().transportCallback!!
        callback.onPause(); idle(); assertEquals("paused",service.snapshot().getString("status"))
        callback.onPlay(); idle(); assertEquals("playing",service.snapshot().getString("status"))
        callback.onSkipToNext(); reply(requests.last()); assertEquals("2",service.snapshot().getString("id"))
        service.control("seek", 20.0); idle()
        service.control("previous"); idle()
        assertEquals(0.0, service.snapshot().getDouble("position"), .1)
        assertEquals(1, requests.size)
        service.control("seek", 20.0); idle()
        callback.onSkipToPrevious(); reply(requests.last()); assertEquals("1",service.snapshot().getString("id"))
        service.control("seek", 20.0); idle()
        val previous = Intent(Intent.ACTION_MEDIA_BUTTON).putExtra(Intent.EXTRA_KEY_EVENT, KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_MEDIA_PREVIOUS))
        assertTrue(callback.onMediaButtonEvent(previous))
        reply(requests.last()); assertEquals("3", service.snapshot().getString("id"))
    }
    @Test fun nowPlayingKeepsTimelineIdentityAndRejectsAmbiguousLegacyQueueJumps() {
        load()
        val session = mediaSession()
        val player = session().player
        val uid = androidx.media3.common.Timeline.Window()
        val third = player.currentTimeline.getWindow(2, uid).uid
        val staleLegacyId = session.publishedQueue!!.first { it.description.mediaId == "1" }.queueId
        service.updateQueue(JSONObject().put("tracks", JSONArray(listOf(track("3"), track("1")))).put("repeatMode", "off").toString())
        idle()
        assertEquals(listOf("3", "1"), session.publishedQueue!!.map { it.description.mediaId })
        assertEquals(session.publishedQueue!!.last().queueId, session.publishedPlaybackState!!.activeQueueItemId)
        assertEquals(third, player.currentTimeline.getWindow(0, uid).uid)
        session.transportCallback!!.onSkipToQueueItem(staleLegacyId)
        idle()
        assertTrue(requests.isEmpty())
        player.seekToDefaultPosition(0)
        reply(requests.single())
        assertEquals("3", service.snapshot().getString("id"))
        assertEquals(session.publishedQueue!!.first().queueId, session.publishedPlaybackState!!.activeQueueItemId)
    }
    @Test fun singleTrackKeepsPlayingWithoutAdvertisingUnavailableSkips() {
        load()
        val manager = service.getSystemService(NotificationManager::class.java)
        fun actions() = manager.activeNotifications.single().notification.actions.map { it.title.toString() }
        assertEquals(listOf("上一首", "暂停", "下一首"), actions())
        service.updateQueue(JSONObject().put("tracks", JSONArray(listOf(track("1")))).put("repeatMode", "off").toString())
        val session = mediaSession()
        assertEquals(0L, session.publishedPlaybackState!!.actions and
            (PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_SKIP_TO_NEXT))
        assertEquals(listOf("暂停"), actions())
        session.transportCallback!!.onSkipToNext()
        session.transportCallback!!.onSkipToPrevious()
        assertEquals("playing", service.snapshot().getString("status"))
        assertTrue(requests.isEmpty())
    }
}

@Implements(MediaSession::class)
class RecordingMediaSessionShadow : ShadowMediaSession() {
    companion object {
        var active: RecordingMediaSessionShadow? = null
    }
    @RealObject private lateinit var realSession: MediaSession
    var publishedMetadata: android.media.MediaMetadata? = null
        private set
    var publishedPlaybackState: android.media.session.PlaybackState? = null
        private set
    var publishedQueue: List<MediaSession.QueueItem>? = null
        private set
    var stateAtActivation: PlaybackState? = null
        private set
    var readyAtActivation = false
        private set
    var transportCallback: MediaSession.Callback? = null
        private set
    @Implementation protected fun setMetadata(value: android.media.MediaMetadata?) { publishedMetadata = value }
    @Implementation protected fun setPlaybackState(value: android.media.session.PlaybackState?) { publishedPlaybackState = value }
    @Implementation protected fun setQueue(value: List<MediaSession.QueueItem>?) { publishedQueue = value }
    @Implementation protected fun getCurrentControllerInfo() =
        MediaSessionManager.RemoteUserInfo("android", 1, android.os.Process.SYSTEM_UID)
    @Implementation protected fun setActive(value: Boolean) {
        if (value) {
            active = this
            stateAtActivation = publishedPlaybackState
            val active = publishedQueue?.firstOrNull { it.queueId == stateAtActivation?.activeQueueItemId }
            readyAtActivation = transportCallback != null && active?.description?.mediaId != null &&
                active.description.mediaId == publishedMetadata?.getString(MediaMetadata.METADATA_KEY_MEDIA_ID)
        }
        Shadow.directlyOn<Any?,MediaSession>(realSession, MediaSession::class.java, "setActive", ClassParameter.from(java.lang.Boolean.TYPE,value))
    }
    @Implementation protected fun setCallback(value: MediaSession.Callback?, handler: android.os.Handler?) {
        transportCallback = value
        Shadow.directlyOn<Any?,MediaSession>(realSession, MediaSession::class.java, "setCallback",
            ClassParameter.from(MediaSession.Callback::class.java,value), ClassParameter.from(android.os.Handler::class.java,handler))
    }
}
