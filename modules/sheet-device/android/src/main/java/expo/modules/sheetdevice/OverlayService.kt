package expo.modules.sheetdevice

import android.animation.ValueAnimator
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.widget.TextView

// The "Jarvis orb": a 56dp draggable bubble drawn with WindowManager (TYPE_APPLICATION_OVERLAY).
// Started by the app's foreground service while Assistant mode is on, so it lives with the app in the background / screen off.
// States are pushed from JS: idle (grey), listening (pulsing blue), thinking (spinning), speaking (green wave).
class OverlayService : Service() {
  companion object {
    @Volatile var inst: OverlayService? = null
    @Volatile var appFg = false                       // Sheet.md itself is in front: the bubble hides
    @Volatile var onTap: (() -> Unit)? = null
    @Volatile var state = "idle"
    private val main = Handler(Looper.getMainLooper())
    fun refresh() { main.post { inst?.applyVisibility() } }
    fun setState(s: String) { state = s; main.post { inst?.bubble?.setMode(s) } }
    fun showToast(heard: String, reply: String) { main.post { inst?.toast(heard, reply) } }
  }

  private lateinit var wm: WindowManager
  var bubble: BubbleView? = null
  private var toastView: TextView? = null
  private lateinit var lp: WindowManager.LayoutParams
  private lateinit var tlp: WindowManager.LayoutParams
  private val handler = Handler(Looper.getMainLooper())
  private val hideToast = Runnable { toastView?.visibility = View.GONE }
  private fun dp(v: Float) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, resources.displayMetrics)
  private val sw get() = resources.displayMetrics.widthPixels
  private val sh get() = resources.displayMetrics.heightPixels

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    inst = this
    if (bubble == null) {
      if (!Settings.canDrawOverlays(this)) { stopSelf(); return START_NOT_STICKY }       // permission taken away: nothing to draw
      build()
    }
    applyVisibility()
    return START_NOT_STICKY
  }

  private fun type() = WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY

  private fun build() {
    wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
    val size = dp(56f).toInt()
    val prefs = getSharedPreferences("sheet_device", Context.MODE_PRIVATE)
    lp = WindowManager.LayoutParams(size, size, type(),
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL, PixelFormat.TRANSLUCENT).apply {
      gravity = Gravity.TOP or Gravity.START
      x = prefs.getInt("bx", sw - size); y = prefs.getInt("by", (sh * 0.4f).toInt())   // position is remembered
    }
    val b = BubbleView(this)
    b.setMode(state)
    attachTouch(b, size, prefs)
    wm.addView(b, lp)
    bubble = b

    val t = TextView(this).apply {
      setTextColor(Color.WHITE); setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
      setPadding(dp(12f).toInt(), dp(8f).toInt(), dp(12f).toInt(), dp(8f).toInt())
      maxWidth = dp(260f).toInt(); visibility = View.GONE
      background = GradientDrawable().apply { setColor(Color.parseColor("#F2111111")); cornerRadius = dp(14f) }
    }
    tlp = WindowManager.LayoutParams(WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT, type(),
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE, PixelFormat.TRANSLUCENT).apply { gravity = Gravity.TOP or Gravity.START }
    wm.addView(t, tlp)
    toastView = t
  }

  private fun attachTouch(v: View, size: Int, prefs: android.content.SharedPreferences) {
    val slop = ViewConfiguration.get(this).scaledTouchSlop
    var dx = 0f; var dy = 0f; var sx = 0; var sy = 0; var moved = false; var longDone = false
    val longPress = Runnable {
      longDone = true                                  // long-press opens Sheet.md
      packageManager.getLaunchIntentForPackage(packageName)?.let { try { startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (e: Exception) {} }
    }
    v.setOnTouchListener { _, e ->
      when (e.action) {
        MotionEvent.ACTION_DOWN -> { dx = e.rawX; dy = e.rawY; sx = lp.x; sy = lp.y; moved = false; longDone = false; handler.postDelayed(longPress, 550); true }
        MotionEvent.ACTION_MOVE -> {
          val mx = e.rawX - dx; val my = e.rawY - dy
          if (!moved && (Math.abs(mx) > slop || Math.abs(my) > slop)) { moved = true; handler.removeCallbacks(longPress) }
          if (moved) {
            lp.x = (sx + mx).toInt().coerceIn(0, sw - size); lp.y = (sy + my).toInt().coerceIn(0, sh - size)
            try { wm.updateViewLayout(v, lp) } catch (ex: Exception) {}
          }
          true
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          handler.removeCallbacks(longPress)
          if (moved) snap(v, size, prefs)
          else if (!longDone && e.action == MotionEvent.ACTION_UP) onTap?.invoke()
          true
        }
        else -> false
      }
    }
  }

  // after a drag the bubble slides to the nearest screen edge and the spot is saved
  private fun snap(v: View, size: Int, prefs: android.content.SharedPreferences) {
    val target = if (lp.x + size / 2 < sw / 2) 0 else sw - size
    ValueAnimator.ofInt(lp.x, target).apply {
      duration = 180; interpolator = DecelerateInterpolator()
      addUpdateListener { lp.x = it.animatedValue as Int; try { wm.updateViewLayout(v, lp) } catch (ex: Exception) {} }
      addListener(object : android.animation.AnimatorListenerAdapter() {
        override fun onAnimationEnd(a: android.animation.Animator) { prefs.edit().putInt("bx", lp.x).putInt("by", lp.y).apply() }
      })
      start()
    }
  }

  fun applyVisibility() {
    val show = !appFg
    bubble?.visibility = if (show) View.VISIBLE else View.GONE
    if (!show) { toastView?.visibility = View.GONE; handler.removeCallbacks(hideToast) }
    bubble?.setMode(state)
  }

  // heard text + last reply above the bubble (below it when the bubble is at the top), hidden after 4 s
  fun toast(heard: String, reply: String) {
    val t = toastView ?: return
    if (appFg || (heard.isBlank() && reply.isBlank())) return
    val sb = SpannableStringBuilder()
    if (heard.isNotBlank()) { sb.append(heard.take(90)); sb.setSpan(ForegroundColorSpan(Color.parseColor("#B0B0B0")), 0, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE) }
    if (reply.isNotBlank()) {
      if (sb.isNotEmpty()) sb.append("\n")
      val s = sb.length; sb.append(reply.take(160))
      sb.setSpan(StyleSpan(Typeface.BOLD), s, sb.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    t.text = sb
    t.measure(View.MeasureSpec.makeMeasureSpec(dp(260f).toInt(), View.MeasureSpec.AT_MOST), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
    val w = t.measuredWidth; val h = t.measuredHeight; val gap = dp(8f).toInt(); val bs = dp(56f).toInt()
    tlp.x = (if (lp.x + bs / 2 < sw / 2) lp.x else lp.x + bs - w).coerceIn(dp(6f).toInt(), (sw - w - dp(6f).toInt()).coerceAtLeast(dp(6f).toInt()))
    tlp.y = if (lp.y - h - gap >= 0) lp.y - h - gap else lp.y + bs + gap
    t.visibility = View.VISIBLE
    try { wm.updateViewLayout(t, tlp) } catch (e: Exception) {}
    handler.removeCallbacks(hideToast); handler.postDelayed(hideToast, 4000)
  }

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    bubble?.stop()
    try { bubble?.let { wm.removeView(it) } } catch (e: Exception) {}
    try { toastView?.let { wm.removeView(it) } } catch (e: Exception) {}
    bubble = null; toastView = null; inst = null
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}

class BubbleView(c: Context) : View(c) {
  private var mode = "idle"
  private var phase = 0f
  private var anim: ValueAnimator? = null
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }
  private val d = resources.displayMetrics.density

  fun setMode(m: String) {
    mode = m
    if (m == "idle" || visibility != VISIBLE) { stop() } else if (anim == null) {
      anim = ValueAnimator.ofFloat(0f, 1f).apply {
        duration = 1100; repeatCount = ValueAnimator.INFINITE; interpolator = null
        addUpdateListener { phase = it.animatedValue as Float; invalidate() }
        start()
      }
    }
    invalidate()
  }
  fun stop() { anim?.cancel(); anim = null; phase = 0f; invalidate() }
  override fun onDetachedFromWindow() { stop(); super.onDetachedFromWindow() }

  override fun onDraw(cv: Canvas) {
    val cx = width / 2f; val cy = height / 2f; val r = 22f * d
    when (mode) {
      "listening" -> {                                  // pulsing blue: an outer ring grows and fades
        fill.color = Color.parseColor("#2979FF"); fill.alpha = 255
        val pr = r + (width / 2f - r) * phase
        fill.alpha = (110 * (1f - phase)).toInt(); cv.drawCircle(cx, cy, pr, fill)
        fill.alpha = 255; cv.drawCircle(cx, cy, r, fill)
        fill.color = Color.WHITE; cv.drawCircle(cx, cy, 5f * d, fill)
      }
      "thinking" -> {                                   // spinning arc on a dark disc
        fill.color = Color.parseColor("#1F1F1F"); fill.alpha = 255; cv.drawCircle(cx, cy, r, fill)
        line.color = Color.WHITE; line.strokeWidth = 3f * d
        cv.drawArc(RectF(cx - r + 6f * d, cy - r + 6f * d, cx + r - 6f * d, cy + r - 6f * d), phase * 360f, 100f, false, line)
      }
      "speaking" -> {                                   // green with five moving bars (the wave)
        fill.color = Color.parseColor("#16A34A"); fill.alpha = 255; cv.drawCircle(cx, cy, r, fill)
        line.color = Color.WHITE; line.strokeWidth = 3f * d
        for (i in 0 until 5) {
          val h = (4f + 10f * Math.abs(Math.sin((phase * 2 * Math.PI) + i * 0.9))).toFloat() * d
          val x = cx + (i - 2) * 6f * d
          cv.drawLine(x, cy - h / 2, x, cy + h / 2, line)
        }
      }
      else -> {                                         // idle: grey
        fill.color = Color.parseColor("#9AA0A6"); fill.alpha = 255; cv.drawCircle(cx, cy, r, fill)
        fill.color = Color.WHITE; cv.drawCircle(cx, cy, 5f * d, fill)
      }
    }
  }
}
