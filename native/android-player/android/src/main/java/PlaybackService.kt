package app.bilimusic.player

import android.app.*
import android.content.*
import android.graphics.Color
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.*
import android.media.session.MediaController
import android.net.Uri
import android.os.*
import android.view.KeyEvent
import androidx.annotation.OptIn
import androidx.media3.common.Player
import androidx.media3.common.util.BitmapLoader
import androidx.media3.common.util.UnstableApi
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import app.tauri.plugin.JSObject
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.file.Files
import java.nio.file.NoSuchFileException
import java.nio.file.Paths
import java.util.concurrent.atomic.AtomicLong

/** Audio lives outside the WebView so backgrounding and screen lock do not stop it. */
@OptIn(UnstableApi::class)
class PlaybackService : MediaSessionService() {
    companion object {
        var instance: PlaybackService? = null
        var listener: ((JSObject) -> Unit)? = null
        @Volatile var listeningListener: ((JSObject) -> Unit)? = null
        @Volatile var profilePath: String? = null
        @Volatile var resolveListener: ((Long, JSONObject) -> Unit)? = null
        var controllerListener: ((MediaController) -> Unit)? = null
        var queueData: String? = null
        private val resolutionRequests = AtomicLong()
        private var pausedPlayback: PausedPlayback? = null
        private const val MEDIA_BUTTON_RESUME = "app.bilimusic.player.RESUME_FROM_MEDIA_BUTTON"
        private const val CHANNEL = "bilimusic-playback"
        private const val NOTIFICATION = 1001

        internal fun restartPausedFromMediaButton(context: Context) {
            if (pausedPlayback == null || resolveListener == null) return
            try {
                context.startForegroundService(Intent(context, PlaybackService::class.java).setAction(MEDIA_BUTTON_RESUME))
            } catch (error: IllegalStateException) {
                android.util.Log.w("BiliMusicPlayback", "Android declined media button service start", error)
            }
        }
    }
    private data class PausedPlayback(
        val profile: String,
        val queue: NativeQueue,
        val track: JSONObject,
        val position: Double,
        val rate: Float,
        val volume: Float,
        val gain: OutputGain,
    )
    private var player: MediaPlayer? = null
    private var sourceCandidate: MediaPlayer? = null
    private var sourceReply: ((String?) -> Unit)? = null
    private var sourceTimeout: Runnable? = null
    private var sourceReadinessCheck: Runnable? = null
    private var pendingUpgradeUrl: String? = null
    private var upgradeAfterPosition = 0.0
    private var session: MediaSession? = null
    private var controller: MediaController? = null
    private val sessionPlayer = SystemSessionPlayer({ action ->
        val activeSession = session
        val controller = activeSession?.controllerForCurrentRequest
        val notification = controller != null &&
            (controller.packageName == "com.android.systemui" || activeSession.isMediaNotificationController(controller))
        controlFromMediaSession(action, notification)
    }, { control("seek", it / 1000.0) }) { id ->
        if (!expireSleepIfNeeded()) queue.find(id)?.let {
            mediaButtons.cancel()
            resolveTrack(it)
        }
    }
    private lateinit var audioManager: AudioManager
    private var focus: AudioFocusRequest? = null
    private var hasAudioFocus = false
    private val playbackAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build()
    private val handler = Handler(Looper.getMainLooper())
    private val mediaButtons = MediaButtons(handler, ::hasOtherTracks) { controlFromMediaSession(it) }
    private var sleepEndsAt = 0L
    private var sleepDeadline = 0L
    private var sleepDuration = 0.0
    private var sleepExpired = false
    private val sleepWork = Runnable { expireSleepIfNeeded() }
    private var id = ""
    private var title = "BiliMusic"
    private var artist = ""
    private var album = ""
    private var metadataDuration = 0.0
    private var status = "paused"
    private var error: String? = null
    private var errorCode: String? = null
    private var initialErrorCode: String? = null
    private var diagnosticId = java.util.UUID.randomUUID().toString()
    private var diagnosticStarted = SystemClock.elapsedRealtime()
    private var diagnosticAccount: String? = null
    private var diagnosticPlaying = false

    private fun diagnostic(step: String, outcome: String, code: String? = null) {
        val profile = listeningProfile ?: return
        val session = diagnosticAccount ?: return
        val track = id.split(':', limit = 3)
        if (track.size != 3 || track[0] != "bilibili") return
        val event = JSONObject().put("operation", diagnosticId).put("area", "playback")
            .put("step", step).put("outcome", outcome).put("engine", "android-media-player")
            .put("elapsedMs", SystemClock.elapsedRealtime() - diagnosticStarted)
            .put("bvid", track[1]).put("cid", track[2].toLongOrNull())
            .put("code", code).put("initialCode", initialErrorCode)
        runCatching {
            resolveListener?.invoke(0, JSONObject().put("kind", "diagnostic")
                .put("profile", profile).put("accountSession", session).put("event", event))
        }
    }
    private val focusResume = FocusResume()
    private var prepared = false
    private var seeking = false
    private var listeningProfile: String? = null
    private var listeningAccount: String? = null
    private var listeningPosition: Double? = null
    private var listeningAt = 0L
    private var listeningSession = java.util.UUID.randomUUID().toString()
    private var listeningSeconds = 0.0
    private var collectionRef: String? = null
    private var positionSavedAt = 0L
    private var didFinishTrack = false
    private var queue = NativeQueue()
    private val systemQueue = SystemPlaybackQueue()
    private var nativeTrack: JSONObject? = null
    private var nativeRequest = 0L
    private val lyricRequests = PlaybackLyricRequests()
    private var playbackLyricsAccount = ""
    private var resolvingNative = false
    private var recoveryAttempted = false
    private var cacheFallbackAttempted = false
    private var cachedAudio = false
    private var resolveProfile: String? = null
    private var resolveAccount: String? = null
    private var transitionWakeLock: PowerManager.WakeLock? = null
    private var requestedStartPosition = 0.0
    private var initialResumePolicy: AutomaticResumePolicy? = null
    private var resumeDuringResolution: AutomaticResumePolicy? = null

    fun attachController() { controller?.let { controllerListener?.invoke(it) } }
    fun updateQueue(data: String) {
        val owner = queue.owner; val account = queue.accountSession; val version = queue.version
        val couldSkip = hasOtherTracks()
        queue.update(JSONObject(data))
        if (owner == queue.owner && version == queue.version) return
        if (resolvingNative && (owner != queue.owner || account != queue.accountSession || queue.find(id) == null)) control("pause")
        if (account != queue.accountSession) {
            if (account.isNotEmpty() && focusResume.pending) control("pause")
            mediaButtons.cancel()
            systemQueue.resetAccount()
            if (account.isEmpty()) {
                playbackLyricsAccount = queue.accountSession
                refreshPlaybackLyrics()
            }
            else {
                lyricRequests.supersede()
                FloatingLyricsOverlay.setTimeline(JSONObject())
            }
        }
        queue.find(id)?.let { nativeTrack = it }
        if (id.isNotEmpty()) {
            updateMetadata()
            if (couldSkip != hasOtherTracks()) updateSystemPlayback() else updateSessionPlaybackState()
        }
    }
    private fun currentProfile(): String? {
        val path = profilePath ?: return null
        return try {
            val bytes = Files.readAllBytes(Paths.get(path))
            Charsets.UTF_8.newDecoder().decode(ByteBuffer.wrap(bytes)).toString()
        } catch (_: NoSuchFileException) {
            // A fresh install uses the guest database before its account marker exists.
            ""
        } catch (_: java.io.IOException) {
            null
        }
    }
    private fun lyricSession() = "$engineInstanceId:$listeningSession"
    internal fun refreshPlaybackLyrics() {
        lyricRequests.supersede()
        if (id.isEmpty() || player == null || playbackLyricsAccount != queue.accountSession ||
            FloatingLyricsOverlay.hasTimeline(id, lyricSession())) return
        val profile = currentProfile() ?: return
        if (profile != listeningProfile) return
        val resolve = resolveListener ?: return
        val request = lyricRequests.start(lyricSession(), profile, queue.accountSession)
        runCatching {
            resolve(request, JSONObject().put("kind", "lyrics").put("id", id).put("profile", profile)
                .put("accountSession", queue.accountSession.takeIf { it.isNotEmpty() })
                .put("offlineOnly", queue.offlineOnly)
                .put("subtitles", FloatingLyricsOverlay.wantsSubtitles(this))
                .put("subtitleLanguage", FloatingLyricsOverlay.subtitleLanguage(this)))
        }
    }
    internal fun acceptForegroundLyrics(frame: JSONObject) {
        val profile = currentProfile() ?: return
        if (frame.optString("id") != id || frame.optString("session") != lyricSession() ||
            profile != listeningProfile || playbackLyricsAccount != queue.accountSession ||
            (frame.optJSONArray("lines")?.length() ?: 0) == 0 && !frame.optBoolean("cleared") ||
            frame.optBoolean("subtitles") && !FloatingLyricsOverlay.wantsSubtitles(this)) return
        lyricRequests.supersede()
        FloatingLyricsOverlay.setTimeline(frame)
        notifyLyricsChanged()
    }
    private fun cancelResolution() {
        nativeRequest = resolutionRequests.incrementAndGet(); resolvingNative = false
        transitionWakeLock?.let { if (it.isHeld) it.release() }; transitionWakeLock = null
    }
    private fun advance(direction: Int, ended: Boolean = false, restartCurrent: Boolean = true) {
        if (expireSleepIfNeeded()) return
        if (direction < 0 && restartCurrent && lastPosition > 4) { control("seek", 0.0); return }
        val target = queue.target(id, direction, ended)
        if (target == null) { control("pause"); return }
        resolveTrack(target, restart = queue.restart(ended))
    }
    private fun hasOtherTracks() = id.isNotEmpty() && queue.tracks.any { it.optString("id") != id }

