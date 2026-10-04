package expo.modules.sheetdevice

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.location.Geocoder
import android.location.LocationManager
import android.media.AudioManager
import android.net.Uri
import android.os.BatteryManager
import android.provider.AlarmClock
import android.provider.CalendarContract
import android.provider.ContactsContract
import android.provider.Settings
import android.telephony.SmsManager
import android.view.KeyEvent
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.Locale

// Phone actions for the assistant. Every function returns a String: "ERR: ..." = failed, anything else = the result text.
// Nothing here throws into JS (a thrown native error would crash the agent loop).
class SheetDeviceModule : Module() {
  private val ctx: Context? get() = appContext.reactContext?.applicationContext

  private fun prefs() = ctx?.getSharedPreferences("sheet_device", Context.MODE_PRIVATE)

  // launches an activity from the background too: the app holds SYSTEM_ALERT_WINDOW while Assistant mode is on, which Android allows to do that
  private fun go(i: Intent): String {
    val c = ctx ?: return "ERR: app not ready"
    return try { c.startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); "OK" }
    catch (e: ActivityNotFoundException) { "ERR: no app on this phone can do that" }
    catch (e: Exception) { "ERR: " + (e.message ?: "failed") }
  }

  private fun norm(s: String) = s.lowercase(Locale.ROOT).filter { it.isLetterOrDigit() }

  private fun lev(a: String, b: String): Int {
    val d = IntArray(b.length + 1) { it }
    for (i in 1..a.length) {
      var prev = d[0]; d[0] = i
      for (j in 1..b.length) {
        val t = d[j]
        d[j] = minOf(d[j] + 1, d[j - 1] + 1, prev + if (a[i - 1] == b[j - 1]) 0 else 1)
        prev = t
      }
    }
    return d[b.length]
  }

  // 100 exact, 80 starts with, 60 contains, 55 the spoken words contain the app name, 50 a close spelling (the recogniser often mishears app names)
  private fun score(label: String, q: String): Int {
    val l = norm(label)
    if (l.isEmpty() || q.isEmpty()) return 0
    return when {
      l == q -> 100
      l.startsWith(q) -> 80
      l.contains(q) -> 60
      l.length >= 3 && q.contains(l) -> 55
      q.length >= 4 && lev(l, q) <= (if (q.length >= 7) 2 else 1) -> 50
      else -> 0
    }
  }

  private fun openApp(name: String): String {
    val c = ctx ?: return "ERR: app not ready"
    val q = norm(name.replace(Regex("(?i)\\b(open|launch|start|kholo|khulo|chalu koro)\\b"), ""))
    if (q.isEmpty()) return "ERR: which app?"
    val pm = c.packageManager
    val list = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
    var best: String? = null; var bestPkg = ""; var bs = 0
    for (r in list) {
      val label = r.loadLabel(pm).toString()
      val s = score(label, q)
      if (s > bs || (s == bs && s > 0 && best != null && label.length < best.length)) { bs = s; best = label; bestPkg = r.activityInfo.packageName }
    }
    if (best == null || bs < 50) return "ERR: I could not find an app called $name"
    val i = pm.getLaunchIntentForPackage(bestPkg) ?: return "ERR: $best cannot be opened"
    val r = go(i)
    return if (r.startsWith("ERR")) r else best
  }

  private fun findContact(q: String): String {
    val c = ctx ?: return ""
    val tries = listOf(q.trim()) + q.trim().split(Regex("\\s+")).filter { it.length >= 3 }
    for (t in tries) {
      try {
        c.contentResolver.query(
          ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
          arrayOf(ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME, ContactsContract.CommonDataKinds.Phone.NUMBER),
          ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " LIKE ?", arrayOf("%$t%"), null
        )?.use { cur ->
          var bn = ""; var bnum = ""
          while (cur.moveToNext()) {
            val n = cur.getString(0) ?: continue
            if (bn.isEmpty() || n.length < bn.length) { bn = n; bnum = cur.getString(1) ?: "" }   // the closest name is the shortest one that contains the words
          }
          if (bn.isNotEmpty() && bnum.isNotEmpty()) return bn + "|" + bnum.replace(Regex("[^\\d+]"), "")
        }
      } catch (e: Exception) { return "" }
    }
    return ""
  }

  private fun sms(to: String, text: String): String {
    val c = ctx ?: return "ERR: app not ready"
    return try {
      val sm = if (android.os.Build.VERSION.SDK_INT >= 31) c.getSystemService(SmsManager::class.java) else @Suppress("DEPRECATION") SmsManager.getDefault()
      val parts = sm.divideMessage(text)
      if (parts.size > 1) sm.sendMultipartTextMessage(to, null, parts, null, null) else sm.sendTextMessage(to, null, text, null, null)
      "OK"
    } catch (e: SecurityException) { "ERR: SMS permission is not allowed" }
    catch (e: Exception) { "ERR: " + (e.message ?: "could not send") }
  }

  private fun torch(on: Boolean): String {
    val c = ctx ?: return "ERR: app not ready"
    return try {
      val cm = c.getSystemService(Context.CAMERA_SERVICE) as CameraManager
      val id = cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(CameraCharacteristics.FLASH_INFO_AVAILABLE) == true }
        ?: return "ERR: this phone has no flashlight"
      cm.setTorchMode(id, on); "OK"
    } catch (e: Exception) { "ERR: " + (e.message ?: "flashlight failed") }
  }

  private fun volume(mode: String): String {
    val c = ctx ?: return "ERR: app not ready"
    val am = c.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    val max = am.getStreamMaxVolume(AudioManager.STREAM_MUSIC)
    return try {
      when (mode) {
        "up" -> { am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI); "Volume up." }
        "down" -> { am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI); "Volume down." }
        "mute" -> { am.adjustStreamVolume(AudioManager.STREAM_MUSIC, AudioManager.ADJUST_MUTE, AudioManager.FLAG_SHOW_UI); "Muted." }
        else -> {
          val p = mode.filter { it.isDigit() }.toIntOrNull() ?: return "ERR: say a level from 0 to 100, or up, down, mute"
          val lv = p.coerceIn(0, 100)
          am.setStreamVolume(AudioManager.STREAM_MUSIC, Math.round(lv * max / 100f), AudioManager.FLAG_SHOW_UI)
          "Volume $lv percent."
        }
      }
    } catch (e: Exception) { "ERR: " + (e.message ?: "volume failed") }      // e.g. Do Not Disturb blocks changing volume
  }

  private fun media(action: String): String {
    val c = ctx ?: return "ERR: app not ready"
    val code = when (action) {
      "play" -> KeyEvent.KEYCODE_MEDIA_PLAY
      "pause" -> KeyEvent.KEYCODE_MEDIA_PAUSE
      "next" -> KeyEvent.KEYCODE_MEDIA_NEXT
      "prev" -> KeyEvent.KEYCODE_MEDIA_PREVIOUS
      else -> return "ERR: unknown media action"
    }
    val am = c.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, code))
    am.dispatchMediaKeyEvent(KeyEvent(KeyEvent.ACTION_UP, code))
    return "OK"
  }

  private fun battery(): String {
    val c = ctx ?: return "ERR: app not ready"
    val bm = c.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
    val pct = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
    val st = c.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
    val charging = st == BatteryManager.BATTERY_STATUS_CHARGING || st == BatteryManager.BATTERY_STATUS_FULL
    return "Battery $pct percent${if (charging) ", charging" else ""}."
  }

  // coarse only: the last known fix (no GPS wake-up, no battery cost)
  @Suppress("DEPRECATION", "MissingPermission")
  private fun location(): String {
    val c = ctx ?: return "ERR: app not ready"
    return try {
      val lm = c.getSystemService(Context.LOCATION_SERVICE) as LocationManager
      val loc = lm.getProviders(true).mapNotNull { lm.getLastKnownLocation(it) }.maxByOrNull { it.time }
        ?: return "ERR: no recent location. Turn on location, or open a maps app once."
      val ll = String.format(Locale.US, "%.4f,%.4f", loc.latitude, loc.longitude)
      val city = try { Geocoder(c, Locale.getDefault()).getFromLocation(loc.latitude, loc.longitude, 1)?.firstOrNull()?.let { it.locality ?: it.subAdminArea ?: it.adminArea } } catch (e: Exception) { null }
      if (city != null) "Near $city ($ll)" else "($ll)"
    } catch (e: SecurityException) { "ERR: location permission is not allowed" }
    catch (e: Exception) { "ERR: " + (e.message ?: "location failed") }
  }

  override fun definition() = ModuleDefinition {
    Name("SheetDevice")
    Events("onBubble")

    OnCreate {
      OverlayService.onTap = { sendEvent("onBubble", mapOf("type" to "tap")) }
      OverlayService.onAction = { id, text -> sendEvent("onBubble", mapOf("type" to "action", "id" to id, "text" to text)) }
    }
    OnDestroy { OverlayService.onTap = null; OverlayService.onAction = null }
    // the bubble hides itself while Sheet.md is in front, and shows again when it goes behind another app
    OnActivityEntersForeground { OverlayService.appFg = true; OverlayService.refresh() }
    OnActivityEntersBackground { OverlayService.appFg = false; OverlayService.refresh() }

    Function("openApp") { name: String -> try { openApp(name) } catch (e: Exception) { "ERR: " + (e.message ?: "failed") } }
    Function("findContact") { q: String -> findContact(q) }
    Function("call") { number: String -> try { go(Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(number)))) } catch (e: SecurityException) { "ERR: call permission is not allowed" } }
    Function("sendSms") { to: String, text: String -> sms(to, text) }
    Function("setAlarm") { h: Int, m: Int, label: String ->
      go(Intent(AlarmClock.ACTION_SET_ALARM).putExtra(AlarmClock.EXTRA_HOUR, h).putExtra(AlarmClock.EXTRA_MINUTES, m)
        .putExtra(AlarmClock.EXTRA_MESSAGE, label).putExtra(AlarmClock.EXTRA_SKIP_UI, true))
    }
    Function("setTimer") { sec: Int, label: String ->
      go(Intent(AlarmClock.ACTION_SET_TIMER).putExtra(AlarmClock.EXTRA_LENGTH, sec)
        .putExtra(AlarmClock.EXTRA_MESSAGE, label).putExtra(AlarmClock.EXTRA_SKIP_UI, true))
    }
    Function("addEvent") { title: String, start: Double, end: Double ->
      go(Intent(Intent.ACTION_INSERT).setData(CalendarContract.Events.CONTENT_URI).putExtra(CalendarContract.Events.TITLE, title)
        .putExtra(CalendarContract.EXTRA_EVENT_BEGIN_TIME, start.toLong()).putExtra(CalendarContract.EXTRA_EVENT_END_TIME, end.toLong()))
    }
    Function("torch") { on: Boolean -> torch(on) }
    Function("setVolume") { mode: String -> volume(mode) }
    Function("media") { action: String -> media(action) }
    Function("battery") { battery() }
    Function("location") { location() }
    Function("openUrl") { url: String -> go(Intent(Intent.ACTION_VIEW, Uri.parse(url))) }

    // ---- floating bubble ----
    Function("hasOverlayPermission") { val c = ctx; c != null && Settings.canDrawOverlays(c) }
    Function("requestOverlayPermission") {
      val c = ctx
      if (c != null) go(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:" + c.packageName)))
    }
    Function("isAssistantOn") { prefs()?.getBoolean("assistant_on2", true) ?: true }       // default ON: the bubble needs no manual switch
    // ON only saves the choice: the foreground service (SheetService.update from JS) starts the bubble. OFF removes it at once.
    Function("setAssistantMode") { on: Boolean ->
      prefs()?.edit()?.putBoolean("assistant_on2", on)?.apply()
      val c = ctx
      if (!on && c != null) c.stopService(Intent().setClassName(c, "expo.modules.sheetdevice.OverlayService"))
    }
    Function("bubbleState") { s: String -> OverlayService.applyState(s) }
    Function("bubbleToast") { heard: String, reply: String -> OverlayService.showToast(heard, reply) }
    // bubble menu: JS owns the content. setBubbleMenu = the main list; bubbleList = a sub-list (topics, quick, last messages)
    // both take JSON [{id, label, icon, open?}]
    Function("setBubbleMenu") { json: String -> OverlayService.setMenu(json) }
    Function("bubbleList") { title: String, json: String -> OverlayService.showList(title, json) }
  }
}
