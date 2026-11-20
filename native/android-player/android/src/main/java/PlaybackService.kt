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
        private const val CHANNEL = "bilimusic-playback"
        private const val NOTIFICATION = 1001
    }
    private var player: MediaPlayer? = null
    private var sourceCandidate: MediaPlayer? = null
    private var sourceReply: ((String?) -> Unit)? = null
    private var sourceTimeout: Runnable? = null
    private var pendingUpgradeUrl: String? = null
    private var upgradeAfterPosition = 0.0
    private var session: MediaSession? = null
    private var controller: MediaController? = null
    private val sessionPlayer = SystemSessionPlayer(::controlFromMediaSession, { control("seek", it / 1000.0) }) { id ->
        if (!expireSleepIfNeeded()) queue.find(id)?.let {
            mediaButtons.cancel()
            resolveTrack(it)
        }
    }
    private lateinit var audioManager: AudioManager
    private lateinit var focus: AudioFocusRequest
    private val playbackAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build()
    private val handler = Handler(Looper.getMainLooper())
    private val mediaButtons = MediaButtons(handler, ::hasOtherTracks, ::controlFromMediaSession)
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
    private val focusResume = FocusResume()
    private var prepared = false
    private var seeking = false
    private var listeningProfile: String? = null
    private var listeningPosition: Double? = null
    private var listeningAt = 0L
    private var listeningSession = java.util.UUID.randomUUID().toString()
    private var listeningSeconds = 0.0
    private var collectionRef: String? = null
    private var positionSavedAt = 0L
    private var didFinishTrack = false
    private val queue = NativeQueue()
    private val systemQueue = SystemPlaybackQueue()
    private var nativeTrack: JSONObject? = null
    private var nativeRequest = 0L
    private val lyricRequests = PlaybackLyricRequests()
    private var playbackLyricsAccount = ""
    private var resolvingNative = false
    private var recoveryAttempted = false
    private var resolveProfile: String? = null
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
            !FloatingLyricsOverlay.needsPlaybackTimeline() || FloatingLyricsOverlay.hasTimeline(id, lyricSession())) return
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
            (frame.optJSONArray("lines")?.length() ?: 0) == 0 ||
            frame.optBoolean("subtitles") && !FloatingLyricsOverlay.wantsSubtitles(this)) return
        lyricRequests.supersede()
        FloatingLyricsOverlay.setTimeline(frame)
        notifyLyricsChanged()
    }
    private fun cancelResolution() {
        nativeRequest += 1; resolvingNative = false
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

    private fun controlFromMediaSession(action: String) {
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
        if (!refresh) { recoveryAttempted = false; listeningSession = java.util.UUID.randomUUID().toString() }
        val resolver = resolveListener ?: run { fail("后台播放器尚未就绪，请重新播放", "native_not_ready"); return }
        val scope = currentProfile() ?: run { fail("无法读取当前播放账号，请重新播放", "profile_unavailable"); return }
        if (listeningProfile != null && scope != listeningProfile) { fail("播放账号已变更，请重新播放", "account_changed"); return }
        handler.removeCallbacks(ticker); player?.release(); player = null; prepared = false; seeking = false
        nativeTrack = track; id = track.getString("id"); title = track.mediaText("title").ifBlank { "BiliMusic" }
        lyricRequests.supersede()
        if (!FloatingLyricsOverlay.hasTimeline(id, lyricSession())) FloatingLyricsOverlay.setTimeline(JSONObject())
        artist = track.mediaText("artist"); album = track.mediaText("album")
        metadataDuration = track.optDouble("durationSeconds", 0.0)
        requestedStartPosition = position ?: 0.0
        lastPosition = 0.0; lastDuration = track.optDouble("durationSeconds", 0.0)
        playbackRevision += 1; resolveProfile = scope; resolvingNative = true; status = "buffering"; error = null
        prepareArtwork(track.mediaText("coverUrl")); updateMetadata(); updateSessionPlaybackState()
        startForeground(NOTIFICATION, notification())
        // MediaPlayer's wake lock does not cover the gap between two tracks.
        transitionWakeLock = getSystemService(PowerManager::class.java)?.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "BiliMusic:queue").also { it?.acquire(30_000) }
        val request = nativeRequest
        android.util.Log.i("BiliMusicPlayback", "resolve request=$request refresh=$refresh compatibleAudio=$compatibleAudio")
        handler.postDelayed({ if (resolvingNative && request == nativeRequest) fail("后台音源解析超时，请重新播放", "source_timeout") }, 25_000)
        publish()
        if (request != nativeRequest || !resolvingNative) return
        val payload = queue.payload(scope, track, restart, refresh, position)
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
        if (resolveProfile != scope) { fail("播放账号已变更，请重新播放", "account_changed"); return }
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
            .putExtra("loudnessGainDb", result.optDouble("loudnessGainDb", 0.0))
            .putExtra("position", result.optDouble("position", 0.0)).putExtra("volume", volume.toDouble())
            .putExtra("rate", playbackRate.toDouble()).putExtra("playing", true).putExtra("collectionRef", queue.collectionRef)
            .putExtra("nativeRecovery", recoveryAttempted)
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
        load(intent)
    }
    private fun recover(compatibleAudio: Boolean = false): Boolean {
        val track = nativeTrack ?: return false
        if (recoveryAttempted || resolveListener == null) return false
        if (compatibleAudio && (queue.offlineOnly || track.optJSONObject("source")?.optString("provider") != "bilibili")) return false
        recoveryAttempted = true
        resolveTrack(track, refresh = true, position = if (prepared) lastPosition else requestedStartPosition, compatibleAudio = compatibleAudio)
        return true
    }

    private fun savePosition(force: Boolean = false) {
        val scope = listeningProfile ?: return
        val media = player ?: return
        if (!prepared || seeking || id.isEmpty()) return
        val now = SystemClock.elapsedRealtime()
        if (!force && now - positionSavedAt < 15_000) return
        val position = runCatching { media.currentPosition / 1000.0 }.getOrNull() ?: return
        val duration = runCatching { media.duration / 1000.0 }.getOrDefault(0.0)
        val saved = if (didFinishTrack || position < 1.0 || (duration > 0 && position >= duration - 1.0)) 0.0 else position
        positionSavedAt = now
        listeningListener?.invoke(JSObject().put("scope", scope).put("trackId", id)
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
        val profile = listeningProfile
        if ((flush || listeningSeconds >= 15.0) && profile != null && id.isNotEmpty() && listeningSeconds > 0.0) {
            val seconds = listeningSeconds
            listeningSeconds = 0.0
            listeningListener?.invoke(JSObject().put("scope", profile).put("trackId", id).put("seconds", seconds).put("observedAt", System.currentTimeMillis()).put("sessionId", listeningSession))
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
            if (mediaTitle() != displayedTitle) { updateMetadata();publish() } else publish(false)
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
        focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(playbackAttributes)
            .setOnAudioFocusChangeListener { change ->
                android.util.Log.i("BiliMusicPlayback", "focus change=$change status=$status")
                when (change) {
                    AudioManager.AUDIOFOCUS_LOSS -> control("pause")
                    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> { focusResume.interrupted(status == "playing" || status == "buffering"); pause() }
                    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> { focusDucked=true; applyOutput() }
                    AudioManager.AUDIOFOCUS_GAIN -> {
                        focusDucked=false;applyOutput()
                        if (focusResume.regained()) control("resume")
                    }
                }
            }.build()
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
            "prepare" -> {
                mediaButtons.cancel()
                listeningSession = java.util.UUID.randomUUID().toString(); playbackRevision += 1
                cancelResolution(); recoveryAttempted = false
                initialResumePolicy = null; resumeDuringResolution = null
                pendingUpgradeUrl = null; focusResume.cancel(); cancelSourceSwitch()
                savePosition(force = true)
                accountListening(true)
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
                startForeground(NOTIFICATION, notification())
            }
            "load" -> { mediaButtons.cancel(); load(intent) }
            "next", "previous", "toggle", "resume", "pause", "stop" -> controlFromMediaSession(intent.action!!)
        }
        // Never restart silently after Android kills the process: saved URLs are temporary.
        return START_NOT_STICKY
    }
    private fun load(intent: Intent) {
        // Keep the transition wake lock until MediaPlayer has prepared and sought.
        nativeRequest += 1; resolvingNative = false
        recoveryAttempted = intent.getBooleanExtra("nativeRecovery", false)
        focusResume.cancel()
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
        playbackLyricsAccount = queue.accountSession
        handler.removeCallbacks(ticker); player?.release(); player = null; prepared = false
        id = intent.getStringExtra("id") ?: ""; title = intent.getStringExtra("title").orEmpty().ifBlank { "BiliMusic" }
        if (!FloatingLyricsOverlay.hasTimeline(id, lyricSession())) FloatingLyricsOverlay.setTimeline(JSONObject())
        queue.observe(id)
        nativeTrack = queue.find(id) ?: nativeTrack?.takeIf { it.optString("id") == id }
        artist = intent.getStringExtra("artist") ?: ""; volume = intent.getDoubleExtra("volume", 1.0).coerceIn(0.0,1.0).toFloat()
        album = intent.getStringExtra("album").orEmpty()
        metadataDuration = intent.getDoubleExtra("durationSeconds", 0.0)
        if(intent.hasExtra("loudnessEnabled")) outputGain.configure(intent.getBooleanExtra("loudnessEnabled",false),intent.getLongExtra("loudnessRevision",0))
        outputGain.plan(intent.getDoubleExtra("loudnessGainDb",0.0))
        prepareArtwork(intent.getStringExtra("coverUrl"))
        requestedStartPosition = intent.getDoubleExtra("position", 0.0)
        lastPosition = 0.0; lastDuration = 0.0
        pendingUpgradeUrl = intent.getStringExtra("upgradeUrl")
        upgradeAfterPosition = intent.getDoubleExtra("position", 0.0) + 0.75
        status = if (intent.getBooleanExtra("playing", true)) "buffering" else "paused"
        error = null
        updateMetadata(); updateSessionPlaybackState()
        startForeground(NOTIFICATION, notification())
        if (status != "paused" && !requestFocus()) {
            fail("无法获得音频焦点，请稍后重试", "audio_focus_denied"); return
        }
        try {
            resetPlaybackWatchdog()
            val media = MediaPlayer(); player = media
            media.setAudioAttributes(playbackAttributes)
            media.setWakeMode(this, PowerManager.PARTIAL_WAKE_LOCK)
            applyOutput()
            val resumePolicy = if (intent.getBooleanExtra("automaticResume", false)) AutomaticResumePolicy().apply {
                enabled = intent.getBooleanExtra("resumeEnabled", true)
                thresholdSeconds = intent.getDoubleExtra("resumeThreshold", 0.0)
                collection = intent.getBooleanExtra("resumeCollection", false)
                durationSeconds = intent.getDoubleExtra("resumeDuration", 0.0)
            } else null
            initialResumePolicy = resumePolicy
            bindMedia(media,intent.getDoubleExtra("position",0.0),resumePolicy)
            media.setDataSource(intent.getStringExtra("url")); media.prepareAsync(); publish(); handler.removeCallbacks(ticker); handler.post(ticker)
            refreshPlaybackLyrics()
        } catch (_: Exception) { fail("音频加载失败，请重新播放", "audio_prepare_failed") }
    }
    private fun bindMedia(media:MediaPlayer,initialPosition:Double,resumePolicy:AutomaticResumePolicy? = null) {
            media.setOnPreparedListener {
                if (player !== it) return@setOnPreparedListener
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
                } else if (status != "paused") {
                    startAtRate(it)
                    status = "playing"
                }
                if (status == "paused") stopForeground(STOP_FOREGROUND_DETACH)
                publish(); handler.removeCallbacks(ticker); handler.post(ticker)
            }
            media.setOnSeekCompleteListener {
                if (player !== it) return@setOnSeekCompleteListener
                seeking = false
                listeningPosition = null
                if (status == "buffering" && !it.isPlaying) { startAtRate(it); status = "playing" }
                savePosition(force = true)
                if (mediaTitle() != displayedTitle) { updateMetadata();publish() } else publish(false)
            }
            media.setOnCompletionListener {
                if (player !== it) return@setOnCompletionListener
                didFinishTrack = true; savePosition(force = true)
                accountListening(true)
                if (!expireSleepIfNeeded()) advance(1, ended = true)
                handler.postDelayed({ if (player === it && status == "paused") stopForeground(STOP_FOREGROUND_DETACH) }, 5000)
            }
            media.setOnErrorListener { candidate, what, extra ->
                if (player === candidate) {
                    android.util.Log.w("BiliMusicPlayback", "media error what=$what extra=$extra status=$status")
                    val code = "android_media:$what:$extra"
                    val connectionFailed = what == MediaPlayer.MEDIA_ERROR_IO || extra == MediaPlayer.MEDIA_ERROR_IO ||
                        what == MediaPlayer.MEDIA_ERROR_TIMED_OUT || extra == MediaPlayer.MEDIA_ERROR_TIMED_OUT
                    val incompatible = what == MediaPlayer.MEDIA_ERROR_MALFORMED || extra == MediaPlayer.MEDIA_ERROR_MALFORMED ||
                        what == MediaPlayer.MEDIA_ERROR_UNSUPPORTED || extra == MediaPlayer.MEDIA_ERROR_UNSUPPORTED ||
                        (what == MediaPlayer.MEDIA_ERROR_UNKNOWN && !prepared)
                    when {
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
                    if (what == MediaPlayer.MEDIA_INFO_BUFFERING_START) { accountListening(); status = "buffering"; publish() }
                    if (what == MediaPlayer.MEDIA_INFO_BUFFERING_END) { status = "playing"; publish() }
                }; false
            }
    }
    private fun cancelSourceSwitch(message:String?="音质切换已取消") {
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
        val candidate=MediaPlayer();sourceCandidate=candidate;sourceReply=reply
        sourceTimeout=Runnable{if(sourceCandidate===candidate)cancelSourceSwitch("新音源准备超时，已保留原音质")}.also{handler.postDelayed(it,12000)}
        fun valid()=sourceCandidate===candidate && player===original && id==expectedId && playbackRevision==revision
        fun commit(seek:Long) {
            if(!valid() || seek!=seekRevision){cancelSourceSwitch();return}
            accountListening(true)
            val shouldPlay=status!="paused"
            original.pause();player=candidate;sourceCandidate=null
            sourceTimeout?.let{handler.removeCallbacks(it)};sourceTimeout=null
            prepared=true;seeking=false;playbackRevision+=1;listeningPosition=null
            lastPosition=candidate.currentPosition/1000.0;lastDuration=candidate.duration/1000.0
            bindMedia(candidate,0.0);gainDb?.let { outputGain.plan(it) };applyOutput();resetPlaybackWatchdog()
            original.release()
            if(shouldPlay){startAtRate(candidate);status="playing"}else{status="paused"}
            publish();val completion=sourceReply;sourceReply=null;completion?.invoke(null)
        }
        try {
            candidate.setAudioAttributes(playbackAttributes)
            candidate.setWakeMode(this,PowerManager.PARTIAL_WAKE_LOCK);candidate.setVolume(0f,0f)
            candidate.setOnErrorListener{_,_,_->if(sourceCandidate===candidate)cancelSourceSwitch("新音源无法播放，已保留原音质");true}
            candidate.setOnPreparedListener{
                if(!valid()){if(sourceCandidate===candidate)cancelSourceSwitch();return@setOnPreparedListener}
                val seek=seekRevision;val position=if(seeking)lastPosition else original.currentPosition/1000.0
                candidate.setOnSeekCompleteListener{if(valid())commit(seek)}
                if(position>0)candidate.seekTo((position*1000).toLong(),MediaPlayer.SEEK_CLOSEST)else commit(seek)
            }
            candidate.setDataSource(url);candidate.prepareAsync()
        }catch(_:Exception){cancelSourceSwitch("新音源无法加载，已保留原音质")}
    }
    private fun fail(message: String, code: String) {
        android.util.Log.w("BiliMusicPlayback", "failed: $code")
        cancelResolution()
        pendingUpgradeUrl = null; cancelSourceSwitch()
        focusResume.cancel()
        accountListening(true)
        status = "error"; error = message; errorCode = code; prepared = false
        player?.release(); player = null; handler.removeCallbacks(ticker)
        audioManager.abandonAudioFocusRequest(focus); focusDucked = false; publish(); stopForeground(STOP_FOREGROUND_DETACH)
    }
    private fun pause() {
        cancelResolution()
        savePosition(force = true)
        accountListening(true)
        if (prepared && player?.isPlaying == true) player?.pause()
        status = "paused"; handler.removeCallbacks(ticker); publish(); stopForeground(STOP_FOREGROUND_DETACH)
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
    private fun requestFocus(): Boolean {
        if (audioManager.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) return false
        if (focusDucked) {
            focusDucked = false
            applyOutput()
        }
        return true
    }
    private fun emitAction(action: String) { listener?.invoke(snapshot().put("action",action)) }
    fun control(action: String, value: Double = 0.0) {
        when (action) {
            "next", "previous", "toggle", "resume", "pause", "stop" -> mediaButtons.cancel()
        }
        if(action == "toggle") { control(if(status == "playing" || status == "buffering") "pause" else "resume");return }
        if (action == "resume") { focusResume.cancel(); resetPlaybackWatchdog() }
        when (action) {
            "next" -> advance(1)
            "previous" -> advance(-1)
            "sleepStart" -> if (value in 60.0..10800.0) scheduleSleep(value)
            "sleepCancel" -> { clearSleep(); publish() }
            "sleepDismiss" -> { sleepExpired = false; publish() }
            "sleepRepeat" -> if (sleepExpired && sleepDuration > 0) { scheduleSleep(sleepDuration); control("resume") }
            "pause" -> { focusResume.cancel(); pause(); audioManager.abandonAudioFocusRequest(focus) }
            "resume" -> if (expireSleepIfNeeded()) Unit else if (player == null) {
                nativeTrack?.let { recoveryAttempted = false; resolveTrack(it, refresh = true, position = lastPosition) } ?: emitAction("resume")
            } else {
                startForeground(NOTIFICATION, notification())
                if (requestFocus()) {
                    if (prepared && !seeking) player?.let(::startAtRate)
                    status = if (!prepared || seeking) "buffering" else "playing"
                    handler.removeCallbacks(ticker); handler.post(ticker); publish()
                } else { pause() }
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
            "stop" -> { cancelResolution(); pendingUpgradeUrl = null;focusResume.cancel();cancelSourceSwitch();clearSleep(); savePosition(force = true); accountListening(true); snapshot(); player?.release(); player = null; prepared = false; status = "paused"; publish(); stopSelf() }
        }
    }
    fun snapshot(): JSObject {
        stateSequence += 1
        expireSleepIfNeeded()
        if (prepared) {
            if (!seeking) lastPosition = runCatching { (player?.currentPosition ?: 0) / 1000.0 }.getOrDefault(lastPosition)
            lastDuration = runCatching { (player?.duration ?: 0) / 1000.0 }.getOrDefault(lastDuration)
        }
        val snapshot = JSObject().put("capabilities",org.json.JSONObject().put("autonomousQueue",queue.tracks.isNotEmpty()).put("seamlessSourceSwitch",true).put("nativeSleepTimer",true).put("snapshotRebind",true)).put("engineInstanceId",engineInstanceId).put("sessionId",listeningSession).put("sourceRevision",playbackRevision).put("autonomousQueue",queue.tracks.isNotEmpty()).put("queueVersion",queue.version).put("revision",playbackRevision).put("sequence",stateSequence).put("seekRevision",seekRevision).put("id", id).put("status", status).put("position", lastPosition)
            .put("track", nativeTrack).put("expandedEntries", queue.expanded).put("recoveryAttempted", recoveryAttempted)
            .put("duration", lastDuration).put("rate", playbackRate).put("stopped", player == null).put("error", error).put("floatingLyricsEnabled",FloatingLyricsOverlay.enabled)
            .put("sleepDeadline", sleepDeadline).put("sleepDuration", sleepDuration).put("sleepExpired", sleepExpired)
        if (error != null) snapshot.put("errorCode", errorCode)
        if (lastFloatingStyle != FloatingLyricsOverlay.styleRevision.toLong()) {
            lastFloatingStyle = FloatingLyricsOverlay.styleRevision.toLong()
            snapshot.put("floatingLyricsStyleRevision",lastFloatingStyle).put("floatingLyricsFontSize",FloatingLyricsOverlay.fontSize).put("floatingLyricsLocked",FloatingLyricsOverlay.locked)
        }
        return snapshot
    }
    fun lyricPosition(): Pair<String,Double> = Pair(id,if(prepared && !seeking) runCatching { (player?.currentPosition ?: 0)/1000.0 }.getOrDefault(lastPosition) else lastPosition)
    fun lyricTitle(): String = title
    fun notifyLyricsChanged() { updateMetadata();publish() }
    internal fun refreshPlaybackNotification() {
        if (id.isNotEmpty() && (player != null || status == "buffering")) updateSystemPlayback()
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
        getSystemService(NotificationManager::class.java)?.notify(NOTIFICATION, notification())
    }
    private fun updateSessionPlaybackState() {
        sessionPlayer.update(systemQueue, displayedTitle, artwork?.encoded, status, (lastPosition * 1000).toLong(),
            playbackRate, hasOtherTracks(), error)
        if (session == null && id.isNotEmpty()) createSession()
    }
    private var displayedTitle = title
    private fun mediaTitle() = SystemTitleLyrics.title(id, lyricPosition().second, title)
    private fun updateMetadata() {
        val current = id.takeIf(String::isNotEmpty)?.let {
            val queued = nativeTrack?.takeIf { track -> track.optString("id") == id }
            SystemTrack(id, title, artist, album.ifBlank { queued?.mediaText("album").orEmpty() },
                ((lastDuration.takeIf { it > 0 } ?: metadataDuration.takeIf { it > 0 } ?: queued?.optDouble("durationSeconds", 0.0) ?: 0.0) * 1000).toLong())
        }
        systemQueue.update(queue.tracks, current)
        displayedTitle = mediaTitle()
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
    private fun notification(): Notification {
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE) }
        val canSkip = hasOtherTracks()
        val isPlaying = status == "playing" || status == "buffering"
        val builder=Notification.Builder(this, CHANNEL).setContentTitle(displayedTitle).setContentText(artist).setLargeIcon(artwork?.bitmap)
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
        audioManager.abandonAudioFocusRequest(focus)
        session?.let { removeSession(it); it.release() }
        session = null; controller = null; unregisterReceiver(unplugged)
        instance = null; stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy()
    }
}
