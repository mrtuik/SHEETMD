package expo.modules.sheetaccess

import android.content.ActivityNotFoundException
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import androidx.core.app.NotificationManagerCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// JS bridge of the AccessibilityService. Every function returns a String: "ERR: ..." = failed, anything else = the result. Nothing throws into JS.
class SheetAccessModule : Module() {
  private val ctx: Context? get() = appContext.reactContext?.applicationContext
  private val off = "ERR: Accessibility is off. Turn on \"Sheet.md assistant\" in Android Settings > Accessibility."

  // Android keeps the list of enabled services in Settings.Secure
  private fun enabled(): Boolean {
    val c = ctx ?: return false
    val v = Settings.Secure.getString(c.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
    return v.split(':').any {
      val cn = ComponentName.unflattenFromString(it)
      cn != null && cn.packageName == c.packageName && cn.className == SheetAccessibilityService::class.java.name
    }
  }

  private fun go(i: Intent): String {
    val c = ctx ?: return "ERR: app not ready"
    return try { c.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); "OK" }
    catch (e: ActivityNotFoundException) { "ERR: this phone has no such settings screen" }
    catch (e: Exception) { "ERR: " + (e.message ?: "failed") }
  }

  private fun <T> svc(f: (SheetAccessibilityService) -> T, none: T): T {
    val s = SheetAccessibilityService.inst ?: return none
    return try { f(s) } catch (e: Exception) { none }
  }

  private val notifOff = "ERR: Notification access is off. Turn on \"Sheet.md assistant\" in Android Settings > Notification access."
  private fun notifEnabled(): Boolean { val c = ctx ?: return false; return NotificationManagerCompat.getEnabledListenerPackages(c).contains(c.packageName) }
  private fun <T> nsvc(f: (SheetNotificationListener) -> T, none: T): T {
    val s = SheetNotificationListener.inst ?: return none
    return try { f(s) } catch (e: Exception) { none }
  }

  override fun definition() = ModuleDefinition {
    Name("SheetAccess")
    Events("onNotification")
    OnCreate { SheetNotificationListener.onPosted = { json -> sendEvent("onNotification", mapOf("json" to json)) } }
    OnDestroy { SheetNotificationListener.onPosted = null }

    // ---- notifications ----
    Function("notifEnabled") { notifEnabled() }
    Function("notifOpenSettings") { go(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS)) }
    AsyncFunction("notifList") { max: Int -> nsvc({ it.list(max.coerceIn(1, 20)) }, notifOff) }
    AsyncFunction("notifReply") { key: String, text: String -> nsvc({ it.reply(key, text) }, notifOff) }
    AsyncFunction("notifDismiss") { key: String -> nsvc({ it.dismiss(key) }, notifOff) }

    Function("isEnabled") { enabled() }
    Function("isConnected") { SheetAccessibilityService.inst != null }
    Function("openSettings") { go(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)) }
    // Android 13+, sideloaded APK: "Allow restricted settings" lives in App info > the three dots
    Function("openAppInfo") { val c = ctx; if (c == null) "ERR: app not ready" else go(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + c.packageName))) }

    // these wait for gestures / screenshots, so they are async (Expo runs them off the main thread)
    AsyncFunction("readScreen") { svc({ it.readScreen() }, off) }
    AsyncFunction("tapIndex") { i: Int, long: Boolean -> svc({ it.tapIndex(i, long) }, off) }
    AsyncFunction("tapText") { text: String, long: Boolean -> svc({ it.tapText(text, long) }, off) }
    AsyncFunction("tapXY") { x: Double, y: Double, long: Boolean -> svc({ it.tapXY(x.toFloat(), y.toFloat(), long) }, off) }
    AsyncFunction("typeText") { text: String -> svc({ it.typeText(text) }, off) }
    AsyncFunction("scroll") { dir: String -> svc({ it.scroll(dir) }, off) }
    AsyncFunction("swipe") { x1: Double, y1: Double, x2: Double, y2: Double, ms: Int -> svc({ it.swipe(x1.toFloat(), y1.toFloat(), x2.toFloat(), y2.toFloat(), ms.toLong()) }, off) }
    AsyncFunction("global") { a: String -> svc({ it.global(a) }, off) }
    AsyncFunction("screenshot") { svc({ it.screenshot() }, off) }
  }
}
