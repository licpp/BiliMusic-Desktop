package app.bilimusic.player

import android.app.*
import android.content.*
import android.graphics.Color
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.*
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.*
import app.tauri.plugin.JSObject

/** Audio lives outside the WebView so backgrounding and screen lock do not stop it. */
class PlaybackService : Service() {
    companion object {
        var instance: PlaybackService? = null
        var listener: ((JSObject) -> Unit)? = null
        @Volatile var listeningListener: ((JSObject) -> Unit)? = null
        @Volatile var profilePath: String? = null
        private const val CHANNEL = "bilimusic-playback"
        private const val NOTIFICATION = 1001
    }
    private var player: MediaPlayer? = null
    private lateinit var session: MediaSession
    private lateinit var audioManager: AudioManager
    private lateinit var focus: AudioFocusRequest
    private val handler = Handler(Looper.getMainLooper())
    private var id = ""
    private var title = "BiliMusic"
    private var artist = ""
    private var status = "paused"
    private var error: String? = null
    private var resumeOnFocus = false
    private var prepared = false
    private var seeking = false
    private var listeningProfile: String? = null
    private var listeningPosition: Double? = null
    private var listeningAt = 0L
    private var listeningSeconds = 0.0

    private fun accountListening(flush: Boolean = false) {
        val now = SystemClock.elapsedRealtime()
        val media = player
        val position = if (prepared && !seeking && status == "playing" && media != null)
            runCatching { media.currentPosition / 1000.0 }.getOrNull() else null
        val previous = listeningPosition
        if (position != null && previous != null) {
            listeningSeconds += (position - previous).coerceIn(0.0, (now - listeningAt) / 1000.0)
        }
        listeningPosition = position
        listeningAt = now
        val profile = listeningProfile
        if ((flush || listeningSeconds >= 15.0) && profile != null && id.isNotEmpty() && listeningSeconds > 0.0) {
            val seconds = listeningSeconds
            listeningSeconds = 0.0
            listeningListener?.invoke(JSObject().put("scope", profile).put("trackId", id).put("seconds", seconds))
        }
    }
    private var lastPosition = 0.0
    private var lastDuration = 0.0
    private var volume = .7f
    private var artwork: Bitmap? = null
    private var artworkUrl: String? = null
    private val artworkCache = android.util.LruCache<String, Bitmap>(8)
    private val artworkExecutor = java.util.concurrent.Executors.newSingleThreadExecutor()
    private var artworkTask: java.util.concurrent.Future<*>? = null
    private var systemUpdateScheduled = false
    private var lastSystemPosition = -10.0
    private var lastSystemStatus = ""
    private val ticker = object : Runnable {
        override fun run() {
            publish(false)
            if (status == "playing" || status == "buffering") handler.postDelayed(this, 500)
        }
    }
    private val unplugged = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent?) { control("pause") }
    }
    override fun onBind(intent: Intent?): IBinder? = null
    override fun onCreate() {
        super.onCreate(); instance = this
        audioManager = getSystemService(AudioManager::class.java)
        val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build()
        focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN).setAudioAttributes(attributes)
            .setOnAudioFocusChangeListener { change ->
                when (change) {
                    AudioManager.AUDIOFOCUS_LOSS -> { resumeOnFocus = false; control("pause") }
                    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT -> { resumeOnFocus = status == "playing"; pause() }
                    AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK -> player?.setVolume(volume * .2f, volume * .2f)
                    AudioManager.AUDIOFOCUS_GAIN -> {
                        player?.setVolume(volume, volume)
                        if (resumeOnFocus) { resumeOnFocus = false; control("resume") }
                    }
                }
            }.build()
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "音乐播放", NotificationManager.IMPORTANCE_LOW).apply {
                setSound(null, null); enableVibration(false); lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            })
        session = MediaSession(this, "BiliMusic")
        session.setCallback(object : MediaSession.Callback() {
            override fun onPlay() { control("resume") }
            override fun onPause() { control("pause") }
            override fun onStop() { control("stop") }
            override fun onSeekTo(pos: Long) { control("seek", pos / 1000.0) }
            override fun onSkipToNext() { listener?.invoke(JSObject().put("action", "next")) }
            override fun onSkipToPrevious() { listener?.invoke(JSObject().put("action", "previous")) }
        })
        session.isActive = true
        if (Build.VERSION.SDK_INT >= 33) registerReceiver(unplugged, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY), RECEIVER_NOT_EXPORTED)
        else registerReceiver(unplugged, IntentFilter(AudioManager.ACTION_AUDIO_BECOMING_NOISY))
    }
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            "prepare" -> {
                accountListening(true)
                seeking = false
                handler.removeCallbacks(ticker); player?.release(); player = null; prepared = false
                id = intent.getStringExtra("id") ?: ""; title = intent.getStringExtra("title") ?: "BiliMusic"
                artist = intent.getStringExtra("artist") ?: ""; lastPosition = 0.0; lastDuration = 0.0
                prepareArtwork(intent.getStringExtra("coverUrl"))
                updateMetadata()
                status = "buffering"; error = null; startForeground(NOTIFICATION, notification())
            }
            "load" -> load(intent)
            "next", "previous" -> listener?.invoke(JSObject().put("action", intent.action))
            "toggle" -> control(if (status == "playing" || status == "buffering") "pause" else "resume")
            "stop" -> control("stop")
        }
        // Never restart silently after Android kills the process: saved URLs are temporary.
        return START_NOT_STICKY
    }
    private fun load(intent: Intent) {
        accountListening(true)
        seeking = false
        listeningPosition = null
        listeningSeconds = 0.0
        listeningProfile = profilePath?.let { runCatching { java.io.File(it).readText() }.getOrDefault("") }
        handler.removeCallbacks(ticker); player?.release(); player = null; prepared = false
        id = intent.getStringExtra("id") ?: ""; title = intent.getStringExtra("title") ?: "BiliMusic"
        artist = intent.getStringExtra("artist") ?: ""; volume = intent.getDoubleExtra("volume", .7).toFloat()
        prepareArtwork(intent.getStringExtra("coverUrl"))
        lastPosition = intent.getDoubleExtra("position", 0.0); lastDuration = 0.0
        status = if (intent.getBooleanExtra("playing", true)) "buffering" else "paused"
        error = null
        updateMetadata()
        startForeground(NOTIFICATION, notification())
        if (status != "paused" && audioManager.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
            fail("无法获得音频焦点，请稍后重试"); return
        }
        try {
            val media = MediaPlayer(); player = media
            media.setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            media.setWakeMode(this, PowerManager.PARTIAL_WAKE_LOCK)
            media.setVolume(volume, volume)
            media.setOnPreparedListener {
                if (player !== it) return@setOnPreparedListener
                prepared = true
                val offset = (intent.getDoubleExtra("position", 0.0) * 1000).toLong()
                lastDuration = it.duration / 1000.0
                updateMetadata()
                if (offset > 0) {
                    seeking = true
                    it.seekTo(offset, MediaPlayer.SEEK_CLOSEST)
                } else if (status != "paused") {
                    it.start()
                    status = "playing"
                }
                if (status == "paused") stopForeground(STOP_FOREGROUND_DETACH)
                publish(); handler.post(ticker)
            }
            media.setOnSeekCompleteListener {
                if (player !== it) return@setOnSeekCompleteListener
                seeking = false
                listeningPosition = null
                if (status == "buffering" && !it.isPlaying) { it.start(); status = "playing" }
                publish(false)
            }
            media.setOnCompletionListener {
                if (player !== it) return@setOnCompletionListener
                accountListening(true)
                status = "paused"; publish(); listener?.invoke(JSObject().put("action", "ended"))
                handler.postDelayed({ if (player === it && status == "paused") stopForeground(STOP_FOREGROUND_DETACH) }, 5000)
            }
            media.setOnErrorListener { candidate, _, _ -> if (player === candidate) fail("音频播放失败，请重新播放"); true }
            media.setOnInfoListener { candidate, what, _ ->
                if (player === candidate && status != "paused" && !seeking) {
                    if (what == MediaPlayer.MEDIA_INFO_BUFFERING_START) { accountListening(); status = "buffering"; publish() }
                    if (what == MediaPlayer.MEDIA_INFO_BUFFERING_END) { status = "playing"; publish() }
                }; false
            }
            media.setDataSource(intent.getStringExtra("url")); media.prepareAsync(); publish()
        } catch (cause: Exception) { fail("音频加载失败，请重新播放") }
    }
    private fun fail(message: String) {
        accountListening(true)
        status = "error"; error = message; prepared = false
        player?.release(); player = null; handler.removeCallbacks(ticker)
        audioManager.abandonAudioFocusRequest(focus); publish(); stopForeground(STOP_FOREGROUND_DETACH)
    }
    private fun pause() {
        accountListening(true)
        if (prepared && player?.isPlaying == true) player?.pause()
        status = "paused"; handler.removeCallbacks(ticker); publish(); stopForeground(STOP_FOREGROUND_DETACH)
    }
    fun control(action: String, value: Double = 0.0) {
        when (action) {
            "pause" -> { resumeOnFocus = false; pause(); audioManager.abandonAudioFocusRequest(focus) }
            "resume" -> if (player == null) { listener?.invoke(JSObject().put("action", "resume")) } else if (!prepared && player != null) { status = "buffering"; publish() } else if (prepared) {
                startForeground(NOTIFICATION, notification())
                if (audioManager.requestAudioFocus(focus) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                    if (!seeking) player?.start()
                    status = if (seeking) "buffering" else "playing"
                    handler.removeCallbacks(ticker); handler.post(ticker); publish()
                } else { pause() }
            }
            "seek" -> if (prepared) {
                accountListening(true)
                seeking = true
                player?.seekTo((value.coerceAtLeast(0.0) * 1000).toLong(), MediaPlayer.SEEK_CLOSEST)
                publish()
            }
            "volume" -> { volume = value.coerceIn(0.0, 1.0).toFloat(); player?.setVolume(volume, volume) }
            "stop" -> { accountListening(true); snapshot(); player?.release(); player = null; prepared = false; status = "paused"; publish(); stopSelf() }
        }
    }
    fun snapshot(): JSObject {
        if (prepared) {
            lastPosition = (player?.currentPosition ?: 0) / 1000.0
            lastDuration = (player?.duration ?: 0) / 1000.0
        }
        return JSObject().put("id", id).put("status", status).put("position", lastPosition)
            .put("duration", lastDuration).put("stopped", player == null).put("error", error)
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
        val state = if (status == "playing") PlaybackState.STATE_PLAYING else if (status == "buffering") PlaybackState.STATE_BUFFERING else if (status == "error") PlaybackState.STATE_ERROR else PlaybackState.STATE_PAUSED
        session.setPlaybackState(PlaybackState.Builder().setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SEEK_TO or PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_STOP)
            .setState(state, if (prepared) (player?.currentPosition ?: 0).toLong() else 0, if (status == "playing") 1f else 0f).build())
        getSystemService(NotificationManager::class.java).notify(NOTIFICATION, notification())
    }
    private fun updateMetadata() {
        val metadata = MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
        if (lastDuration > 0) metadata.putLong(MediaMetadata.METADATA_KEY_DURATION, (lastDuration * 1000).toLong())
        artwork?.let { metadata.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, it).putBitmap(MediaMetadata.METADATA_KEY_ART, it) }
        session.setMetadata(metadata.build())
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
                    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
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
        return Notification.Builder(this, CHANNEL).setContentTitle(title).setContentText(artist).setLargeIcon(artwork)
            .setSmallIcon(app.bilimusic.player.R.drawable.ic_music_notification).setColor(Color.rgb(255,115,88))
            .setContentIntent(open).setVisibility(Notification.VISIBILITY_PUBLIC).setOnlyAlertOnce(true)
            .setOngoing(status == "playing" || status == "buffering")
            .addAction(Notification.Action.Builder(android.R.drawable.ic_media_previous, "上一首", pending("previous", 1)).build())
            .addAction(Notification.Action.Builder(if (status == "playing" || status == "buffering") android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play, "播放 / 暂停", pending("toggle", 2)).build())
            .addAction(Notification.Action.Builder(android.R.drawable.ic_media_next, "下一首", pending("next", 3)).build())
            .setDeleteIntent(pending("stop", 4))
            .setStyle(Notification.MediaStyle().setMediaSession(session.sessionToken).setShowActionsInCompactView(0,1,2)).build()
    }
    override fun onDestroy() {
        accountListening(true)
        artworkTask?.cancel(true); artworkExecutor.shutdownNow(); artworkCache.evictAll()
        handler.removeCallbacks(ticker); player?.release(); player = null
        audioManager.abandonAudioFocusRequest(focus); session.release(); unregisterReceiver(unplugged)
        instance = null; stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy()
    }
}
