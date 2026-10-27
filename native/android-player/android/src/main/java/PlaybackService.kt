package app.bilimusic.player

import android.app.*
import android.content.*
import android.graphics.Color
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
    private var lastPosition = 0.0
    private var lastDuration = 0.0
    private var volume = .7f
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
            "load" -> load(intent)
            "next", "previous" -> listener?.invoke(JSObject().put("action", intent.action))
            "toggle" -> control(if (status == "playing" || status == "buffering") "pause" else "resume")
            "stop" -> control("stop")
        }
        // Never restart silently after Android kills the process: saved URLs are temporary.
        return START_NOT_STICKY
    }
    private fun load(intent: Intent) {
        handler.removeCallbacks(ticker); player?.release(); player = null; prepared = false
        id = intent.getStringExtra("id") ?: ""; title = intent.getStringExtra("title") ?: "BiliMusic"
        artist = intent.getStringExtra("artist") ?: ""; volume = intent.getDoubleExtra("volume", .7).toFloat()
        lastPosition = intent.getDoubleExtra("position", 0.0); lastDuration = 0.0
        status = "buffering"; error = null
        session.setMetadata(MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, artist).build())
        startForeground(NOTIFICATION, notification())
        if (audioManager.requestAudioFocus(focus) != AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
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
                if (offset > 0) it.seekTo(offset, MediaPlayer.SEEK_CLOSEST)
                if (status != "paused") { it.start(); status = "playing" }
                session.setMetadata(MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, title)
                    .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                    .putLong(MediaMetadata.METADATA_KEY_DURATION, it.duration.toLong()).build())
                publish(); handler.post(ticker)
            }
            media.setOnSeekCompleteListener { publish(false) }
            media.setOnCompletionListener { status = "paused"; publish(); listener?.invoke(JSObject().put("action", "ended")); handler.postDelayed({ if (status == "paused") stopForeground(STOP_FOREGROUND_DETACH) }, 5000) }
            media.setOnErrorListener { _, _, _ -> fail("音频播放失败，请重新播放"); true }
            media.setOnInfoListener { _, what, _ ->
                if (status != "paused") {
                    if (what == MediaPlayer.MEDIA_INFO_BUFFERING_START) { status = "buffering"; publish() }
                    if (what == MediaPlayer.MEDIA_INFO_BUFFERING_END) { status = "playing"; publish() }
                }; false
            }
            media.setDataSource(intent.getStringExtra("url")); media.prepareAsync(); publish()
        } catch (cause: Exception) { fail("音频加载失败，请重新播放") }
    }
    private fun fail(message: String) {
        status = "error"; error = message; prepared = false
        player?.release(); player = null; handler.removeCallbacks(ticker)
        audioManager.abandonAudioFocusRequest(focus); publish(); stopForeground(STOP_FOREGROUND_DETACH)
    }
    private fun pause() {
        if (prepared) player?.pause()
        status = "paused"; handler.removeCallbacks(ticker); publish(); stopForeground(STOP_FOREGROUND_DETACH)
    }
    fun control(action: String, value: Double = 0.0) {
        when (action) {
            "pause" -> { resumeOnFocus = false; pause(); audioManager.abandonAudioFocusRequest(focus) }
            "resume" -> if (!prepared && player != null) { status = "buffering"; publish() } else if (prepared) {
                startForeground(NOTIFICATION, notification())
                if (audioManager.requestAudioFocus(focus) == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                    player?.start(); status = "playing"; handler.removeCallbacks(ticker); handler.post(ticker); publish()
                } else { pause() }
            }
            "seek" -> if (prepared) { player?.seekTo((value.coerceAtLeast(0.0) * 1000).toLong(), MediaPlayer.SEEK_CLOSEST); publish() }
            "volume" -> { volume = value.coerceIn(0.0, 1.0).toFloat(); player?.setVolume(volume, volume) }
            "stop" -> { snapshot(); player?.release(); player = null; prepared = false; status = "paused"; publish(); stopSelf() }
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
        val state = if (status == "playing") PlaybackState.STATE_PLAYING else if (status == "buffering") PlaybackState.STATE_BUFFERING else if (status == "error") PlaybackState.STATE_ERROR else PlaybackState.STATE_PAUSED
        session.setPlaybackState(PlaybackState.Builder().setActions(PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SEEK_TO or PlaybackState.ACTION_SKIP_TO_NEXT or PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_STOP)
            .setState(state, if (prepared) (player?.currentPosition ?: 0).toLong() else 0, if (status == "playing") 1f else 0f).build())
        listener?.invoke(snapshot())
        if (notify) getSystemService(NotificationManager::class.java).notify(NOTIFICATION, notification())
    }
    private fun pending(action: String, code: Int): PendingIntent = PendingIntent.getService(this, code,
        Intent(this, PlaybackService::class.java).setAction(action), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    private fun notification(): Notification {
        val open = packageManager.getLaunchIntentForPackage(packageName)?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE) }
        return Notification.Builder(this, CHANNEL).setContentTitle(title).setContentText(artist)
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
        handler.removeCallbacks(ticker); player?.release(); player = null
        audioManager.abandonAudioFocusRequest(focus); session.release(); unregisterReceiver(unplugged)
        instance = null; stopForeground(STOP_FOREGROUND_REMOVE); super.onDestroy()
    }
}
