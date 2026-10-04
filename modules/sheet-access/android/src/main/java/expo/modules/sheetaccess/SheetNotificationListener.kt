package expo.modules.sheetaccess

import android.app.Notification
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import org.json.JSONArray
import org.json.JSONObject

// The ears of the assistant for notifications. Every public function returns a String: "ERR: ..." = failed / refused.
// Safety: notifications of banking / payment apps are never listed, announced, replied to or dismissed (same deny rule as the screen service:
// they carry OTPs and balances). Own notifications, ongoing ones (music, downloads) and group summaries are skipped.
class SheetNotificationListener : NotificationListenerService() {
  companion object {
    @Volatile var inst: SheetNotificationListener? = null
    @Volatile var onPosted: ((String) -> Unit)? = null           // JSON of a new notification -> JS event (announce)
  }

  override fun onListenerConnected() { inst = this }
  override fun onListenerDisconnected() { inst = null }
  override fun onNotificationPosted(sbn: StatusBarNotification?) {
    val e = sbn?.let { entry(it) } ?: return
    try { onPosted?.invoke(e.toString()) } catch (ex: Exception) {}
  }

  private fun appLabel(pkg: String): String = try {
    packageManager.getApplicationLabel(packageManager.getApplicationInfo(pkg, 0)).toString()
  } catch (e: Exception) { pkg.substringAfterLast('.') }

  // the action that sends a typed reply (a chat app's "Reply"), or null
  private fun findReply(n: Notification): Notification.Action? {
    val acts = n.actions ?: return null
    var best: Notification.Action? = null
    for (a in acts) {
      if (a.remoteInputs.isNullOrEmpty()) continue
      if (Build.VERSION.SDK_INT >= 28 && a.semanticAction == Notification.Action.SEMANTIC_ACTION_REPLY) return a
      if (best == null) best = a
    }
    return best
  }

  @Suppress("DEPRECATION")
  private fun entry(s: StatusBarNotification): JSONObject? {
    val pkg = s.packageName ?: return null
    if (pkg == packageName || SheetAccessibilityService.denied(pkg)) return null
    val n = s.notification ?: return null
    if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0 || s.isOngoing) return null
    val ex = n.extras ?: return null
    val title = ex.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
    var text = (ex.getCharSequence(Notification.EXTRA_BIG_TEXT) ?: ex.getCharSequence(Notification.EXTRA_TEXT))?.toString() ?: ""
    // chat apps: the newest message of the conversation (with the sender's name in a group)
    val msgs = ex.getParcelableArray(Notification.EXTRA_MESSAGES)
    if (msgs != null && msgs.isNotEmpty()) {
      (msgs.last() as? Bundle)?.let { b ->
        b.getCharSequence("text")?.toString()?.let { text = it }
        val who = b.getCharSequence("sender")?.toString()
        if (!who.isNullOrBlank() && who != title) text = "$who: $text"
      }
    }
    if (title.isBlank() && text.isBlank()) return null
    return JSONObject().put("key", s.key).put("pkg", pkg).put("app", appLabel(pkg)).put("title", title.take(80)).put("text", text.take(300))
      .put("time", s.postTime).put("canReply", findReply(n) != null)
  }

  // newest first, at most `max`
  fun list(max: Int): String {
    val all = try { activeNotifications } catch (e: Exception) { null } ?: return "ERR: I cannot read the notifications right now."
    val arr = JSONArray()
    for (s in all.sortedByDescending { it.postTime }) { if (arr.length() >= max) break; entry(s)?.let { arr.put(it) } }
    return arr.toString()
  }

  private fun find(key: String): StatusBarNotification? = try { getActiveNotifications(arrayOf(key))?.firstOrNull() } catch (e: Exception) { null }

  // answers through the notification's own RemoteInput action, like typing in the reply box of the shade
  fun reply(key: String, text: String): String {
    val s = find(key) ?: return "ERR: that notification is gone."
    if (SheetAccessibilityService.denied(s.packageName)) return "ERR: I do not reply inside banking or payment apps."
    val a = findReply(s.notification) ?: return "ERR: this notification cannot be replied to."
    val inputs = a.remoteInputs
    val results = Bundle()
    for (r in inputs) results.putCharSequence(r.resultKey, text)
    val i = Intent()
    RemoteInput.addResultsToIntent(inputs, i, results)
    if (Build.VERSION.SDK_INT >= 28) RemoteInput.setResultsSource(i, RemoteInput.SOURCE_FREE_FORM_INPUT)
    return try { a.actionIntent.send(this, 0, i); "OK" }
    catch (e: PendingIntent.CanceledException) { "ERR: the app no longer accepts that reply." }
    catch (e: Exception) { "ERR: " + (e.message ?: "the reply failed.") }
  }

  fun dismiss(key: String): String {
    val s = find(key) ?: return "ERR: that notification is gone."
    if (SheetAccessibilityService.denied(s.packageName)) return "ERR: I do not touch banking and payment notifications."
    return try { cancelNotification(key); "OK" } catch (e: Exception) { "ERR: " + (e.message ?: "could not dismiss it.") }
  }
}
