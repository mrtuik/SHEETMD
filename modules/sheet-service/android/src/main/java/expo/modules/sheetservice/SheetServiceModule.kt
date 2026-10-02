package expo.modules.sheetservice

import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.net.Uri
import android.os.PowerManager
import android.provider.Settings
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class SheetServiceModule : Module() {
  // The recognizer's "tung tung" beep plays on these streams on most phones.
  // setStreamMute is tied to this process: Android un-mutes automatically if the app dies.
  private var muted = false

  private fun setBeepMuted(on: Boolean) {
    if (on == muted) return                       // mute calls are counted, keep them balanced
    val ctx = appContext.reactContext?.applicationContext ?: return
    val am = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
    for (s in intArrayOf(AudioManager.STREAM_NOTIFICATION, AudioManager.STREAM_SYSTEM)) {
      try {
        @Suppress("DEPRECATION")
        am.setStreamMute(s, on)
      } catch (e: Exception) { }
    }
    muted = on
  }

  override fun definition() = ModuleDefinition {
    Name("SheetService")
    Events("onAction")

    OnCreate {
      SheetForegroundService.onAction = { a -> sendEvent("onAction", mapOf("action" to a)) }
    }
    OnDestroy {
      SheetForegroundService.onAction = null
      setBeepMuted(false)
    }

    // Start, or update the notification of, the foreground service
    Function("update") { title: String, text: String, playing: Boolean, mic: Boolean ->
      val ctx = appContext.reactContext?.applicationContext
      if (ctx != null) {
        val i = Intent(ctx, SheetForegroundService::class.java)
          .putExtra("title", title).putExtra("text", text)
          .putExtra("playing", playing).putExtra("mic", mic)
        try {
          if (SheetForegroundService.running) ctx.startService(i)
          else ContextCompat.startForegroundService(ctx, i)
        } catch (e: Exception) { }
      }
    }

    Function("stop") {
      val ctx = appContext.reactContext?.applicationContext
      if (ctx != null) ctx.stopService(Intent(ctx, SheetForegroundService::class.java))
    }

    Function("muteBeep") { on: Boolean -> setBeepMuted(on) }

    // true = the phone does not put this app to sleep in the background
    Function("batteryUnrestricted") {
      val ctx = appContext.reactContext?.applicationContext
      val pm = ctx?.getSystemService(Context.POWER_SERVICE) as? PowerManager
      if (ctx == null || pm == null) true else pm.isIgnoringBatteryOptimizations(ctx.packageName)
    }
    Function("requestBatteryUnrestricted") {
      val ctx = appContext.reactContext?.applicationContext
      if (ctx != null) {
        try {
          ctx.startActivity(
            Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
              .setData(Uri.parse("package:" + ctx.packageName))
              .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (e: Exception) {
          try { ctx.startActivity(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) }
          catch (e2: Exception) { }
        }
      }
    }
  }
}
