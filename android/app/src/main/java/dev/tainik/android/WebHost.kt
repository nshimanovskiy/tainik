package dev.tainik.android

import android.Manifest
import android.annotation.SuppressLint
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.MutableContextWrapper
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.JsResult
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import org.json.JSONObject

/**
 * WebView с общим интерфейсом Тайника. Живёт в приложении, а не в окне: окно (MainActivity)
 * только показывает его. Поэтому, когда окно закрыто, а работа в фоне включена, страница
 * продолжает работать — держит WebSocket, расшифровывает сообщения, принимает звонки.
 */
@SuppressLint("SetJavaScriptEnabled")
class WebHost(private val app: TainikApp) {
    companion object {
        const val HOST = "appassets.androidplatform.net"
        const val ORIGIN = "https://$HOST"
        private const val TAG = "Tainik"

        // Проверка соединения, пока приложение в фоне. Таймеры скрытой страницы
        // Chromium замедляет, поэтому будим её сами.
        private const val HEARTBEAT_MS = 4 * 60_000L
    }

    private val main = Handler(Looper.getMainLooper())
    private val ctx = MutableContextWrapper(app)
    private val assets = AssetServer(app.assets)
    val gallery = Gallery(app)
    val webView: WebView = WebView(ctx)
    val bridge = Bridge(app, this)

    /** Адрес загруженной страницы — мост работает только для нашей. */
    @Volatile
    var pageUrl = ""
        private set

    /** bridge.js загрузился и поздоровался. */
    @Volatile
    var bridgeReady = false

    /** Чат, который нужно открыть (нажали на уведомление). Страница забирает его сама. */
    @Volatile
    var pendingChat: String? = null

    /** Ответы, набранные в уведомлениях: (чат, текст). Страница забирает их сама, когда готова. */
    val pendingReplies = ArrayList<Triple<String, String, String>>() // чат, текст, id сообщения из уведомления

    var activity: MainActivity? = null
        private set

    private var destroyed = false
    private var netCallback: ConnectivityManager.NetworkCallback? = null

    private val heartbeat = object : Runnable {
        override fun run() {
            wake(false)
            main.postDelayed(this, HEARTBEAT_MS)
        }
    }