    internal fun handleMediaButton(key: KeyEvent): Boolean {
        val handled = mediaButtons.handle(key)
        if (handled && key.action == KeyEvent.ACTION_DOWN && key.repeatCount == 0) {
            android.util.Log.i("BiliMusicPlayback", "media key=${key.keyCode}")
        }
        return handled
    }

    private fun controlFromMediaSession(action: String, notification: Boolean = false) {
        if (action == "next" || action == "previous" || action == "resume" || action == "pause") {
            val code = if (notification && (action == "resume" || action == "pause")) "notification_$action" else action
            diagnostic("media-key", "started", code)
        }
        mediaButtons.cancel()
        when (action) {
            "previous" -> if (hasOtherTracks()) advance(-1, restartCurrent = false)
            "next" -> if (hasOtherTracks()) advance(1)
            "resume" -> if (status != "playing" && status != "buffering") control("resume")
            else -> control(action)
        }
    }
    private fun resolveTrack(
        track: JSONObject, restart: Boolean = false, refresh: Boolean = false,
        position: Double? = null, compatibleAudio: Boolean = false,
    ) {
        focusResume.cancel()
        resumeDuringResolution = if (refresh && !prepared) initialResumePolicy else null
        if (!refresh) initialResumePolicy = null
        savePosition(force = true); accountListening(true); cancelResolution(); cancelSourceSwitch()
        pendingUpgradeUrl = null
        if (!refresh) {
            resetRecovery()
            listeningSession = java.util.UUID.randomUUID().toString()
            diagnosticId = java.util.UUID.randomUUID().toString()
            diagnosticStarted = SystemClock.elapsedRealtime()
            diagnosticAccount = queue.accountSession
        }
        diagnosticPlaying = false
        val resolver = resolveListener ?: run { fail("后台播放器尚未就绪，请重新播放", "native_not_ready"); return }
        val scope = currentProfile() ?: run { fail("无法读取当前播放账号，请重新播放", "profile_unavailable"); return }
        if (listeningProfile != null && scope != listeningProfile) { fail("播放账号已变更，请重新播放", "account_changed"); return }
        val account = listeningAccount ?: queue.accountSession
        if (account != queue.accountSession) { fail("播放账号已变更，请重新播放", "account_changed"); return }
        handler.removeCallbacks(ticker); player?.release(); player = null; prepared = false; seeking = false
        nativeTrack = track; id = track.getString("id"); title = track.mediaText("title").ifBlank { "BiliMusic" }
        lyricRequests.supersede()
        if (!FloatingLyricsOverlay.hasTimeline(id, lyricSession())) FloatingLyricsOverlay.setTimeline(JSONObject())
        artist = track.mediaText("artist"); album = track.mediaText("album")
        metadataDuration = track.optDouble("durationSeconds", 0.0)
        requestedStartPosition = position ?: 0.0
        lastPosition = if (resumeDuringResolution == null) requestedStartPosition else 0.0
        lastDuration = track.optDouble("durationSeconds", 0.0)
        playbackRevision += 1; resolveProfile = scope; resolveAccount = account; resolvingNative = true; status = "buffering"; error = null
        prepareArtwork(track.mediaText("coverUrl")); updateMetadata(); updateSessionPlaybackState()
        startPlaybackForeground()
        // MediaPlayer's wake lock does not cover the gap between two tracks.
        transitionWakeLock = getSystemService(PowerManager::class.java)?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "BiliMusic:queue").also { it?.acquire(30_000) }
        val request = nativeRequest
        android.util.Log.i("BiliMusicPlayback", "resolve request=$request refresh=$refresh compatibleAudio=$compatibleAudio")
        handler.postDelayed({ if (resolvingNative && request == nativeRequest) fail("后台音源解析超时，请重新播放", "source_timeout") }, 25_000)
        publish()
        if (request != nativeRequest || !resolvingNative) return
        val payload = queue.payload(scope, track, restart, refresh, position)
            .put("diagnosticId", diagnosticId).put("initialErrorCode", initialErrorCode)
        if (compatibleAudio) payload.put("compatibleAudio", true)
        try { resolver(request, payload) }
        catch (_: Exception) { fail("后台播放请求失败，请重新播放", "native_request_failed") }
    }
    fun resolved(request: Long, result: JSONObject) {
        if (result.optString("kind") == "lyrics") {
            if (player == null || !lyricRequests.take(request, lyricSession(), currentProfile(), queue.accountSession)) return
            result.optJSONObject("timeline")?.let { timeline ->
                FloatingLyricsOverlay.setTimeline(timeline.put("id", id).put("session", lyricSession()))
                notifyLyricsChanged()
            }
            return
        }
        if (request != nativeRequest || !resolvingNative) return
        val scope = currentProfile() ?: run { fail("无法读取当前播放账号，请重新播放", "profile_unavailable"); return }
        if (resolveProfile != scope || resolveAccount != queue.accountSession) { fail("播放账号已变更，请重新播放", "account_changed"); return }
        if (result.optBoolean("skip")) {
            val next = queue.skip(result.optString("entryId"))
            if (next == null) { control("pause"); cancelResolution() } else resolveTrack(next)
            return
        }
        if (result.has("error")) { fail(result.getString("error"), result.optString("errorCode", "source_unavailable")); return }
        val url = result.optString("url")
        val uri = android.net.Uri.parse(url)
        if (uri.scheme != "http" || uri.host != "127.0.0.1") { fail("无效的本地播放地址", "invalid_source"); return }
        queue.resolved(result)
        val track = result.getJSONObject("track"); nativeTrack = track
        val intent = Intent(this, PlaybackService::class.java).setAction("load")
            .putExtra("id", track.getString("id")).putExtra("title", track.mediaText("title"))
            .putExtra("artist", track.mediaText("artist")).putExtra("album", track.mediaText("album"))
            .putExtra("coverUrl", track.mediaText("coverUrl"))
            .putExtra("durationSeconds", track.optDouble("durationSeconds", 0.0))
            .putExtra("url", url).putExtra("upgradeUrl", result.optString("upgradeUrl").takeIf { it.startsWith("http://127.0.0.1:") })
            .putExtra("cachedAudio", result.optString("source") == "cache")
            .putExtra("loudnessGainDb", result.optDouble("loudnessGainDb", 0.0))
            .putExtra("position", result.optDouble("position", 0.0)).putExtra("volume", volume.toDouble())
            .putExtra("rate", playbackRate.toDouble()).putExtra("playing", true).putExtra("collectionRef", queue.collectionRef)
            .putExtra("nativeRecovery", recoveryAttempted).putExtra("diagnosticId", diagnosticId).putExtra("accountSession", resolveAccount)
        val automatic = result.optJSONObject("automaticResume")?.let {
            AutomaticResumePolicy().apply {
                enabled = it.optBoolean("enabled", true); thresholdSeconds = it.optDouble("thresholdSeconds", 0.0)
                collection = it.optBoolean("collection"); durationSeconds = it.optDouble("durationSeconds", 0.0)
            }
        } ?: resumeDuringResolution
        automatic?.let {
            intent.putExtra("automaticResume", true).putExtra("resumeEnabled", it.enabled)
                .putExtra("resumeThreshold", it.thresholdSeconds).putExtra("resumeCollection", it.collection)
                .putExtra("resumeDuration", it.durationSeconds)
        }
        load(intent, waitingForFocus = focusResume.pending)
    }
    private fun resetRecovery() {
        recoveryAttempted = false
        cacheFallbackAttempted = false
        initialErrorCode = null
    }

    private fun recover(compatibleAudio: Boolean = false, mediaServerDied: Boolean = false): Boolean {
        val track = nativeTrack ?: return false
        if (resolveListener == null) return false
        // A fresh player may have retried the same cached bytes after the first server death.
        val retryWithoutCache = mediaServerDied && recoveryAttempted && cachedAudio && !cacheFallbackAttempted &&
            initialErrorCode?.startsWith("android_media:${MediaPlayer.MEDIA_ERROR_SERVER_DIED}:") == true
        if (recoveryAttempted && !retryWithoutCache) return false
        val useCompatibleAudio = compatibleAudio || retryWithoutCache
        if (useCompatibleAudio && (queue.offlineOnly || track.optJSONObject("source")?.optString("provider") != "bilibili")) return false
        recoveryAttempted = true
        if (retryWithoutCache) cacheFallbackAttempted = true
        diagnostic("recovery", "started", if (useCompatibleAudio) "compatible_audio" else null)
        resolveTrack(track, refresh = true, position = if (prepared) lastPosition else requestedStartPosition, compatibleAudio = useCompatibleAudio)
        return true
    }

    private fun savePosition(force: Boolean = false) {
        val account = listeningAccount ?: return
        val media = player ?: return
        if (!prepared || seeking || id.isEmpty()) return
        val now = SystemClock.elapsedRealtime()
        if (!force && now - positionSavedAt < 15_000) return
        val position = runCatching { media.currentPosition / 1000.0 }.getOrNull() ?: return
        val duration = runCatching { media.duration / 1000.0 }.getOrDefault(0.0)
        val saved = if (didFinishTrack || position < 1.0 || (duration > 0 && position >= duration - 1.0)) 0.0 else position
        positionSavedAt = now
        listeningListener?.invoke(JSObject().put("accountSession", account).put("trackId", id)
            .put("position", saved).put("observedAt", System.currentTimeMillis()).put("collectionRef", collectionRef))
    }

    fun updateCollection(trackId: String, reference: String?) {
        if (trackId != id || collectionRef == reference) return
        savePosition(force = true)
        collectionRef = reference
        savePosition(force = true)
    }

    private fun accountListening(flush: Boolean = false) {
        val now = SystemClock.elapsedRealtime()
        val media = player
        val position = if (prepared && !seeking && status == "playing" && media != null)
            runCatching { media.currentPosition / 1000.0 }.getOrNull() else null
        val previous = listeningPosition
        if (position != null && previous != null) {
            listeningSeconds += ((position - previous) / playbackRate).coerceIn(0.0, (now - listeningAt) / 1000.0)
        }
        listeningPosition = position
        listeningAt = now
        val account = listeningAccount
        if ((flush || listeningSeconds >= 15.0) && account != null && id.isNotEmpty() && listeningSeconds > 0.0) {
            val seconds = listeningSeconds
            listeningSeconds = 0.0
            listeningListener?.invoke(JSObject().put("accountSession", account).put("trackId", id).put("seconds", seconds).put("observedAt", System.currentTimeMillis()).put("sessionId", listeningSession))
        }
    }
    private var playbackRevision = SystemClock.elapsedRealtime()
    private var stateSequence = 0L
    private val engineInstanceId = java.util.UUID.randomUUID().toString()
    private var lastFloatingStyle = -1L
    private var seekRevision = 0L
    private var lastPosition = 0.0
    private var lastDuration = 0.0
    private var playbackRate = 1f
    private var outputGain = OutputGain()
    private var focusDucked = false
    private var outputRamp: Runnable? = null
    fun configureLoudness(enabled: Boolean, revision: Long) {
        if (outputGain.configure(enabled,revision)) applyOutput(true)
    }
    private fun applyOutput(smooth: Boolean = false) {
        outputRamp?.let { handler.removeCallbacks(it) }; outputRamp = null
        outputGain.transition(SystemClock.elapsedRealtime(),smooth)
        val media=player ?: return
        val ramp=object:Runnable {
            override fun run() {
                if (player !== media) return
                val now=SystemClock.elapsedRealtime()
                val level=outputGain.level(volume,if(focusDucked) .2f else 1f,now)
                media.setVolume(level,level)
                if(outputGain.active(now)) handler.postDelayed(this,20)
                else outputRamp=null
            }
        }
        outputRamp=ramp;ramp.run()
    }
    private var volume = 1f
    private data class Artwork(val bitmap: Bitmap, val encoded: ByteArray)
    private var artwork: Artwork? = null
    private var artworkUrl: String? = null
    private val artworkCache = android.util.LruCache<String, Artwork>(8)
    private val artworkExecutor = java.util.concurrent.Executors.newSingleThreadExecutor()
    private var artworkTask: java.util.concurrent.Future<*>? = null
    private var systemUpdateScheduled = false
    private var lastSystemPosition = -10.0
    private var lastSystemStatus = ""
    private var mediaAdvancedAt = SystemClock.elapsedRealtime()
    private var watchdogPosition = -1
    private fun resetPlaybackWatchdog() { mediaAdvancedAt = SystemClock.elapsedRealtime(); watchdogPosition = -1 }
    private val ticker = object : Runnable {
        override fun run() {
            if (expireSleepIfNeeded()) return
            if (status == "playing" || status == "buffering") {
                val position = if (prepared && !seeking) runCatching { player?.currentPosition ?: -1 }.getOrDefault(-1) else -1
                if (position >= 0 && watchdogPosition >= 0 && position > watchdogPosition + 10) mediaAdvancedAt = SystemClock.elapsedRealtime()
                watchdogPosition = position
                if (SystemClock.elapsedRealtime() - mediaAdvancedAt >= 12_000) { if (!recover()) fail("音频缓冲超时，请重试", "audio_stalled"); return }
            }
            if (status == "playing") savePosition()
            if (status == "playing" && prepared && !seeking && sourceCandidate == null && lastPosition + 0.001 >= upgradeAfterPosition) {
                val url = pendingUpgradeUrl
                pendingUpgradeUrl = null
                if (url != null) switchSource(url, id) { /* Keep the initial stream if preparation fails. */ }
            }
            if (mediaLyric() != displayedLyric) { updateMetadata();publish() } else publish(false)
            if (status == "playing" || status == "buffering") handler.postDelayed(this, 500)
        }
    }
    private val unplugged = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) { control("pause") }
    }
    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    override fun onUpdateNotification(session: MediaSession, startInForegroundRequired: Boolean) {
        // The service posts the same notification when resolving, pausing or advancing a source.
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Media3 does not own our foreground notification or activity lifetime.
        // Keep the started service available while resolving a track or waiting to resume.
    }

    override fun onCreate() {
        FloatingLyricsOverlay.attach(this)
        super.onCreate(); instance = this
        audioManager = checkNotNull(getSystemService(AudioManager::class.java))
        getSystemService(NotificationManager::class.java)?.createNotificationChannel(
            NotificationChannel(CHANNEL, "音乐播放", NotificationManager.IMPORTANCE_LOW).apply {
                setSound(null, null); enableVibration(false); lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            })
        queueData?.let { updateQueue(it) }
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(unplugged, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), RECEIVER_NOT_EXPORTED)
        else registerReceiver(unplugged, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
    }
    private fun createSession() {
        val builder = MediaSession.Builder(this, sessionPlayer)
        builder.setBitmapLoader(object : BitmapLoader {
            override fun supportsMimeType(mimeType: String) = mimeType == "image/webp"

            override fun decodeBitmap(data: ByteArray): ListenableFuture<Bitmap> {
                // The service already fetched and decoded this image. Publish it together with its track.
                val current = artwork?.takeIf { it.encoded.contentEquals(data) }
                return if (current != null) Futures.immediateFuture(current.bitmap)
                    else Futures.immediateFailedFuture(IllegalArgumentException("Artwork is no longer current"))
            }

            override fun loadBitmap(uri: Uri): ListenableFuture<Bitmap> =
                Futures.immediateFailedFuture(UnsupportedOperationException("Only prepared artwork is published"))
        })
        builder.setCallback(object : MediaSession.Callback {
            override fun onMediaButtonEvent(
                session: MediaSession, controllerInfo: MediaSession.ControllerInfo, intent: Intent,
            ): Boolean = intent.mediaButtonKey()?.let(::handleMediaButton) == true

            override fun onConnect(
                session: MediaSession, controller: MediaSession.ControllerInfo,
            ): MediaSession.ConnectionResult {
                val result = super.onConnect(session, controller)
                if (controller.controllerVersion != MediaSession.ControllerInfo.LEGACY_CONTROLLER_VERSION) return result
                // Media3's legacy queue IDs are positions. An older queue can point at a different song.
                return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                    .setAvailablePlayerCommands(result.availablePlayerCommands.buildUpon()
                        .remove(Player.COMMAND_SEEK_TO_MEDIA_ITEM).build())
                    .build()
            }
        })
        packageManager.getLaunchIntentForPackage(packageName)?.let {
            builder.setSessionActivity(PendingIntent.getActivity(this, 0, it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
        }
        val activeSession = builder.build()
        session = activeSession
        controller = MediaController(this, activeSession.platformToken)
        addSession(activeSession)
        attachController()
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            MEDIA_BUTTON_RESUME -> resumePausedPlayback(startId)
            Intent.ACTION_MEDIA_BUTTON -> {
                val key = intent.mediaButtonKey()
                if (hasResumeTarget()) {
                    // Media3 on Android 11 and earlier can address the service via a foreground PendingIntent.
                    startPlaybackForeground()
                    key?.let(::handleMediaButton)
                    if (status == "paused" && !focusResume.pending) stopForeground(STOP_FOREGROUND_DETACH)
                } else if (key?.startsPausedPlayback() == true) resumePausedPlayback(startId)
                else stopRejectedMediaButtonStart(startId)
            }
            "prepare" -> {
                pausedPlayback = null
                mediaButtons.cancel()
                playbackRevision += 1
                cancelResolution(); resetRecovery()
                initialResumePolicy = null; resumeDuringResolution = null
                pendingUpgradeUrl = null
                if (focusResume.pending) abandonFocus()
                cancelSourceSwitch()
                savePosition(force = true)
                accountListening(true)
                listeningSession = java.util.UUID.randomUUID().toString()
                listeningAccount = null
                seeking = false
                handler.removeCallbacks(ticker); player?.release(); player = null; prepared = false
                id = intent.getStringExtra("id") ?: ""; title = intent.getStringExtra("title").orEmpty().ifBlank { "BiliMusic" }
                lyricRequests.supersede()
                FloatingLyricsOverlay.setTimeline(JSONObject())
                artist = intent.getStringExtra("artist") ?: ""; requestedStartPosition = intent.getDoubleExtra("position", 0.0)
                album = intent.getStringExtra("album").orEmpty()
                metadataDuration = intent.getDoubleExtra("durationSeconds", 0.0)
                lastPosition = 0.0; lastDuration = 0.0
                queue.observe(id)
                nativeTrack = queue.find(id)
                prepareArtwork(intent.getStringExtra("coverUrl"))
                status = "buffering"; error = null
                updateMetadata(); updateSessionPlaybackState()
                startPlaybackForeground()
            }
            "load" -> { pausedPlayback = null; mediaButtons.cancel(); load(intent) }
            "next", "previous", "toggle", "resume", "pause", "stop" -> controlFromMediaSession(intent.action!!, notification = true)
        }
        // Never restart silently after Android kills the process: saved URLs are temporary.
        return START_NOT_STICKY
    }

    private fun resumePausedPlayback(startId: Int) {
        // A play request from the UI, or another system delivery, can win the race.
        if (hasResumeTarget()) return
        val resume = pausedPlayback
        pausedPlayback = null
        if (resume == null || resolveListener == null || resume.profile != currentProfile() ||
            resume.queue.accountSession != queue.accountSession) {
            stopRejectedMediaButtonStart(startId)
            return
        }
        queue = resume.queue
        queueData?.let(::updateQueue)
        volume = resume.volume
        playbackRate = resume.rate
        outputGain = resume.gain
        listeningProfile = resume.profile
        listeningAccount = queue.accountSession.takeIf { it.isNotEmpty() }
        diagnosticAccount = queue.accountSession
        android.util.Log.i("BiliMusicPlayback", "restarting paused playback from media button")
        resolveTrack(queue.find(resume.track.getString("id")) ?: resume.track, refresh = true, position = resume.position)
        diagnostic("media-key", "started", "service_restart")
    }

    private fun stopRejectedMediaButtonStart(startId: Int) {
        // Fulfill the foreground start contract even if an account or queue change invalidated the checkpoint.
        startPlaybackForeground()
        stopSelfResult(startId)
    }

    private fun load(intent: Intent, waitingForFocus: Boolean = false) {
        // Keep the transition wake lock until MediaPlayer has prepared and sought.
        nativeRequest = resolutionRequests.incrementAndGet(); resolvingNative = false
        if (!intent.getBooleanExtra("nativeRecovery", false)) resetRecovery()
        cachedAudio = intent.getBooleanExtra("cachedAudio", false)
        val nextDiagnostic = intent.getStringExtra("diagnosticId") ?: java.util.UUID.randomUUID().toString()
        if (nextDiagnostic != diagnosticId) {
            diagnosticId = nextDiagnostic
            diagnosticStarted = SystemClock.elapsedRealtime()
        }
        diagnosticAccount = queue.accountSession
        diagnosticPlaying = false
        if (!waitingForFocus) focusResume.cancel()
        cancelSourceSwitch()
        savePosition(force = true)
        accountListening(true)
        if (!intent.getBooleanExtra("nativeRecovery", false) && (id != intent.getStringExtra("id") || intent.getDoubleExtra("position", 0.0) < 1.0)) listeningSession = java.util.UUID.randomUUID().toString()
        playbackRate = intent.getDoubleExtra("rate", 1.0).coerceIn(0.75, 2.0).toFloat()
        positionSavedAt = SystemClock.elapsedRealtime() - 15_000
        collectionRef = intent.getStringExtra("collectionRef")
        didFinishTrack = false
        playbackRevision = maxOf(playbackRevision + 1,SystemClock.elapsedRealtime())
        seeking = false
        listeningPosition = null
        listeningSeconds = 0.0
        listeningProfile = currentProfile()
        listeningAccount = (intent.getStringExtra("accountSession") ?: queue.accountSession).takeIf { it.isNotEmpty() }
        playbackLyricsAccount = queue.accountSession
        handler.removeCallbacks(ticker); player?.release(); player = null; prepared = false
        id = intent.getStringExtra("id") ?: ""; title = intent.getStringExtra("title").orEmpty().ifBlank { "BiliMusic" }
        if (!FloatingLyricsOverlay.hasTimeline(id, lyricSession())) FloatingLyricsOverlay.setTimeline(JSONObject())
        queue.observe(id)
        diagnostic("start", "started")
        nativeTrack = queue.find(id) ?: nativeTrack?.takeIf { it.optString("id") == id }
        artist = intent.getStringExtra("artist") ?: ""; volume = intent.getDoubleExtra("volume", 1.0).coerceIn(0.0,1.0).toFloat()
        album = intent.getStringExtra("album").orEmpty()
        metadataDuration = intent.getDoubleExtra("durationSeconds", 0.0)
        if(intent.hasExtra("loudnessEnabled")) outputGain.configure(intent.getBooleanExtra("loudnessEnabled",false),intent.getLongExtra("loudnessRevision",0))
        outputGain.plan(intent.getDoubleExtra("loudnessGainDb",0.0))
        prepareArtwork(intent.getStringExtra("coverUrl"))
        requestedStartPosition = intent.getDoubleExtra("position", 0.0)
        val automaticResume = intent.getBooleanExtra("automaticResume", false)
        lastPosition = if (automaticResume) 0.0 else requestedStartPosition
        lastDuration = 0.0
        pendingUpgradeUrl = intent.getStringExtra("upgradeUrl")
        upgradeAfterPosition = intent.getDoubleExtra("position", 0.0) + 0.75
        val playWhenReady = intent.getBooleanExtra("playing", true)
        status = if (playWhenReady && !waitingForFocus) "buffering" else "paused"
        error = null
        updateMetadata(); updateSessionPlaybackState()
        startPlaybackForeground()
        if (!playWhenReady) abandonFocus()
        if (status == "buffering" && !requestFocus()) status = "paused"
        try {
            resetPlaybackWatchdog()
            val media = MediaPlayer(); player = media
            media.setAudioAttributes(playbackAttributes)
            media.setWakeMode(this, PowerManager.PARTIAL_WAKE_LOCK)
            applyOutput()
            val resumePolicy = if (automaticResume) AutomaticResumePolicy().apply {
                enabled = intent.getBooleanExtra("resumeEnabled", true)
                thresholdSeconds = intent.getDoubleExtra("resumeThreshold", 0.0)
                collection = intent.getBooleanExtra("resumeCollection", false)
                durationSeconds = intent.getDoubleExtra("resumeDuration", 0.0)
            } else null
            initialResumePolicy = resumePolicy
            bindMedia(media,intent.getDoubleExtra("position",0.0),resumePolicy)
            media.setDataSource(mediaPlayerSource(intent.getStringExtra("url"))); media.prepareAsync(); publish(); handler.removeCallbacks(ticker); handler.post(ticker)
            refreshPlaybackLyrics()
        } catch (_: Exception) { fail("音频加载失败，请重新播放", "audio_prepare_failed") }
    }
    private fun bindMedia(media:MediaPlayer,initialPosition:Double,resumePolicy:AutomaticResumePolicy? = null) {
            media.setOnPreparedListener {
                if (player !== it) return@setOnPreparedListener
                diagnostic("media-ready", "succeeded")
                prepared = true
                lastDuration = it.duration / 1000.0
                val position = runCatching { playbackStartPosition(initialPosition,lastDuration,resumePolicy) }.getOrElse {
                    prepared = false; fail(it.message ?: "无法读取视频总时长", "duration_unavailable"); return@setOnPreparedListener
                }
                transitionWakeLock?.let { lock -> if (lock.isHeld) lock.release() }; transitionWakeLock = null
                val offset = (position * 1000).toLong()
                initialResumePolicy = null
                lastPosition = position
                upgradeAfterPosition = position + 0.75
                updateMetadata()
                if (offset > 0) {
                    seeking = true
                    it.seekTo(offset, MediaPlayer.SEEK_CLOSEST)
                } else if (status == "buffering" && hasAudioFocus) {
                    if (!startReadyMedia(it)) return@setOnPreparedListener
                }
                if (status == "paused" && !focusResume.pending) stopForeground(STOP_FOREGROUND_DETACH)
                publish(); handler.removeCallbacks(ticker); handler.post(ticker)
            }
            media.setOnSeekCompleteListener {
                if (player !== it) return@setOnSeekCompleteListener
                seeking = false
                listeningPosition = null
                if (status == "buffering" && hasAudioFocus && !it.isPlaying && !startReadyMedia(it)) return@setOnSeekCompleteListener
                savePosition(force = true)
                if (mediaLyric() != displayedLyric) { updateMetadata();publish() } else publish(false)
            }
            media.setOnCompletionListener {
                if (player !== it) return@setOnCompletionListener
                didFinishTrack = true; savePosition(force = true)
                accountListening(true)
                if (!expireSleepIfNeeded()) advance(1, ended = true)
                handler.postDelayed({ if (player === it && status == "paused" && !focusResume.pending) stopForeground(STOP_FOREGROUND_DETACH) }, 5000)
            }
            media.setOnErrorListener { candidate, what, extra ->
                if (player === candidate) {
                    android.util.Log.w("BiliMusicPlayback", "media error what=$what extra=$extra status=$status")
                    val code = "android_media:$what:$extra"
                    if (!recoveryAttempted) initialErrorCode = code
                    val serviceDied = what == MediaPlayer.MEDIA_ERROR_SERVER_DIED
                    val connectionFailed = what == MediaPlayer.MEDIA_ERROR_IO || extra == MediaPlayer.MEDIA_ERROR_IO ||
                        what == MediaPlayer.MEDIA_ERROR_TIMED_OUT || extra == MediaPlayer.MEDIA_ERROR_TIMED_OUT
                    val incompatible = what == MediaPlayer.MEDIA_ERROR_MALFORMED || extra == MediaPlayer.MEDIA_ERROR_MALFORMED ||
                        what == MediaPlayer.MEDIA_ERROR_UNSUPPORTED || extra == MediaPlayer.MEDIA_ERROR_UNSUPPORTED ||
                        (what == MediaPlayer.MEDIA_ERROR_UNKNOWN && !prepared)
                    when {
                        serviceDied -> if (status == "paused" || !recover(mediaServerDied = true)) fail("Android 媒体服务已中断，请重新播放", code)
                        connectionFailed -> if (status == "paused" || !recover()) fail("无法连接音频服务，请重试", code)
                        incompatible -> if (status == "paused" || !recover(compatibleAudio = true)) {
                            fail(if (queue.offlineOnly) "本地音频无法播放，请联网后重新下载" else "当前音源无法解码，请尝试更换音质", code)
                        }
                        else -> fail("音频播放失败，请重试", code)
                    }
                }
                true
            }
            media.setOnInfoListener { candidate, what, _ ->
                if (player === candidate && status != "paused" && !seeking) {
                    if (what == MediaPlayer.MEDIA_INFO_BUFFERING_START) { diagnostic("buffer", "started"); accountListening(); status = "buffering"; publish() }
                    if (what == MediaPlayer.MEDIA_INFO_BUFFERING_END) { diagnostic("buffer", "succeeded"); status = "playing"; publish() }
                }; false
            }
    }
    private fun cancelSourceSwitch(message:String?="音质切换已取消") {
        sourceReadinessCheck?.let(handler::removeCallbacks); sourceReadinessCheck = null
        sourceTimeout?.let{handler.removeCallbacks(it)};sourceTimeout=null
        sourceCandidate?.release();sourceCandidate=null
        val reply=sourceReply;sourceReply=null;reply?.invoke(message)
    }
    fun switchSource(url:String,expectedId:String,gainDb:Double?=null,reply:(String?)->Unit) {
        pendingUpgradeUrl = null
        cancelSourceSwitch()
        val original=player
        if(original==null || !prepared || id!=expectedId){reply("当前歌曲已变更，请重新选择音质");return}
        val revision=playbackRevision
        val seek=seekRevision
        val candidate=MediaPlayer();sourceCandidate=candidate;sourceReply=reply
        sourceTimeout=Runnable{if(sourceCandidate===candidate)cancelSourceSwitch("新音源准备超时，已保留原音质")}.also{handler.postDelayed(it,12000)}
        fun valid()=sourceCandidate===candidate && player===original && id==expectedId && playbackRevision==revision && seekRevision==seek
        var previewRate: Float? = null
        fun commit(shouldPlay: Boolean) {
            if (shouldPlay && previewRate != playbackRate) startAtRate(candidate)
            sourceReadinessCheck = null
            accountListening(true)
            if (original.isPlaying) original.pause()
            player=candidate;sourceCandidate=null
            cachedAudio = false
            sourceTimeout?.let{handler.removeCallbacks(it)};sourceTimeout=null
            prepared=true;seeking=false;playbackRevision+=1;listeningPosition=null
            lastPosition=candidate.currentPosition/1000.0;lastDuration=candidate.duration/1000.0
            bindMedia(candidate,0.0);gainDb?.let { outputGain.plan(it) };applyOutput();resetPlaybackWatchdog()
            original.release()
            status = if (shouldPlay) "playing" else "paused"
            publish();val completion=sourceReply;sourceReply=null;completion?.invoke(null)
        }
        var candidateBuffering = false
        fun originalPosition() = if (seeking) (lastPosition * 1000).toLong() else original.currentPosition.toLong()
        fun alignAndWarm() {
            if (!valid()) {
                if (sourceCandidate === candidate) cancelSourceSwitch()
                return
            }
            val position = originalPosition()
            val baseline = candidate.currentPosition
            if (kotlin.math.abs(baseline - position) > 250) {
                candidate.seekTo(position, MediaPlayer.SEEK_CLOSEST)
                return
            }
            if (status == "paused" || !hasAudioFocus) {
                if (previewRate != null) candidate.pause()
                commit(false)
                return
            }
            // MediaPlayer can finish a seek before its target range has decoded.
            // Run the candidate muted and keep the original audible until it advances.
            if (previewRate == null) {
                startAtRate(candidate)
                previewRate = playbackRate
            }
            sourceReadinessCheck = object : Runnable {
                override fun run() {
                    if (!valid() || status == "paused" || !hasAudioFocus) {
                        if (sourceCandidate === candidate) cancelSourceSwitch()
                        return
                    }
                    try {
                        val candidatePosition = candidate.currentPosition
                        if (!sourceHasPlayableProgress(baseline, candidatePosition, candidate.isPlaying, candidateBuffering)) {
                            handler.postDelayed(this, 50)
                            return
                        }
                        val current = originalPosition()
                        if (kotlin.math.abs(candidatePosition - current) > 250) {
                            candidate.seekTo(current, MediaPlayer.SEEK_CLOSEST)
                        } else commit(true)
                    } catch (_: IllegalStateException) {
                        cancelSourceSwitch("新音源无法播放，已保留原音质")
                    }
                }
            }.also { handler.postDelayed(it, 50) }
        }
        try {
            candidate.setAudioAttributes(playbackAttributes)
            candidate.setWakeMode(this,PowerManager.PARTIAL_WAKE_LOCK);candidate.setVolume(0f,0f)
            candidate.setOnErrorListener{_,_,_->if(sourceCandidate===candidate)cancelSourceSwitch("新音源无法播放，已保留原音质");true}
            candidate.setOnInfoListener { _, what, _ ->
                if (what == MediaPlayer.MEDIA_INFO_BUFFERING_START) candidateBuffering = true
                if (what == MediaPlayer.MEDIA_INFO_BUFFERING_END) candidateBuffering = false
                false
            }
            val advance = {
                try { alignAndWarm() }
                catch (_: IllegalStateException) { cancelSourceSwitch("新音源无法播放，已保留原音质") }
            }
            candidate.setOnPreparedListener{
                candidate.setOnSeekCompleteListener{advance()}
                advance()
            }
            candidate.setDataSource(mediaPlayerSource(url));candidate.prepareAsync()
        }catch(_:Exception){cancelSourceSwitch("新音源无法加载，已保留原音质")}
    }
    private fun mediaPlayerSource(url: String?): String? {
        if (url == null || Build.VERSION.SDK_INT >= 29 || packageName != "app.bilimusic.large") return url
        val uri = android.net.Uri.parse(url)
        if (uri.scheme != "http" || uri.host != "127.0.0.1" || uri.query != null) return url
        return uri.buildUpon().appendQueryParameter("legacy_mp4", "1").build().toString()
    }

    private fun fail(message: String, code: String) {
        android.util.Log.w("BiliMusicPlayback", "failed: $code")
        diagnostic(if (resolvingNative) "source" else if (prepared) "control" else "start", "failed", code)
        if (recoveryAttempted && !diagnosticPlaying) diagnostic("recovery", "failed", code)
        cancelResolution()
        pendingUpgradeUrl = null; cancelSourceSwitch()
        accountListening(true)
        status = "error"; error = message; errorCode = code; prepared = false
        player?.release(); player = null; handler.removeCallbacks(ticker)
        abandonFocus(); publish(); stopForeground(STOP_FOREGROUND_DETACH)
    }
    private fun pause() {
        if (!focusResume.pending) cancelResolution()
        savePosition(force = true)
        accountListening(true)
        if (prepared && player?.isPlaying == true) player?.pause()
        samplePlaybackPosition()
        status = "paused"; handler.removeCallbacks(ticker); publish()
        // Keep the foreground service while waiting for Android to return focus.
        if (!focusResume.pending) stopForeground(STOP_FOREGROUND_DETACH)
    }
    private fun clearSleep() {
        handler.removeCallbacks(sleepWork)
        sleepEndsAt = 0L; sleepDeadline = 0L; sleepDuration = 0.0; sleepExpired = false
    }
    private fun scheduleSleep(seconds: Double) {
        clearSleep()
        sleepDuration = seconds
        val delay = (seconds * 1000).toLong()
        sleepEndsAt = SystemClock.elapsedRealtime() + delay
        sleepDeadline = System.currentTimeMillis() + delay
        handler.postDelayed(sleepWork, delay)
        publish()
    }
    private fun expireSleepIfNeeded(): Boolean {
        if (sleepEndsAt == 0L || SystemClock.elapsedRealtime() < sleepEndsAt) return false
        handler.removeCallbacks(sleepWork)
        sleepEndsAt = 0L; sleepDeadline = 0L; sleepExpired = true
        control("pause")
        return true
    }
    private fun startAtRate(media: MediaPlayer) {
        try {
            media.playbackParams = PlaybackParams().allowDefaults().setSpeed(playbackRate)
        } catch (_: IllegalArgumentException) {
            playbackRate = 1f
            media.playbackParams = PlaybackParams().allowDefaults().setSpeed(playbackRate)
        }
        // A nonzero speed can start decoding without registering playback with AudioService.
        // Explicitly start so Android can route global media keys to this session.
        media.start()
    }
    private fun startReadyMedia(media: MediaPlayer): Boolean {
        try {
            startAtRate(media)
        } catch (_: IllegalStateException) {
            if (!recover()) fail("音频无法恢复播放，请重试", "audio_resume_failed")
            return false
        }
        status = "playing"
        if (!diagnosticPlaying) {
            diagnosticPlaying = true
            diagnostic("start", "succeeded")
            if (recoveryAttempted) diagnostic("recovery", "succeeded")
        }
        return true
    }

    private fun createFocusRequest(): AudioFocusRequest {
        lateinit var request: AudioFocusRequest
        request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(playbackAttributes)
            .setAcceptsDelayedFocusGain(true)
            .setOnAudioFocusChangeListener({ change ->
                if (focus === request) onFocusChange(change)
            }, handler).build()
        return request
    }

    private fun onFocusChange(change: Int) {
        android.util.Log.i("BiliMusicPlayback", "focus change=$change status=$status")
        val code = when (change) {
            AudioManager.AUDIOFOCUS_GAIN -> "gain"
            AudioManager.AUDIOFOCUS_LOSS -> "loss"
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> "transient_loss"
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> "duck"
            else -> null
        }
        if (code != null) diagnostic("audio-focus", "succeeded", code)
        when (change) {
            AudioManager.AUDIOFOCUS_LOSS -> control("pause")
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> {
                hasAudioFocus = false
                focusResume.interrupted(status == "playing" || status == "buffering")
                pause()
            }
            AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> {
                focusDucked = true
                applyOutput()
            }
            AudioManager.AUDIOFOCUS_GAIN -> {
                hasAudioFocus = true
                focusDucked = false
                applyOutput()
                if (focusResume.regained()) resumeWithFocus()
            }
        }
    }

    private fun abandonFocus() {
        val request = focus
        focus = null
        hasAudioFocus = false
        focusDucked = false
        focusResume.cancel()
        request?.let(audioManager::abandonAudioFocusRequest)
    }

    private fun requestFocus(renew: Boolean = false): Boolean {
        if (hasAudioFocus) return true
        val previous = focus
        // Android delivers focus changes asynchronously. A manual retry gets a
        // new listener so a queued loss from the interrupted request cannot pause it.
        val request = if (renew || previous == null) createFocusRequest() else previous
        val result = audioManager.requestAudioFocus(request)
        android.util.Log.i("BiliMusicPlayback", "focus request=$result status=$status")
        if (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED || result == AudioManager.AUDIOFOCUS_REQUEST_DELAYED) {
            focus = request
            if (previous != null && previous !== request) audioManager.abandonAudioFocusRequest(previous)
        }
        when (result) {
            AudioManager.AUDIOFOCUS_REQUEST_GRANTED -> {
                hasAudioFocus = true
                focusResume.cancel()
                focusDucked = false
                applyOutput()
                diagnostic("audio-focus", "succeeded", "gain")
                return true
            }
            AudioManager.AUDIOFOCUS_REQUEST_DELAYED -> {
                focusResume.interrupted(true)
                diagnostic("audio-focus", "started", "focus_delayed")
            }
            else -> {
                if (previous !== request) audioManager.abandonAudioFocusRequest(request)
                // A failed retry can leave a valid request waiting for Android to return focus.
                if (!focusResume.pending) abandonFocus()
                error = "无法获得音频焦点，请稍后重试"
                errorCode = "audio_focus_denied"
                diagnostic("audio-focus", "failed", errorCode)
            }
        }
        return false
    }

    private fun resumeWithFocus() {
        if (expireSleepIfNeeded()) return
        resetPlaybackWatchdog()
        error = null; errorCode = null
        val media = player
        if (!resolvingNative && media == null) {
            val track = nativeTrack
            if (track == null) {
                abandonFocus()
                emitAction("resume")
            } else {
                resetRecovery()
                val position = if (initialResumePolicy != null) requestedStartPosition else lastPosition
                resolveTrack(track, refresh = true, position = position)
            }
            return
        }
        if (media != null && prepared && !seeking) {
            if (!startReadyMedia(media)) return
        } else status = "buffering"
        handler.removeCallbacks(ticker)
        if (media != null) handler.post(ticker)
        publish()
    }
    private fun emitAction(action: String) { listener?.invoke(snapshot().put("action",action)) }
    internal fun hasResumeTarget() = player != null || nativeTrack != null || resolvingNative

    fun control(action: String, value: Double = 0.0) {
        when (action) {
            "next", "previous", "toggle", "resume", "pause", "stop" -> mediaButtons.cancel()
        }
        if(action == "toggle") { control(if(status == "playing" || status == "buffering") "pause" else "resume");return }
        when (action) {
            "next" -> advance(1)
            "previous" -> advance(-1)
            "sleepStart" -> if (value in 60.0..10800.0) scheduleSleep(value)
            "sleepCancel" -> { clearSleep(); publish() }
            "sleepDismiss" -> { sleepExpired = false; publish() }
            "sleepRepeat" -> if (sleepExpired && sleepDuration > 0) { scheduleSleep(sleepDuration); control("resume") }
            "pause" -> { abandonFocus(); pause() }
            "resume" -> {
                if (expireSleepIfNeeded() || status == "playing" || status == "buffering") return
                if (!hasResumeTarget()) {
                    emitAction("resume")
                    return
                }
                startPlaybackForeground()
                error = null; errorCode = null
                if (requestFocus(renew = true)) resumeWithFocus() else pause()
            }
            "seek" -> if (prepared) {
                didFinishTrack = false
                accountListening(true)
                seeking = true
                resetPlaybackWatchdog()
                seekRevision += 1
                lastPosition = value.coerceAtLeast(0.0).coerceAtMost(if(lastDuration>0)lastDuration else value.coerceAtLeast(0.0))
                player?.seekTo((value.coerceAtLeast(0.0) * 1000).toLong(), MediaPlayer.SEEK_CLOSEST)
                publish()
            }
            "rate" -> if (value in 0.75..2.0) {
                accountListening()
                val rate = value.toFloat()
                if (prepared && !seeking && status != "paused" && player != null) {
                    val media = player ?: return
                    media.playbackParams = PlaybackParams().allowDefaults().setSpeed(rate)
                }
                playbackRate = rate
                publish()
            }
            "volume" -> { volume = value.coerceIn(0.0, 1.0).toFloat(); applyOutput() }
            "stop" -> { pausedPlayback = null; cancelResolution(); pendingUpgradeUrl = null;abandonFocus();cancelSourceSwitch();clearSleep(); savePosition(force = true); accountListening(true); snapshot(); player?.release(); player = null; prepared = false; status = "paused"; publish(); stopSelf() }
        }
    }
    private fun samplePlaybackPosition() {
        if (prepared && !seeking) {
            lastPosition = runCatching { player?.currentPosition?.div(1000.0) }.getOrNull() ?: lastPosition
        }
    }

    fun snapshot(): JSObject {
        stateSequence += 1
        expireSleepIfNeeded()
        samplePlaybackPosition()
        if (prepared) {
            lastDuration = runCatching { (player?.duration ?: 0) / 1000.0 }.getOrDefault(lastDuration)
        }
        val snapshot = JSObject().put("capabilities",org.json.JSONObject().put("autonomousQueue",queue.tracks.isNotEmpty()).put("seamlessSourceSwitch",true).put("nativeSleepTimer",true).put("snapshotRebind",true)).put("engineInstanceId",engineInstanceId).put("sessionId",listeningSession).put("diagnosticId", diagnosticId).put("sourceRevision",playbackRevision).put("autonomousQueue",queue.tracks.isNotEmpty()).put("queueVersion",queue.version).put("revision",playbackRevision).put("sequence",stateSequence).put("seekRevision",seekRevision).put("id", id).put("status", status).put("position", lastPosition)
            .put("track", nativeTrack).put("expandedEntries", queue.expanded).put("recoveryAttempted", recoveryAttempted)
            .put("duration", lastDuration).put("rate", playbackRate).put("stopped", player == null).put("error", error).put("floatingLyricsEnabled",FloatingLyricsOverlay.enabled)
            .put("sleepDeadline", sleepDeadline).put("sleepDuration", sleepDuration).put("sleepExpired", sleepExpired)
        if (error != null) {
            snapshot.put("errorCode", errorCode)
            if (recoveryAttempted && initialErrorCode != errorCode) snapshot.put("initialErrorCode", initialErrorCode)
        }
        if (lastFloatingStyle != FloatingLyricsOverlay.styleRevision.toLong()) {
            lastFloatingStyle = FloatingLyricsOverlay.styleRevision.toLong()
            snapshot.put("floatingLyricsStyleRevision",lastFloatingStyle).put("floatingLyricsFontSize",FloatingLyricsOverlay.fontSize)
                .put("floatingLyricsLocked",FloatingLyricsOverlay.locked).put("floatingLyricsLanguage",FloatingLyricsOverlay.language.value)
        }
        return snapshot
    }
    fun lyricPosition(): Pair<String,Double> = Pair(id,if(prepared && !seeking) runCatching { (player?.currentPosition ?: 0)/1000.0 }.getOrDefault(lastPosition) else lastPosition)
    fun lyricTitle(): String = title
    fun notifyLyricsChanged() { updateMetadata();publish() }
    internal fun refreshPlaybackNotification() {
        if (id.isNotEmpty() && (player != null || status == "buffering")) {
            lastNotification = null
            updateSystemPlayback()
        }
    }
    private fun publish(notify: Boolean = true) {
        accountListening()
        // The app receives state first; OS presentation is coalesced separately.
        listener?.invoke(snapshot())
        if (!notify && status == lastSystemStatus && kotlin.math.abs(lastPosition - lastSystemPosition) < 5) return
        if (systemUpdateScheduled) return
        systemUpdateScheduled = true
        handler.post {
            systemUpdateScheduled = false
            if (instance !== this) return@post
            updateSystemPlayback()
        }
    }
    private fun updateSystemPlayback() {
        lastSystemStatus = status; lastSystemPosition = lastPosition
        updateSessionPlaybackState()
        val current = notificationState()
        if (current == lastNotification) return
        getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION, notification(current))
        lastNotification = current
    }
    private fun updateSessionPlaybackState() {
        sessionPlayer.update(systemQueue, mediaText(), artwork?.encoded, status, (lastPosition * 1000).toLong(),
            playbackRate, hasOtherTracks(), error)
        if (session == null && id.isNotEmpty()) createSession()
    }
    private var displayedLyric: String? = null
    private fun mediaLyric() = SystemTitleLyrics.line(id, lyricPosition().second)
    private fun mediaText() = SystemTitleLyrics.mediaText(title, artist, displayedLyric)
    private fun updateMetadata() {
        val current = id.takeIf(String::isNotEmpty)?.let {
            val queued = nativeTrack?.takeIf { track -> track.optString("id") == id }
            SystemTrack(id, title, artist, album.ifBlank { queued?.mediaText("album").orEmpty() },
                ((lastDuration.takeIf { it > 0 } ?: metadataDuration.takeIf { it > 0 } ?: queued?.optDouble("durationSeconds", 0.0) ?: 0.0) * 1000).toLong())
        }
        systemQueue.update(queue.tracks, current)
        displayedLyric = mediaLyric()
    }
    private fun prepareArtwork(value: String?) {
        if (artworkUrl == value) return
        artworkTask?.cancel(true); artworkUrl = value; artwork = null
        if (value.isNullOrBlank()) return
        artworkCache.get(value)?.let { artwork = it; return }
        artworkTask = artworkExecutor.submit {
            val image = runCatching {
                val url = java.net.URL(value)
                require(url.protocol == "https" || url.protocol == "http")
                val connection = url.openConnection() as java.net.HttpURLConnection
                try {
                    connection.connectTimeout = 6000; connection.readTimeout = 6000
                    connection.setRequestProperty("Referer", "https://www.bilibili.com/")
                    connection.setRequestProperty("User-Agent", "Mozilla/5.0 BiliMusic/Android")
                    require(connection.responseCode in 200..299)
                    val bytes = connection.inputStream.use { input ->
                        val output = java.io.ByteArrayOutputStream()
                        val buffer = ByteArray(8192)
                        while (true) {
                            if (Thread.currentThread().isInterrupted) throw java.io.InterruptedIOException()
                            val count = input.read(buffer); if (count < 0) break
                            require(output.size() + count <= 8 * 1024 * 1024)
                            output.write(buffer, 0, count)
                        }
                        output.toByteArray()
                    }
                    val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
                    require(options.outWidth > 0 && options.outHeight > 0)
                    options.inSampleSize = 1
                    while (maxOf(options.outWidth, options.outHeight) / options.inSampleSize > 512) options.inSampleSize *= 2
                    options.inJustDecodeBounds = false
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)?.let { bitmap ->
                        val output = java.io.ByteArrayOutputStream()
                        @Suppress("DEPRECATION")
                        val format = if (Build.VERSION.SDK_INT >= 30) Bitmap.CompressFormat.WEBP_LOSSY else Bitmap.CompressFormat.WEBP
                        require(bitmap.compress(format, 85, output))
                        Artwork(bitmap, output.toByteArray())
                    }
                } finally { connection.disconnect() }
            }.getOrNull()
            handler.post {
                if (instance !== this || artworkUrl != value || image == null) return@post
                artworkCache.put(value, image); artwork = image; updateMetadata(); publish()
            }
        }
    }
    private fun pending(action: String, code: Int): PendingIntent = PendingIntent.getService(this, code,
        Intent(this, PlaybackService::class.java).setAction(action), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    private data class NotificationState(
        val text: SystemMediaText,
        val cover: Bitmap?,
        val canSkip: Boolean,
        val isPlaying: Boolean,
    )
    private var lastNotification: NotificationState? = null
    private fun notificationState() = NotificationState(mediaText(), artwork?.bitmap, hasOtherTracks(),
        status == "playing" || status == "buffering")

    private fun startPlaybackForeground() {
        val state = notificationState()
        startForeground(NOTIFICATION, notification(state))
        lastNotification = state
    }

    private fun notification(state: NotificationState): Notification {
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE) }
        val (text, cover, canSkip, isPlaying) = state
        val builder=Notification.Builder(this, CHANNEL)
            .setContentTitle(text.title).setContentText(text.subtitle).setLargeIcon(cover)
            .setSmallIcon(app.bilimusic.player.R.drawable.ic_music_notification).setColor(Color.rgb(255,115,88))
            .setCategory(Notification.CATEGORY_TRANSPORT).setShowWhen(false)
            .setContentIntent(open).setVisibility(Notification.VISIBILITY_PUBLIC).setOnlyAlertOnce(true)
            .setOngoing(isPlaying)
            .setDeleteIntent(pending("stop", 4))
        if (canSkip) builder.addAction(Notification.Action.Builder(android.R.drawable.ic_media_previous, "上一首", pending("previous", 1)).build())
        builder.addAction(if (isPlaying) {
            Notification.Action.Builder(android.R.drawable.ic_media_pause, "暂停", pending("pause", 2)).build()
        } else {
            Notification.Action.Builder(android.R.drawable.ic_media_play, "播放", pending("resume", 2)).build()
        })
        if (canSkip) builder.addAction(Notification.Action.Builder(android.R.drawable.ic_media_next, "下一首", pending("next", 3)).build())
        val compact = if (canSkip) intArrayOf(0, 1, 2) else intArrayOf(0)
        builder.setStyle(Notification.MediaStyle().setMediaSession(session?.platformToken).setShowActionsInCompactView(*compact))
        return builder.build()
    }
    override fun onDestroy() {
        val profile = listeningProfile
        val track = nativeTrack
        if (status == "paused" && prepared && profile != null && track != null && track.optString("id") == id &&
            profile == currentProfile() && playbackLyricsAccount == queue.accountSession && listeningAccount == queue.accountSession) {
            samplePlaybackPosition()
            pausedPlayback = PausedPlayback(profile, queue, track, if (didFinishTrack) 0.0 else lastPosition,
                playbackRate, volume, outputGain)
        }
        mediaButtons.cancel()
        outputRamp?.let { handler.removeCallbacks(it) };outputRamp=null
        cancelResolution()
        cancelSourceSwitch()
        FloatingLyricsOverlay.detach()
        savePosition(force = true)
        clearSleep()
        accountListening(true)
        artworkTask?.cancel(true); artworkExecutor.shutdownNow(); artworkCache.evictAll()
        handler.removeCallbacks(ticker); player?.release(); player = null
        abandonFocus()
        session?.let { removeSession(it); it.release() }
        session = null; controller = null; unregisterReceiver(unplugged)
        instance = null; stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy()
    }
}

internal fun sourceHasPlayableProgress(baseline: Int, position: Int, playing: Boolean, buffering: Boolean) =
    playing && !buffering && position - baseline >= 50
