package app.bilimusic.player

import android.content.Intent
import android.media.AudioManager
import android.media.MediaMetadata
import android.media.MediaPlayer
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.view.KeyEvent
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
import org.robolectric.shadows.util.DataSource
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28, 35], manifest = Config.NONE, shadows = [RecordingMediaSessionShadow::class])
class BackgroundPlaybackTest {
    private lateinit var service: PlaybackService
    private lateinit var profile: File
    private val requests = mutableListOf<Pair<Long, JSONObject>>()
    private val url = "http://127.0.0.1:1234/token/test"
    private fun track(id: String) = JSONObject().put("id", id).put("title", "song $id").put("album", "album $id").put("durationSeconds", 120)
        .put("source", JSONObject().put("provider", "bilibili").put("bvid", "BV123").put("cid", id.toInt()).put("page", id.toInt()))
    private fun field(name: String): Any? = PlaybackService::class.java.getDeclaredField(name).apply { isAccessible = true }.get(service)
    private fun player() = field("player") as MediaPlayer
    private fun mediaSession() = Shadow.extract<RecordingMediaSessionShadow>(field("session") as MediaSession)
    private fun idle() { shadowOf(android.os.Looper.getMainLooper()).idle() }
    private fun load() {
        service.onStartCommand(Intent(service, PlaybackService::class.java).setAction("load").putExtra("id", "1")
            .putExtra("url", url).putExtra("title", "song 1"), 0, 1)
        idle()
        assertEquals("playing", service.snapshot().getString("status"))
    }
    private fun reply(request: Pair<Long, JSONObject>) {
        service.resolved(request.first, JSONObject().put("url", url).put("track", request.second.getJSONObject("track")).put("position", request.second.optDouble("position", 0.0)))
        idle()
    }
    @Before fun setup() {
        profile = File.createTempFile("bilimusic-native-profile", ".txt").apply { writeText("account") }
        PlaybackService.profilePath = profile.path; PlaybackService.listener = null
        PlaybackService.queueData = JSONObject().put("tracks", JSONArray(listOf(track("1"), track("2"), track("3"))))
            .put("repeatMode", "off").toString()
        PlaybackService.resolveListener = { request, payload -> requests.add(request to payload) }
        ShadowMediaPlayer.addMediaInfo(DataSource.toDataSource(url), ShadowMediaPlayer.MediaInfo(120_000, 0))
        service = Robolectric.buildService(PlaybackService::class.java).create().get()
    }
    @After fun cleanup() {
        service.onDestroy(); profile.delete()
        PlaybackService.listener = null; PlaybackService.resolveListener = null; PlaybackService.listeningListener = null
        PlaybackService.controllerListener = null; PlaybackService.queueData = null; PlaybackService.profilePath = null
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
    }
    @Test fun networkFailureRefreshesNativelyOnceAndExplicitRetryWorks() {
        load(); service.control("seek", 32.0); idle()
        shadowOf(player()).invokeErrorListener(MediaPlayer.MEDIA_ERROR_UNKNOWN, MediaPlayer.MEDIA_ERROR_IO)
        assertTrue(requests.last().second.getBoolean("refresh")); assertEquals(32.0, requests.last().second.getDouble("position"), 0.1)
        reply(requests.last()); shadowOf(player()).invokeErrorListener(MediaPlayer.MEDIA_ERROR_UNKNOWN, MediaPlayer.MEDIA_ERROR_IO)
        assertEquals(1, requests.size); assertEquals("error", service.snapshot().getString("status"))
        service.control("resume"); reply(requests.last())
        assertEquals("playing", service.snapshot().getString("status"))
        service.control("seek", 45.0); idle(); assertEquals(45.0, service.snapshot().getDouble("position"), 0.1)
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
        val focus = shadowOf(service.getSystemService(AudioManager::class.java)).lastAudioFocusRequest
        focus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS)
        assertEquals("paused", service.snapshot().getString("status"))
        service.control("resume"); service.control("seek", 40.0); idle()
        assertEquals("playing", service.snapshot().getString("status")); assertEquals(40.0, service.snapshot().getDouble("position"), 0.1)
    }
    @Test fun transientFocusReturnsToTheSameTimelineUnlessTheUserPausesOrStops() {
        load(); service.control("seek", 25.0); idle()
        val focus = shadowOf(service.getSystemService(AudioManager::class.java)).lastAudioFocusRequest
        focus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        focus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        assertEquals("paused", service.snapshot().getString("status"))
        focus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN); idle()
        assertEquals("playing", service.snapshot().getString("status"))
        assertEquals(25.0, service.snapshot().getDouble("position"), .1)
        assertTrue(requests.isEmpty())
        focus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        service.control("pause")
        focus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN); idle()
        assertEquals("paused", service.snapshot().getString("status"))
        service.control("resume")
        focus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_LOSS_TRANSIENT)
        service.control("stop")
        focus.listener.onAudioFocusChange(AudioManager.AUDIOFOCUS_GAIN); idle()
        assertEquals("paused", service.snapshot().getString("status"))
        assertNull(field("player")); assertTrue(requests.isEmpty())
    }
    @Test fun headsetReceiverTargetsThisServiceAndConsumesKeyUpOnce() {
        load()
        val receiver = MediaButtonReceiver()
        for (action in listOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) receiver.onReceive(service,
            Intent(Intent.ACTION_MEDIA_BUTTON).putExtra(Intent.EXTRA_KEY_EVENT, KeyEvent(action, KeyEvent.KEYCODE_MEDIA_NEXT)))
        assertEquals(1, requests.size); assertEquals("2", requests.single().second.getJSONObject("track").getString("id"))
    }
    @Test fun systemTitleLyricsUpdateDisplayWithoutReplacingBluetoothTrackTitle() {
        load()
        val session = mediaSession()
        fun metadata(key: String) = session.publishedMetadata!!.getString(key)
        FloatingLyricsOverlay.command(service,"""{"action":"update","id":"1","lines":[{"timeMs":0,"text":"正在唱的歌词"}]}""")
        try {
            FloatingLyricsOverlay.command(service,"""{"action":"system-title","enabled":true}""")
            assertEquals("正在唱的歌词",metadata(MediaMetadata.METADATA_KEY_DISPLAY_TITLE))
            assertEquals("song 1",metadata(MediaMetadata.METADATA_KEY_TITLE))
            assertEquals("song 1",session.publishedQueue!!.first().description.title)
            assertEquals("song 1",service.snapshot().getJSONObject("track").getString("title"))
        } finally { FloatingLyricsOverlay.command(service,"""{"action":"system-title","enabled":false}""") }
        assertEquals("song 1",metadata(MediaMetadata.METADATA_KEY_DISPLAY_TITLE))
    }
    @Test fun sessionPublishesMetadataAndControllerWithoutOpeningAnActivity() {
        var controller: android.media.session.MediaController? = null
        PlaybackService.controllerListener = { controller = it }; service.attachController(); load()
        val session = field("session") as MediaSession
        assertNotNull(controller); assertSame(session.controller, controller)
        // Robolectric's controller shadow does not receive Binder metadata updates.
        val metadata = Shadow.extract<RecordingMediaSessionShadow>(session).publishedMetadata!!
        assertEquals("1", metadata.getString(android.media.MediaMetadata.METADATA_KEY_MEDIA_ID))
        assertTrue(session.isActive)
    }
    @Test fun bluetoothSeesCommandsAndMetadataAtTheFirstActivation() {
        val session = field("session") as MediaSession
        val recording = mediaSession()
        assertFalse(session.isActive)
        assertEquals(PlaybackState.STATE_NONE, recording.publishedPlaybackState!!.state)
        load()
        assertTrue(recording.readyAtActivation)
        val initial = recording.stateAtActivation!!
        assertEquals(PlaybackState.STATE_BUFFERING, initial.state)
        for (action in listOf(PlaybackState.ACTION_PLAY, PlaybackState.ACTION_PAUSE,
            PlaybackState.ACTION_SKIP_TO_NEXT, PlaybackState.ACTION_SKIP_TO_PREVIOUS, PlaybackState.ACTION_SKIP_TO_QUEUE_ITEM)) {
            assertEquals(action, initial.actions and action)
        }
        assertEquals("song 1", recording.publishedMetadata!!.getString(MediaMetadata.METADATA_KEY_TITLE))
        assertEquals("album 1", recording.publishedMetadata!!.getString(MediaMetadata.METADATA_KEY_ALBUM))
        assertEquals(120_000L, recording.publishedMetadata!!.getLong(MediaMetadata.METADATA_KEY_DURATION))
        assertEquals(PlaybackState.STATE_PLAYING, recording.publishedPlaybackState!!.state)
    }
    @Test fun remoteTransportCallbacksWorkWithoutAWebView() {
        load()
        val callback = Shadow.extract<RecordingMediaSessionShadow>(field("session") as MediaSession).transportCallback!!
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
    @Test fun nowPlayingExposesActiveIdAndRejectsRemovedQueueItems() {
        load()
        val session = mediaSession()
        val original = session.publishedQueue!!.associate { it.description.mediaId to it.queueId }
        service.updateQueue(JSONObject().put("tracks", JSONArray(listOf(track("3"), track("1")))).put("repeatMode", "off").toString())
        assertEquals(listOf("3", "1"), session.publishedQueue!!.map { it.description.mediaId })
        assertEquals(original["1"], session.publishedPlaybackState!!.activeQueueItemId)
        assertEquals(original["3"], session.publishedQueue!!.first().queueId)
        session.transportCallback!!.onSkipToQueueItem(original["2"]!!)
        assertTrue(requests.isEmpty())
        session.transportCallback!!.onSkipToQueueItem(original["3"]!!)
        reply(requests.single())
        assertEquals("3", service.snapshot().getString("id"))
        assertEquals(original["3"], session.publishedPlaybackState!!.activeQueueItemId)
    }
    @Test fun singleTrackKeepsPlayingWithoutAdvertisingUnavailableSkips() {
        load()
        service.updateQueue(JSONObject().put("tracks", JSONArray(listOf(track("1")))).put("repeatMode", "off").toString())
        val session = mediaSession()
        assertEquals(0L, session.publishedPlaybackState!!.actions and
            (PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_SKIP_TO_NEXT))
        session.transportCallback!!.onSkipToNext()
        session.transportCallback!!.onSkipToPrevious()
        assertEquals("playing", service.snapshot().getString("status"))
        assertTrue(requests.isEmpty())
    }
}

@Implements(MediaSession::class)
class RecordingMediaSessionShadow : ShadowMediaSession() {
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
    @Implementation protected fun setActive(value: Boolean) {
        if (value) {
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
