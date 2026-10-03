package expo.modules.sheetdevice

import android.animation.ValueAnimator
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.TextUtils
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.WindowManager
import android.view.animation.DecelerateInterpolator
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import org.json.JSONArray

// One row of the bubble menu. The list is DRIVEN FROM JS (setBubbleMenu / bubbleList); `open` = JS will answer with a list.
data class MenuItem(val id: String, val label: String, val glyph: String, val open: Boolean)

// The assistant bubble: the APP ICON with a state RING (idle grey / listening pulsing blue / thinking spinning arc / speaking green + wave),
// drawn with WindowManager (TYPE_APPLICATION_OVERLAY). Started by the foreground service while Assistant mode is on.
// Tap = mic. Chevron (top-right corner) = menu panel. Long-press = open the app.
class OverlayService : Service() {
  companion object {
    @Volatile var inst: OverlayService? = null
    @Volatile var appFg = false                       // Sheet.md itself is in front: bubble + panel hide
    @Volatile var onTap: (() -> Unit)? = null
    @Volatile var onAction: ((String, String) -> Unit)? = null   // (id, text) -> JS event {type:'action', id, text}
    @Volatile var state = "idle"
    @Volatile var menu: List<MenuItem> = emptyList()
    private val main = Handler(Looper.getMainLooper())
    fun refresh() { main.post { inst?.applyVisibility() } }
    fun applyState(s: String) { state = s; main.post { inst?.bubble?.setMode(s) } }
    fun showToast(heard: String, reply: String) { main.post { inst?.toast(heard, reply) } }
    fun parse(json: String): List<MenuItem> = try {
      val a = JSONArray(json)
      (0 until a.length()).mapNotNull { i ->
        val o = a.optJSONObject(i) ?: return@mapNotNull null
        MenuItem(o.optString("id"), o.optString("label"), o.optString("glyph"), o.optBoolean("open", false))
      }
    } catch (e: Exception) { emptyList() }
    fun setMenu(json: String) { menu = parse(json); main.post { inst?.menuChanged() } }
    fun showList(title: String, json: String) { val l = parse(json); main.post { inst?.showList(title, l) } }
  }

  private lateinit var wm: WindowManager
  var bubble: BubbleView? = null
  private var toastView: TextView? = null
  private var panel: LinearLayout? = null
  private var body: LinearLayout? = null
  private var panelMode = "menu"                        // menu | list | type
  private var closedAt = 0L                             // an outside tap closes the panel before the chevron tap arrives: do not reopen at once
  private lateinit var lp: WindowManager.LayoutParams
  private lateinit var tlp: WindowManager.LayoutParams
  private lateinit var plp: WindowManager.LayoutParams
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

