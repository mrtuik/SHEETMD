package expo.modules.sheetservice

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

class SheetForegroundService : Service() {
  companion object {
    const val CH = "sheetmd_reading"
    const val NID = 4711
    const val ACT_TOGGLE = "expo.modules.sheetservice.TOGGLE"
    const val ACT_STOP = "expo.modules.sheetservice.STOP"
    @Volatile var onAction: ((String) -> Unit)? = null
    @Volatile var running = false
  }

  private var wake: PowerManager.WakeLock? = null
  private var am: AudioManager? = null
  private var focusReq: AudioFocusRequest? = null
  private var pausedByCall = false

  private val receiver = object : BroadcastReceiver() {
    override fun onReceive(c: Context?, i: Intent?) {
      when (i?.action) {
        ACT_TOGGLE -> onAction?.invoke("toggle")
        ACT_STOP -> onAction?.invoke("stop")
      }
    }
  }

  // Pause for phone / VoIP calls only (the speech recognizer also grabs focus briefly; ignore that)
  private val focusListener = AudioManager.OnAudioFocusChangeListener { change ->
    val m = am?.mode
    val inCall = m == AudioManager.MODE_IN_CALL || m == AudioManager.MODE_RINGTONE || m == AudioManager.MODE_IN_COMMUNICATION
    if (change < 0 && inCall) { pausedByCall = true; onAction?.invoke("pause") }
    else if (change == AudioManager.AUDIOFOCUS_GAIN && pausedByCall) { pausedByCall = false; onAction?.invoke("resume") }
  }

  override fun onCreate() {
    super.onCreate()
    if (Build.VERSION.SDK_INT >= 26) {
      val ch = NotificationChannel(CH, "Sheet.md reading", NotificationManager.IMPORTANCE_LOW)
      ch.setSound(null, null)
      (getSystemService(NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(ch)
    }
    ContextCompat.registerReceiver(
      this, receiver,
      IntentFilter().apply { addAction(ACT_TOGGLE); addAction(ACT_STOP) },
      ContextCompat.RECEIVER_NOT_EXPORTED
    )
    wake = (getSystemService(POWER_SERVICE) as PowerManager)
      .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sheetmd:reading")
      .also { it.acquire(6 * 60 * 60 * 1000L) }
    am = getSystemService(AUDIO_SERVICE) as AudioManager
    if (Build.VERSION.SDK_INT >= 26) {
      val attrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_MEDIA)
        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
      focusReq = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
        .setAudioAttributes(attrs).setOnAudioFocusChangeListener(focusListener).build()
      am?.requestAudioFocus(focusReq!!)
    }
  }

  // Custom notification icons (assets/icons/ic_tuik_notif_*.png copied to res/drawable by the build); falls back to system icons
  private fun ic(name: String, fallback: Int): Int {
    val id = resources.getIdentifier(name, "drawable", packageName)
    return if (id != 0) id else fallback
  }

  private fun pi(action: String, code: Int): PendingIntent =
    PendingIntent.getBroadcast(this, code, Intent(action).setPackage(packageName),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

  private fun build(title: String, text: String, playing: Boolean): Notification {
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE)
    }
    return NotificationCompat.Builder(this, CH)
      .setSmallIcon(ic("ic_tuik_notif_small", android.R.drawable.ic_media_play))
      .setContentTitle(title).setContentText(text)
      .setOngoing(true).setSilent(true).setOnlyAlertOnce(true)
      .setContentIntent(open)
      .addAction(
        if (playing) ic("ic_tuik_notif_pause", android.R.drawable.ic_media_pause) else ic("ic_tuik_notif_play", android.R.drawable.ic_media_play),
        if (playing) "Pause" else "Play", pi(ACT_TOGGLE, 1))
      .addAction(ic("ic_tuik_notif_stop", android.R.drawable.ic_menu_close_clear_cancel), "Stop", pi(ACT_STOP, 2))
      .build()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val n = build(
      intent?.getStringExtra("title") ?: "Sheet.md",
      intent?.getStringExtra("text") ?: "",
      intent?.getBooleanExtra("playing", false) ?: false
    )
    var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK
    if ((intent?.getBooleanExtra("mic", false) ?: false) && Build.VERSION.SDK_INT >= 30) {
      type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
    }
    try {
      ServiceCompat.startForeground(this, NID, n, type)
    } catch (e: Exception) {
      try { ServiceCompat.startForeground(this, NID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK) }
      catch (e2: Exception) { stopSelf() }
    }
    running = true
    return START_NOT_STICKY
  }

  override fun onTaskRemoved(rootIntent: Intent?) { stopSelf() }

  override fun onDestroy() {
    running = false
    try { unregisterReceiver(receiver) } catch (e: Exception) {}
    try { wake?.release() } catch (e: Exception) {}
    if (Build.VERSION.SDK_INT >= 26) focusReq?.let { am?.abandonAudioFocusRequest(it) }
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}
