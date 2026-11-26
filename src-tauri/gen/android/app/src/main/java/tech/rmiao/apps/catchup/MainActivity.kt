package tech.rmiao.apps.catchup

import android.os.Bundle
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    applySystemBarInsets()
  }

  /**
   * Android WebView does not expose env(safe-area-inset-*) to CSS, so the web layer would
   * render under the status/navigation bars. Pad the content container instead: the window
   * background fills the bars and the whole web view stays inside the safe area. The IME
   * (soft keyboard) is folded into the bottom inset so bottom sheets stay above the keyboard.
   */
  private fun applySystemBarInsets() {
    val content = findViewById<View>(android.R.id.content) ?: return
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
      )
      val imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
      view.setPadding(
        bars.left,
        bars.top,
        bars.right,
        maxOf(bars.bottom, imeBottom)
      )
      WindowInsetsCompat.CONSUMED
    }
    ViewCompat.requestApplyInsets(content)
  }
}
