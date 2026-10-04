package expo.modules.sheetservice

import android.content.Intent
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

// WHY THIS EXISTS: React Native freezes every JS timer (setTimeout / setInterval) while the app is in the background.
// The always-on Google listener restarts itself with setTimeout, so after the first sentence it never restarted and "tuik" was dead
// the moment you left the app. A running headless JS task tells React Native "JS work is going on": timers keep firing in the background.
// The task ("SheetKeepAlive", registered in App.tsx) never finishes on purpose. It lives and dies with SheetForegroundService.
class SheetKeepAliveService : HeadlessJsTaskService() {
  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? =
    HeadlessJsTaskConfig("SheetKeepAlive", Arguments.createMap(), 0L, true)      // timeout 0 = no limit, allowed while the app is in front
}
