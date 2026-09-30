package expo.modules.sheetservice

import android.content.Intent
import androidx.core.content.ContextCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class SheetServiceModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SheetService")
    Events("onAction")

    OnCreate {
      SheetForegroundService.onAction = { a -> sendEvent("onAction", mapOf("action" to a)) }
    }
    OnDestroy { SheetForegroundService.onAction = null }

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
  }
}