    init {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            mediaPlaybackRequiresUserGesture = false // звук собеседника и рингтон без нажатия
            javaScriptCanOpenWindowsAutomatically = false
            setSupportMultipleWindows(false)
            setGeolocationEnabled(false)
            // Размер интерфейса — как задуман: без увеличения шрифта системой (крупный шрифт в
            // настройках Android ломал вёрстку) и без масштабирования щипком
            textZoom = 100
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            // Отладочная сборка подключается к серверу разработчика по ws:// (без TLS)
            mixedContentMode =
                if (BuildConfig.DEBUG) WebSettings.MIXED_CONTENT_ALWAYS_ALLOW else WebSettings.MIXED_CONTENT_NEVER_ALLOW
        }
        // Процесс отрисовки страницы не должен терять приоритет, когда окно скрыто
        webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false)
        webView.setBackgroundColor(Theme.background(app))
        webView.webViewClient = Client()
        webView.webChromeClient = Chrome()
        webView.addJavascriptInterface(bridge, "TainikNative")
        webView.loadUrl("$ORIGIN/")
        watchNetwork()
        main.postDelayed(heartbeat, HEARTBEAT_MS)
    }

    fun isOurs(url: String?) = url != null && url.startsWith("$ORIGIN/")

    fun attach(a: MainActivity, parent: ViewGroup) {
        if (destroyed) return
        activity = a
        ctx.setBaseContext(a) // диалоги и запросы разрешений — от окна
        (webView.parent as? ViewGroup)?.removeView(webView)
        parent.addView(webView, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    }

    fun detach(a: MainActivity) {
        if (activity !== a) return
        (webView.parent as? ViewGroup)?.removeView(webView)
        ctx.setBaseContext(app)
        activity = null
    }

    /** Системная кнопка «Назад»: сначала страница (диалог, чат), иначе — уйти в фон. */
    fun back() {
        if (destroyed || !bridgeReady) {
            activity?.moveTaskToBack(true)
            return
        }
        webView.evaluateJavascript("(window.__tainikBack ? window.__tainikBack() : false)") { r ->
            if (r != "true") activity?.moveTaskToBack(true)
        }
    }

    /** Проверить соединение; restart — переподключиться (сменилась сеть). */
    fun wake(restart: Boolean) {
        if (destroyed || !bridgeReady) return
        webView.evaluateJavascript("window.__tainikWake && window.__tainikWake($restart)", null)
    }

    /** Приложение ушло в фон или вернулось на экран — страница сообщит серверу («в сети»). */
    fun setActive(active: Boolean) {
        if (destroyed || !bridgeReady) return
        webView.evaluateJavascript("window.__tainikActive && window.__tainikActive($active)", null)
    }

    /** Новое состояние обновления — в страницу (см. bridge.js updates.onChange). */
    fun pushUpdateState(st: org.json.JSONObject) {
        if (destroyed || !bridgeReady) return
        webView.evaluateJavascript("window.__tainikNative && __tainikNative.updState(${JSONObject.quote(st.toString())})", null)
    }

    /** Развернуть свёрнутый звонок (нажали на уведомление «Звонок: …»). */
    fun showCall() {
        if (!destroyed && bridgeReady) webView.evaluateJavascript("window.__tainikShowCall && window.__tainikShowCall()", null)
    }

    /** Ответ из уведомления — в страницу (она отправит его от нужного аккаунта). */
    fun sendReply(chat: String, text: String, msg: String = "") {
        synchronized(pendingReplies) {
            if (pendingReplies.size < 50) pendingReplies.add(Triple(chat, text, msg))
        }
        if (!destroyed && bridgeReady) webView.evaluateJavascript("window.__tainikNative && __tainikNative.deliverReplies && __tainikNative.deliverReplies()", null)
    }

    fun openChat(chat: String) {
        pendingChat = chat
        if (!destroyed && bridgeReady) webView.evaluateJavascript("window.__tainikNative && __tainikNative.deliver()", null)
    }

    /** Ответ на асинхронный вызов моста. text — JSON-текст результата или сообщение об ошибке. */
    fun reply(id: Int, ok: Boolean, text: String?) {
        main.post {
            if (destroyed) return@post
            val arg = if (text == null) "null" else JSONObject.quote(text)
            webView.evaluateJavascript("window.__tainikNative && __tainikNative.done($id, $ok, $arg)", null)
        }
    }

    fun destroy() {
        if (destroyed) return
        destroyed = true
        main.removeCallbacks(heartbeat)
        netCallback?.let {
            try {
                app.getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it)
            } catch (_: Exception) {
            }
        }
        (webView.parent as? ViewGroup)?.removeView(webView)
        activity = null
        webView.removeJavascriptInterface("TainikNative")
        webView.destroy()
    }

    // Сменилась сеть (Wi-Fi ↔ мобильная) — старое соединение могло «повиснуть»
    private fun watchNetwork() {
        val cm = app.getSystemService(ConnectivityManager::class.java)
        val cb = object : ConnectivityManager.NetworkCallback() {
            private var current: Network? = null
            private var lost = false

            override fun onAvailable(network: Network) {
                val changed = lost || (current != null && current != network)
                current = network
                lost = false
                if (changed) main.post { wake(true) }
            }

            override fun onLost(network: Network) {
                if (network == current) lost = true
            }
        }
        try {
            cm.registerDefaultNetworkCallback(cb)
            netCallback = cb
        } catch (e: Exception) {
            Log.w(TAG, "не удалось следить за сетью", e)
        }
    }

    private fun openExternal(intent: Intent) {
        try {
            val a = activity
            if (a != null) a.startActivity(intent)
            else app.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        } catch (_: ActivityNotFoundException) {
        }
    }

    private inner class Client : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val u = request.url
            if (u.scheme == "https" && u.host == HOST) {
                val path = u.path ?: "/"
                // Галерея телефона — только для самой страницы приложения
                if (path.startsWith(Gallery.PREFIX)) return if (isOurs(pageUrl)) gallery.serve(path, request.requestHeaders) else null
                return assets.serve(path)
            }
            return null
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val u = request.url
            if (u.scheme == "https" && u.host == HOST) return false
            // Любые другие ссылки — во внешнем браузере, а не внутри мессенджера
            if (request.isForMainFrame && request.hasGesture() && u.scheme in setOf("https", "http", "mailto")) {
                openExternal(Intent(Intent.ACTION_VIEW, u))
            }
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            pageUrl = url ?: ""
            bridgeReady = false
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            Log.e(TAG, "процесс страницы завершился (crash=${detail.didCrash()}), перезапускаем")
            if (view === webView) main.post { app.recreateHost() }
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        // Камера и микрофон для звонков: системное разрешение спрашиваем у пользователя
        override fun onPermissionRequest(request: PermissionRequest) {
            if (!isOurs(request.origin.toString())) {
                request.deny()
                return
            }
            val need = LinkedHashMap<String, String>() // ресурс страницы → разрешение Android
            for (r in request.resources) when (r) {
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> need[r] = Manifest.permission.RECORD_AUDIO
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> need[r] = Manifest.permission.CAMERA
            }
            if (need.isEmpty()) {
                request.deny()
                return
            }
            fun finish() {
                val granted = need.filterValues { app.checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }.keys
                if (granted.isEmpty()) request.deny() else request.grant(granted.toTypedArray())
                ConnectionService.refresh(app)
            }
            val missing = need.values.filter { app.checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }.distinct()
            val a = activity
            if (missing.isEmpty() || a == null) finish() else a.requestPermissionsThen(missing.toTypedArray()) { finish() }
        }

        override fun onJsAlert(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            val a = activity ?: return result.cancel().let { true }
            AlertDialog.Builder(a)
                .setMessage(message)
                .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                .setOnCancelListener { result.cancel() }
                .show()
            return true
        }

        override fun onJsConfirm(view: WebView, url: String?, message: String?, result: JsResult): Boolean {
            val a = activity ?: return result.cancel().let { true }
            AlertDialog.Builder(a)
                .setMessage(message)
                .setPositiveButton(android.R.string.ok) { _, _ -> result.confirm() }
                .setNegativeButton(android.R.string.cancel) { _, _ -> result.cancel() }
                .setOnCancelListener { result.cancel() }
                .show()
            return true
        }

        // Вложения: <input type="file"> открывает системный выбор файлов
        override fun onShowFileChooser(view: WebView, callback: ValueCallback<Array<Uri>>, params: WebChromeClient.FileChooserParams): Boolean {
            val a = activity
            if (a == null || !isOurs(pageUrl)) {
                callback.onReceiveValue(null)
                return true
            }
            val intent = Intent(Intent.ACTION_GET_CONTENT)
                .addCategory(Intent.CATEGORY_OPENABLE)
                .setType("*/*")
                .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.mode == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE)
            val started = a.startForResult(Intent.createChooser(intent, null)) { code, data ->
                if (code != android.app.Activity.RESULT_OK || data == null) return@startForResult callback.onReceiveValue(null)
                val uris = ArrayList<Uri>()
                data.clipData?.let { clip -> for (i in 0 until clip.itemCount) clip.getItemAt(i).uri?.let(uris::add) }
                if (uris.isEmpty()) data.data?.let(uris::add)
                callback.onReceiveValue(if (uris.isEmpty()) null else uris.toTypedArray())
            }
            if (!started) callback.onReceiveValue(null)
            return true
        }

        // Без этого WebView рисует серый значок «play» на видео до начала показа
        override fun getDefaultVideoPoster(): Bitmap = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)

        override fun onConsoleMessage(m: ConsoleMessage): Boolean {
            if (BuildConfig.DEBUG) Log.d(TAG, "${m.messageLevel()}: ${m.message()} (${m.sourceId()}:${m.lineNumber()})")
            return true
        }
    }
}
