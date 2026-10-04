package expo.modules.sheetaccess

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.app.KeyguardManager
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Path
import android.graphics.Rect
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.view.Display
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

// The hands of the assistant. Every public function returns a String: "ERR: ..." = failed / refused, anything else = the result.
// Nothing throws into JS. Safety is enforced HERE (not only in the prompt):
//  - phone locked            -> nothing is read or done
//  - banking / payment apps  -> nothing is read or done (guard() runs before EVERY function)
//  - password fields         -> text is never read, never typed into
//  - secure (FLAG_SECURE) windows expose no readable nodes / no screenshot -> reported as "nothing readable"
// All functions except the tiny ones must be called from a background thread (the Expo AsyncFunction does that): gestures wait for a callback on the main thread.
class SheetAccessibilityService : AccessibilityService() {
  companion object {
    @Volatile var inst: SheetAccessibilityService? = null
    private val DENY = listOf("com.google.android.apps.nbu.paisa.user", "com.phonepe.app", "net.one97.paytm")
    fun denied(pkg: String?): Boolean {
      if (pkg == null) return false
      val p = pkg.lowercase()
      return DENY.contains(p) || p.contains("bank")
    }
  }

  private var nodes: List<AccessibilityNodeInfo> = emptyList()      // the items of the last readScreen(): "i" in the JSON is the index here

  override fun onServiceConnected() { inst = this }
  override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
  override fun onInterrupt() {}
  override fun onUnbind(intent: Intent?): Boolean { inst = null; return super.onUnbind(intent) }
  override fun onDestroy() { inst = null; super.onDestroy() }

  // null = fine to go on, otherwise the "ERR: ..." to return
  private fun guard(): String? {
    val km = getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
    if (km.isKeyguardLocked) return "ERR: the phone is locked. Please unlock it first."
    val root = rootInActiveWindow ?: return "ERR: I cannot see the screen right now."
    val pkg = root.packageName?.toString()
    if (denied(pkg)) return "ERR: I do not read or touch banking and payment apps ($pkg)."
    return null
  }

  private fun collect(n: AccessibilityNodeInfo?, out: MutableList<AccessibilityNodeInfo>, depth: Int) {
    if (n == null || out.size >= 120 || depth > 40 || !n.isVisibleToUser) return
    val useful = !n.text.isNullOrBlank() || !n.contentDescription.isNullOrBlank() || n.isClickable || n.isEditable || n.isScrollable
    if (useful) out.add(n)
    for (i in 0 until n.childCount) collect(n.getChild(i), out, depth + 1)
  }

  private fun describe(i: Int, n: AccessibilityNodeInfo): JSONObject {
    val b = Rect(); n.getBoundsInScreen(b)
    val o = JSONObject().put("i", i)
    if (n.isPassword) o.put("pw", true)                                                      // a password field: its content is never sent anywhere
    else n.text?.toString()?.take(120)?.let { if (it.isNotBlank()) o.put("text", it) }
    n.contentDescription?.toString()?.take(80)?.let { if (it.isNotBlank()) o.put("desc", it) }
    n.viewIdResourceName?.substringAfter('/')?.let { if (it.isNotEmpty()) o.put("id", it) }
    o.put("cls", (n.className?.toString() ?: "").substringAfterLast('.'))
    if (n.isClickable) o.put("clickable", true)                                              // only true flags are written: compact
    if (n.isEditable) o.put("editable", true)
    if (n.isScrollable) o.put("scrollable", true)
    o.put("bounds", JSONArray(listOf(b.left, b.top, b.right, b.bottom)))
    return o
  }

  private fun refreshNodes(): String? {
    guard()?.let { return it }
    val root = rootInActiveWindow ?: return "ERR: I cannot see the screen right now."
    val out = ArrayList<AccessibilityNodeInfo>()
    collect(root, out, 0)
    nodes = out
    return null
  }

  // {"pkg": "...", "nodes": [{i,text,desc,id,cls,clickable,editable,scrollable,bounds}]}, max 120 visible nodes
  fun readScreen(): String {
    refreshNodes()?.let { return it }
    if (nodes.isEmpty()) return "ERR: nothing readable on this screen (it may be a secure screen)."
    val arr = JSONArray()
    nodes.forEachIndexed { i, n -> arr.put(describe(i, n)) }
    return JSONObject().put("pkg", rootInActiveWindow?.packageName?.toString() ?: "").put("nodes", arr).toString()
  }

