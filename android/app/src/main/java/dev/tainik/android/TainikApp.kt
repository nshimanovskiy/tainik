package dev.tainik.android

import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.content.res.Configuration

/**
 * Приложение держит единственный WebView с интерфейсом (WebHost). Он живёт дольше окна:
 * пока включена работа в фоне, ConnectionService не даёт системе завершить процесс,
 * и страница продолжает получать сообщения и звонки по своему WebSocket.
 */
class TainikApp : Application() {
    lateinit var store: SecureStore
        private set
    lateinit var prefs: Prefs
        private set
    lateinit var updater: Updater
        private set

    private var hostRef: WebHost? = null
    private val extraStores = HashMap<String, SecureStore>()

    /** Хранилище аккаунта: основной — store, дополнительные — store-<ns>. Только из потока моста. */
    @Synchronized
    fun storeFor(ns: String?): SecureStore {
        if (ns.isNullOrEmpty()) return store
        require(Regex("^[a-z0-9]{1,16}$").matches(ns)) { "Неверное имя хранилища" }
        return extraStores.getOrPut(ns) { SecureStore(noBackupFilesDir, "store-$ns") }
    }

    /** WebView с интерфейсом. Создаётся при первом обращении (только из главного потока). */
    val host: WebHost
        get() = hostRef ?: WebHost(this).also { hostRef = it }

    val hostIfCreated: WebHost?
        get() = hostRef

    /** Окно на экране и в фокусе — уведомления о сообщениях не нужны (как в десктопе). */
    var inForeground = false

    override fun onCreate() {
        super.onCreate()
        store = SecureStore(noBackupFilesDir)
        prefs = Prefs(this)
        Notifier.createChannels(this)
        updater = Updater(this).also { u ->
            u.onChange = { st -> hostRef?.pushUpdateState(st) }
            u.start()
        }
    }

    /** Закрыть страницу совсем: окно закрыто, а работа в фоне выключена. */
    fun dropHost() {
        hostRef?.destroy()
        hostRef = null
    }

    /** Процесс отрисовки WebView упал — создаём страницу заново и возвращаем её в окно. */
    fun recreateHost() {
        val old = hostRef ?: return
        val activity = old.activity
        old.destroy()
        hostRef = null
        if (activity != null) activity.reattach() else if (ConnectionService.running) host
    }
}

/** Настройки приложения (не страницы). */
class Prefs(ctx: Context) {
    private val sp: SharedPreferences = ctx.getSharedPreferences("app", Context.MODE_PRIVATE)

    /** Работа в фоне — по умолчанию включена, как «трей» в десктопе. */
    var background: Boolean
        get() = sp.getBoolean("background", true)
        set(v) = sp.edit().putBoolean("background", v).apply()

    var autostart: Boolean
        get() = sp.getBoolean("autostart", true)
        set(v) = sp.edit().putBoolean("autostart", v).apply()

    var askedNotifications: Boolean
        get() = sp.getBoolean("asked-notifications", false)
        set(v) = sp.edit().putBoolean("asked-notifications", v).apply()

    /** Скачивать обновления автоматически (ставит их всё равно пользователь — так требует Android). */
    var autoUpdate: Boolean
        get() = sp.getBoolean("auto-update", true)
        set(v) = sp.edit().putBoolean("auto-update", v).apply()

    var askedBattery: Boolean
        get() = sp.getBoolean("asked-battery", false)
        set(v) = sp.edit().putBoolean("asked-battery", v).apply()
}

object Theme {
    fun isNight(ctx: Context): Boolean =
        (ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES

    /** Цвет фона страницы (--bg в style.css) — чтобы не мигало белым при запуске. */
    fun background(ctx: Context): Int = if (isNight(ctx)) 0xFF111513.toInt() else 0xFFF3F1EC.toInt()
}
