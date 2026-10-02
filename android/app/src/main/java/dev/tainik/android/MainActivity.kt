package dev.tainik.android

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.widget.FrameLayout
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher

/** Окно приложения. Показывает WebView из TainikApp.host — сама страница живёт дольше окна. */
class MainActivity : Activity() {
    companion object {
        const val ACTION_OPEN_CHAT = "dev.tainik.android.OPEN_CHAT"
        const val EXTRA_CHAT = "chat"
    }

    private lateinit var root: FrameLayout
    private val app get() = application as TainikApp
    private val permissionCallbacks = HashMap<Int, () -> Unit>()
    private var nextRequest = 100
    private var resumed = false
    private var focused = false
    private var backCallback: OnBackInvokedCallback? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        root = FrameLayout(this)
        if (Build.VERSION.SDK_INT >= 30) {
            // Рисуем под системными панелями сами и отступаем на их высоту (и на клавиатуру)
            window.setDecorFitsSystemWindows(false)
            root.setOnApplyWindowInsetsListener { v, insets ->
                val i = insets.getInsets(
                    WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout() or WindowInsets.Type.ime()
                )
                v.setPadding(i.left, i.top, i.right, i.bottom)
                WindowInsets.CONSUMED
            }
        }
        setContentView(root)
        applyColors()
        app.host.attach(this, root)
        if (Build.VERSION.SDK_INT >= 33) {
            val cb = OnBackInvokedCallback { app.host.back() }
            onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, cb)
            backCallback = cb
        }
        handleIntent(intent)
        ConnectionService.sync(this)
        askFirstRunPermissions()
    }

    /** Страницу пересоздали (упал процесс отрисовки) — показать новую. */
    fun reattach() {
        app.host.attach(this, root)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    private fun handleIntent(intent: Intent?) {
        if (intent == null || intent.action != ACTION_OPEN_CHAT) return
        val chat = intent.getStringExtra(EXTRA_CHAT)
        if (!chat.isNullOrEmpty()) app.host.openChat(chat)
        intent.action = Intent.ACTION_MAIN // не открывать чат повторно при пересоздании окна
    }

    @Deprecated("Android 12 и старше; в 13+ — OnBackInvokedCallback")
    @Suppress("OVERRIDE_DEPRECATION")
    override fun onBackPressed() {
        app.host.back()
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        updateForeground()
        Notifier.clearOnOpen(this)
        app.host.wake(false)
    }

    override fun onPause() {
        resumed = false
        updateForeground()
        super.onPause()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        focused = hasFocus
        updateForeground()
    }

    private fun updateForeground() {
        app.inForeground = resumed && focused
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        applyColors()
    }

    override fun onDestroy() {
        if (Build.VERSION.SDK_INT >= 33) backCallback?.let { onBackInvokedDispatcher.unregisterOnBackInvokedCallback(it) }
        app.hostIfCreated?.detach(this)
        // Окно закрыли совсем, а работа в фоне выключена — останавливаем страницу
        if (isFinishing && !ConnectionService.running) app.dropHost()
        super.onDestroy()
    }

    fun requestPermissionsThen(perms: Array<String>, then: () -> Unit) {
        val code = nextRequest++
        permissionCallbacks[code] = then
        requestPermissions(perms, code)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        permissionCallbacks.remove(requestCode)?.invoke()
    }

    // Первый запуск: разрешение на уведомления (Android 13+) и работа без ограничений батареи
    private fun askFirstRunPermissions() {
        val p = app.prefs
        val battery = {
            if (!p.askedBattery && p.background) {
                p.askedBattery = true
                Background.requestUnrestricted(this)
            }
        }
        if (Build.VERSION.SDK_INT >= 33 && !p.askedNotifications) {
            p.askedNotifications = true
            requestPermissionsThen(arrayOf(Manifest.permission.POST_NOTIFICATIONS)) { battery() }
        } else {
            battery()
        }
    }

    @Suppress("DEPRECATION")
    private fun applyColors() {
        val bg = Theme.background(this)
        val light = !Theme.isNight(this)
        root.setBackgroundColor(bg)
        window.setBackgroundDrawable(null)
        if (Build.VERSION.SDK_INT >= 30) {
            window.statusBarColor = Color.TRANSPARENT
            window.navigationBarColor = Color.TRANSPARENT
            val mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
            window.insetsController?.setSystemBarsAppearance(if (light) mask else 0, mask)
        } else {
            window.statusBarColor = bg
            window.navigationBarColor = bg
            var flags = window.decorView.systemUiVisibility and
                (View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR).inv()
            if (light) flags = flags or View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR or View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR
            window.decorView.systemUiVisibility = flags
        }
        app.hostIfCreated?.webView?.setBackgroundColor(bg)
    }
}