  private fun gesture(x1: Float, y1: Float, x2: Float, y2: Float, ms: Long): String {
    val p = Path().apply { moveTo(x1, y1); if (x1 != x2 || y1 != y2) lineTo(x2, y2) }
    val g = GestureDescription.Builder().addStroke(GestureDescription.StrokeDescription(p, 0, Math.max(ms, 1L))).build()
    val latch = CountDownLatch(1)
    var done = false
    val cb = object : GestureResultCallback() {
      override fun onCompleted(d: GestureDescription?) { done = true; latch.countDown() }
      override fun onCancelled(d: GestureDescription?) { latch.countDown() }
    }
    if (!dispatchGesture(g, cb, Handler(Looper.getMainLooper()))) return "ERR: the gesture was refused"
    latch.await(ms + 2000, TimeUnit.MILLISECONDS)
    return if (done) "OK" else "ERR: the gesture did not finish"
  }

  private fun click(n0: AccessibilityNodeInfo, long: Boolean): String {
    if (!n0.refresh()) return "ERR: that item is gone. Read the screen again."
    var n: AccessibilityNodeInfo? = n0
    var hops = 0
    while (n != null && hops < 6) {                                                          // the label is often a child of the real button
      if ((if (long) n.isLongClickable else n.isClickable) && n.isEnabled) {
        if (n.performAction(if (long) AccessibilityNodeInfo.ACTION_LONG_CLICK else AccessibilityNodeInfo.ACTION_CLICK)) return "OK"
        break
      }
      n = n.parent; hops++
    }
    val b = Rect(); n0.getBoundsInScreen(b)
    return gesture(b.centerX().toFloat(), b.centerY().toFloat(), b.centerX().toFloat(), b.centerY().toFloat(), if (long) 700L else 60L)
  }

  fun tapIndex(i: Int, long: Boolean): String {
    guard()?.let { return it }
    val n = nodes.getOrNull(i) ?: return "ERR: there is no item $i. Read the screen again."
    return click(n, long)
  }

  fun tapText(text: String, long: Boolean): String {
    refreshNodes()?.let { return it }
    val q = text.trim().lowercase()
    if (q.isEmpty()) return "ERR: which text?"
    fun label(n: AccessibilityNodeInfo) = ((n.text?.toString() ?: "") + "\u0000" + (n.contentDescription?.toString() ?: "")).lowercase().split('\u0000')
    val hit = nodes.firstOrNull { n -> !n.isPassword && label(n).any { it == q } }
      ?: nodes.firstOrNull { n -> !n.isPassword && label(n).any { it.isNotEmpty() && it.contains(q) } }
      ?: return "ERR: I cannot see \"$text\" on the screen."
    return click(hit, long)
  }

  fun tapXY(x: Float, y: Float, long: Boolean): String {
    guard()?.let { return it }
    return gesture(x, y, x, y, if (long) 700L else 60L)
  }

  private fun firstEditable(n: AccessibilityNodeInfo?, depth: Int = 0): AccessibilityNodeInfo? {
    if (n == null || depth > 40 || !n.isVisibleToUser) return null
    if (n.isEditable) return n
    for (i in 0 until n.childCount) firstEditable(n.getChild(i), depth + 1)?.let { return it }
    return null
  }