  private fun openAppNow() {
    packageManager.getLaunchIntentForPackage(packageName)?.let { try { startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) } catch (e: Exception) {} }
  }

  private fun attachTouch(v: BubbleView, size: Int, prefs: android.content.SharedPreferences) {
    val slop = ViewConfiguration.get(this).scaledTouchSlop
    var dx = 0f; var dy = 0f; var lx = 0f; var ly = 0f; var sx = 0; var sy = 0; var moved = false; var longDone = false
    val longPress = Runnable { longDone = true; closePanel(); openAppNow() }          // long-press opens Sheet.md
    v.setOnTouchListener { _, e ->
      when (e.action) {
        MotionEvent.ACTION_DOWN -> { dx = e.rawX; dy = e.rawY; lx = e.x; ly = e.y; sx = lp.x; sy = lp.y; moved = false; longDone = false; handler.postDelayed(longPress, 550); true }
        MotionEvent.ACTION_MOVE -> {
          val mx = e.rawX - dx; val my = e.rawY - dy
          if (!moved && (Math.abs(mx) > slop || Math.abs(my) > slop)) { moved = true; handler.removeCallbacks(longPress); closePanel() }
          if (moved) {
            lp.x = (sx + mx).toInt().coerceIn(0, sw - size); lp.y = (sy + my).toInt().coerceIn(0, sh - size)
            try { wm.updateViewLayout(v, lp) } catch (ex: Exception) {}
          }
          true
        }
        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
          handler.removeCallbacks(longPress)
          if (moved) snap(v, size, prefs)
          else if (!longDone && e.action == MotionEvent.ACTION_UP) { if (v.chevronHit(lx, ly)) togglePanel() else onTap?.invoke() }   // tap = mic (unchanged); chevron = menu
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

  // ---------------- menu panel (native Views, driven from JS) ----------------
  private fun togglePanel() {
    if (panel != null) { closePanel(); return }
    if (System.currentTimeMillis() - closedAt < 700) return        // that outside-tap already closed it
    openPanel()
  }

  private fun openPanel() {
    if (panel != null || appFg || bubble == null) return
    val w = Math.min(dp(280f).toInt(), sw - dp(24f).toInt())
    val card = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      background = GradientDrawable().apply { setColor(Color.parseColor("#F2161616")); cornerRadius = dp(18f) }
      setPadding(dp(6f).toInt(), dp(6f).toInt(), dp(6f).toInt(), dp(6f).toInt())
      setOnTouchListener { _, e -> if (e.action == MotionEvent.ACTION_OUTSIDE) { closedAt = System.currentTimeMillis(); closePanel() }; false }
    }
    val sv = ScrollView(this).apply { isVerticalScrollBarEnabled = false }
    val bd = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
    sv.addView(bd); card.addView(sv, LinearLayout.LayoutParams(-1, -1))
    plp = WindowManager.LayoutParams(w, WindowManager.LayoutParams.WRAP_CONTENT, type(),
      WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL or WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH,
      PixelFormat.TRANSLUCENT).apply { gravity = Gravity.TOP or Gravity.START; softInputMode = WindowManager.LayoutParams.SOFT_INPUT_ADJUST_PAN }
    panel = card; body = bd
    try { wm.addView(card, plp) } catch (e: Exception) { panel = null; body = null; return }
    bubble?.setPanelOpen(true)
    showMenu()
  }

  fun closePanel() {
    val p = panel ?: return
    hideKeyboard(p)
    try { wm.removeView(p) } catch (e: Exception) {}
    panel = null; body = null; panelMode = "menu"
    bubble?.setPanelOpen(false)
  }

  private fun hideKeyboard(v: View) { try { (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(v.windowToken, 0) } catch (e: Exception) {} }

  fun menuChanged() { if (panel != null && panelMode == "menu") showMenu() }

  private fun row(glyph: String, label: String, onClick: (() -> Unit)?, muted: Boolean = false): View {
    val r = LinearLayout(this).apply {
      orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL
      minimumHeight = dp(44f).toInt(); setPadding(dp(8f).toInt(), dp(6f).toInt(), dp(8f).toInt(), dp(6f).toInt())
    }
    r.addView(TextView(this).apply {
      text = glyph; gravity = Gravity.CENTER; setTextColor(Color.parseColor("#8AB4F8")); setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f); typeface = Typeface.DEFAULT_BOLD
    }, LinearLayout.LayoutParams(dp(30f).toInt(), -2))
    r.addView(TextView(this).apply {
      text = label; setTextColor(if (muted) Color.parseColor("#B0B0B0") else Color.WHITE); setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
      maxLines = 4; ellipsize = TextUtils.TruncateAt.END
    }, LinearLayout.LayoutParams(0, -2, 1f).apply { leftMargin = dp(6f).toInt() })
    if (onClick != null) {
      r.background = GradientDrawable().apply { setColor(Color.TRANSPARENT); cornerRadius = dp(12f) }
      r.setOnClickListener { onClick() }
    }
    return r
  }

  private fun fill(items: List<View>) {
    val b = body ?: return
    b.removeAllViews(); items.forEach { b.addView(it) }
    place()
  }

  private fun showMenu() {
    panelMode = "menu"
    setFocusable(false)
    val items = if (menu.isEmpty()) listOf(row("", "Menu is loading…", null, true)) else menu.map { m ->
      row(m.glyph, m.label, {
        when (m.id) {
          "type" -> showType()
          "open" -> { closePanel(); openAppNow() }
          else -> {
            onAction?.invoke(m.id, "")
            if (m.open) fill(listOf(row("", "Loading…", null, true))) else closePanel()
          }
        }
      })
    }
    fill(items)
  }

  fun showList(title: String, items: List<MenuItem>) {
    if (panel == null) return
    panelMode = "list"
    val rows = ArrayList<View>()
    rows.add(row("‹", "Back · $title", { showMenu() }, true))
    if (items.isEmpty()) rows.add(row("", "Nothing here yet.", null, true))
    items.forEach { m -> rows.add(row(m.glyph, m.label, if (m.id.isEmpty()) null else ({ onAction?.invoke(m.id, ""); closePanel() }), m.id.isEmpty())) }
    fill(rows)
  }

  private fun showType() {
    panelMode = "type"
    val et = EditText(this).apply {
      hint = "Type a command…"; setHintTextColor(Color.parseColor("#888888")); setTextColor(Color.WHITE); setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f)
      setSingleLine(true); imeOptions = EditorInfo.IME_ACTION_SEND; inputType = InputType.TYPE_CLASS_TEXT
      background = GradientDrawable().apply { setColor(Color.parseColor("#2A2A2A")); cornerRadius = dp(12f) }
      setPadding(dp(12f).toInt(), dp(10f).toInt(), dp(12f).toInt(), dp(10f).toInt())
      setOnEditorActionListener { v, id, _ ->
        if (id == EditorInfo.IME_ACTION_SEND) {
          val t = v.text.toString().trim()
          if (t.isNotEmpty()) { onAction?.invoke("type", t); closePanel() }
          true
        } else false
      }
    }
    fill(listOf(row("‹", "Back", { showMenu() }, true), et))
    setFocusable(true)                                          // the keyboard needs a focusable window: only while this field is open
    et.requestFocus()
    et.postDelayed({ try { (getSystemService(Context.INPUT_METHOD_SERVICE) as InputMethodManager).showSoftInput(et, InputMethodManager.SHOW_IMPLICIT) } catch (e: Exception) {} }, 120)
  }

  private fun setFocusable(on: Boolean) {
    val p = panel ?: return
    plp.flags = if (on) plp.flags and WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE.inv() else plp.flags or WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
    try { wm.updateViewLayout(p, plp) } catch (e: Exception) {}
  }

  // size (max 360dp tall) and position: below the bubble when it is in the top half, above it otherwise; on the bubble's own side
  private fun place() {
    val p = panel ?: return; val b = body ?: return
    val w = plp.width
    b.measure(View.MeasureSpec.makeMeasureSpec(w - dp(12f).toInt(), View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
    val h = Math.min(b.measuredHeight + dp(12f).toInt(), dp(360f).toInt())
    val bs = dp(56f).toInt(); val gap = dp(6f).toInt(); val edge = dp(6f).toInt()
    plp.height = h
    plp.x = (if (lp.x + bs / 2 < sw / 2) lp.x else lp.x + bs - w).coerceIn(edge, Math.max(edge, sw - w - edge))
    plp.y = (if (lp.y + bs / 2 < sh / 2) lp.y + bs + gap else lp.y - h - gap).coerceIn(edge, Math.max(edge, sh - h - edge))
    try { wm.updateViewLayout(p, plp) } catch (e: Exception) {}
  }

  fun applyVisibility() {
    val show = !appFg
    bubble?.visibility = if (show) View.VISIBLE else View.GONE
    if (!show) { toastView?.visibility = View.GONE; handler.removeCallbacks(hideToast); closePanel() }    // the panel follows the bubble
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
    closePanel()
    bubble?.stop()
    try { bubble?.let { wm.removeView(it) } } catch (e: Exception) {}
    try { toastView?.let { wm.removeView(it) } } catch (e: Exception) {}
    bubble = null; toastView = null; inst = null
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null
}

// 56dp view: the launcher icon (circle crop, 40dp) + a state ring + a small chevron badge in the top-right corner (menu hit area, 18dp).
class BubbleView(c: Context) : View(c) {
  private val d = resources.displayMetrics.density
  private var mode = "idle"
  private var phase = 0f
  private var anim: ValueAnimator? = null
  private var up = false
  private val icon: Bitmap? = try {
    val dr = c.packageManager.getApplicationIcon(c.packageName)
    val s = (40 * d).toInt()
    Bitmap.createBitmap(s, s, Bitmap.Config.ARGB_8888).also { dr.setBounds(0, 0, s, s); dr.draw(Canvas(it)) }
  } catch (e: Exception) { null }
  private val clip = Path()
  private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
  private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeCap = Paint.Cap.ROUND }

  fun chevronHit(x: Float, y: Float) = x >= width - 18 * d && y <= 18 * d
  fun setPanelOpen(o: Boolean) { up = o; invalidate() }

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
    val cx = width / 2f; val cy = height / 2f; val ir = 20f * d; val rr = 24f * d
    // the app icon, cropped to a circle
    if (icon != null) {
      clip.reset(); clip.addCircle(cx, cy, ir, Path.Direction.CW)
      cv.save(); cv.clipPath(clip); cv.drawBitmap(icon, cx - ir, cy - ir, null); cv.restore()
    } else { fill.color = Color.parseColor("#9AA0A6"); fill.alpha = 255; cv.drawCircle(cx, cy, ir, fill) }
    // the state ring
    line.alpha = 255
    when (mode) {
      "listening" -> {                                        // pulsing blue: solid ring + a ring that grows and fades
        line.color = Color.parseColor("#2979FF"); line.strokeWidth = 3f * d; cv.drawCircle(cx, cy, rr, line)
        line.alpha = (150 * (1f - phase)).toInt(); line.strokeWidth = 2f * d; cv.drawCircle(cx, cy, rr + 3.5f * d * phase, line)
      }
      "thinking" -> {                                         // dark track + spinning white arc
        line.color = Color.parseColor("#CC1F1F1F"); line.strokeWidth = 3f * d; cv.drawCircle(cx, cy, rr, line)
        line.color = Color.WHITE; cv.drawArc(RectF(cx - rr, cy - rr, cx + rr, cy + rr), phase * 360f, 100f, false, line)
      }
      "speaking" -> {                                         // green ring + moving wave bars at the bottom of the icon
        line.color = Color.parseColor("#16A34A"); line.strokeWidth = 3f * d; cv.drawCircle(cx, cy, rr, line)
        val py = cy + ir * 0.62f
        fill.color = Color.parseColor("#16A34A"); fill.alpha = 255
        cv.drawRoundRect(RectF(cx - 15f * d, py - 6f * d, cx + 15f * d, py + 6f * d), 6f * d, 6f * d, fill)
        line.color = Color.WHITE; line.strokeWidth = 2f * d
        for (i in 0 until 5) {
          val h = (3f + 6f * Math.abs(Math.sin((phase * 2 * Math.PI) + i * 0.9))).toFloat() * d
          val x = cx + (i - 2) * 5.5f * d
          cv.drawLine(x, py - h / 2, x, py + h / 2, line)
        }
      }
      else -> { line.color = Color.parseColor("#9AA0A6"); line.strokeWidth = 1.5f * d; cv.drawCircle(cx, cy, rr, line) }   // idle: thin grey
    }
    // chevron badge (top-right): points down = closed, up = open
    val bx = width - 9f * d; val by = 9f * d
    fill.color = Color.parseColor("#E6202124"); fill.alpha = 230; cv.drawCircle(bx, by, 7f * d, fill)
    line.color = Color.WHITE; line.strokeWidth = 1.6f * d; line.alpha = 255
    val s = if (up) -1f else 1f
    cv.drawLine(bx - 3f * d, by - 1.5f * d * s, bx, by + 1.5f * d * s, line)
    cv.drawLine(bx, by + 1.5f * d * s, bx + 3f * d, by - 1.5f * d * s, line)
  }
}