  // replaces the text of the focused field (or the first visible field); never into a password field
  fun typeText(text: String): String {
    guard()?.let { return it }
    val root = rootInActiveWindow ?: return "ERR: I cannot see the screen right now."
    var f: AccessibilityNodeInfo? = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)
    if (f == null || !f.isEditable) f = firstEditable(root)
    if (f == null) return "ERR: there is no text field to type into. Tap the field first."
    if (f.isPassword) return "ERR: I never type into password fields."
    if (!f.isFocused) f.performAction(AccessibilityNodeInfo.ACTION_FOCUS)
    val args = Bundle().apply { putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text) }
    return if (f.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)) "OK" else "ERR: typing did not work in this field."
  }

  private fun biggestScrollable(n: AccessibilityNodeInfo?, depth: Int = 0): AccessibilityNodeInfo? {
    if (n == null || depth > 40 || !n.isVisibleToUser) return null
    var best: AccessibilityNodeInfo? = if (n.isScrollable) n else null
    var bestArea = 0L
    if (best != null) { val r = Rect(); best.getBoundsInScreen(r); bestArea = r.width().toLong() * r.height() }
    for (i in 0 until n.childCount) {
      val c = biggestScrollable(n.getChild(i), depth + 1) ?: continue
      val r = Rect(); c.getBoundsInScreen(r)
      val a = r.width().toLong() * r.height()
      if (a > bestArea) { best = c; bestArea = a }
    }
    return best
  }

  // dir = the way the CONTENT is moved to see more: "down" shows what is further down the list
  fun scroll(dir: String): String {
    guard()?.let { return it }
    val root = rootInActiveWindow ?: return "ERR: I cannot see the screen right now."
    val back = dir == "up" || dir == "left"
    val t = biggestScrollable(root)
    if (t != null && t.performAction(if (back) AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD else AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)) return "OK"
    val dm = resources.displayMetrics; val w = dm.widthPixels.toFloat(); val h = dm.heightPixels.toFloat()
    return when (dir) {
      "down" -> gesture(w / 2, h * 0.7f, w / 2, h * 0.3f, 350)
      "up" -> gesture(w / 2, h * 0.3f, w / 2, h * 0.7f, 350)
      "left" -> gesture(w * 0.3f, h / 2, w * 0.7f, h / 2, 350)
      "right" -> gesture(w * 0.7f, h / 2, w * 0.3f, h / 2, 350)
      else -> "ERR: direction must be up, down, left or right."
    }
  }

  fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, ms: Long): String {
    guard()?.let { return it }
    return gesture(x1, y1, x2, y2, ms.coerceIn(50L, 3000L))
  }

  // Back / Home / Recents do not read anything, so they also work from a banking app (a safe way OUT). Screenshot is guarded.
  fun global(a: String): String {
    val code = when (a) {
      "back" -> GLOBAL_ACTION_BACK
      "home" -> GLOBAL_ACTION_HOME
      "recents" -> GLOBAL_ACTION_RECENTS
      "notifications" -> GLOBAL_ACTION_NOTIFICATIONS
      "quickSettings" -> GLOBAL_ACTION_QUICK_SETTINGS
      "lockScreen" -> if (Build.VERSION.SDK_INT >= 28) GLOBAL_ACTION_LOCK_SCREEN else return "ERR: locking the screen needs Android 9 or newer."
      "screenshot" -> {
        if (Build.VERSION.SDK_INT < 28) return "ERR: screenshots need Android 9 or newer."
        guard()?.let { return it }
        GLOBAL_ACTION_TAKE_SCREENSHOT
      }
      else -> return "ERR: unknown key $a."
    }
    return if (performGlobalAction(code)) "OK" else "ERR: Android did not accept that."
  }

  // base64 JPEG (longest side 1024 px, quality 70) - used by Vision later
  fun screenshot(): String {
    if (Build.VERSION.SDK_INT < 30) return "ERR: reading a screenshot needs Android 11 or newer."
    guard()?.let { return it }
    val latch = CountDownLatch(1)
    var res = "ERR: the screenshot failed."
    takeScreenshot(Display.DEFAULT_DISPLAY, mainExecutor, object : TakeScreenshotCallback {
      override fun onSuccess(r: ScreenshotResult) {
        try {
          val hw = Bitmap.wrapHardwareBuffer(r.hardwareBuffer, r.colorSpace)
          val bmp = hw?.copy(Bitmap.Config.ARGB_8888, false)
          r.hardwareBuffer.close()
          if (bmp != null) {
            val k = 1024f / Math.max(bmp.width, bmp.height)
            val s = if (k < 1f) Bitmap.createScaledBitmap(bmp, Math.round(bmp.width * k), Math.round(bmp.height * k), true) else bmp
            val bo = ByteArrayOutputStream()
            s.compress(Bitmap.CompressFormat.JPEG, 70, bo)
            res = Base64.encodeToString(bo.toByteArray(), Base64.NO_WRAP)
          }
        } catch (e: Exception) { res = "ERR: " + (e.message ?: "the screenshot failed.") }
        latch.countDown()
      }
      override fun onFailure(errorCode: Int) { res = "ERR: Android refused the screenshot (code $errorCode). A secure screen cannot be captured."; latch.countDown() }
    })
    latch.await(6, TimeUnit.SECONDS)
    return res
  }
}
