package dev.tainik.android

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.webkit.JavascriptInterface
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Нативная половина window.desktop (вторая — assets/native/bridge.js).
 * Методы вызываются из JavaScript в отдельном потоке WebView. Работают только
 * для нашей страницы (https://appassets.androidplatform.net/): переход на чужие
 * адреса в WebView запрещён, а здесь это проверяется ещё раз.
 */
class Bridge(private val app: TainikApp, private val host: WebHost) {
    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "tainik-store") }
    private val main = Handler(Looper.getMainLooper())
    private val settings = PageSettings(app)

    private fun ours() = host.isOurs(host.pageUrl)

    @JavascriptInterface
    fun hello() {
        if (ours()) host.bridgeReady = true
    }

    /** Асинхронный вызов; ответ уходит в __tainikNative.done(id, ok, text). */
    @JavascriptInterface
    fun post(id: Int, method: String, args: String) {
        if (!ours()) return
        val a = try {
            JSONArray(args)
        } catch (e: Exception) {
            return host.reply(id, false, "Неверные аргументы")
        }
        when (method) {
            // Последний необязательный аргумент — хранилище аккаунта (пусто — основное)
            "storage.get" -> onIo(id) { app.storeFor(a.optString(1)).get(a.getString(0)) }
            "storage.set" -> onIo(id) { app.storeFor(a.optString(2)).set(a.getString(0), a.getString(1)); null }
            "storage.del" -> onIo(id) { app.storeFor(a.optString(1)).del(a.getString(0)); null }
            "storage.clear" -> onIo(id) { app.storeFor(a.optString(0)).clear(); null }
            "settings.get" -> onIo(id) { settings.get(a.getString(0)) }
            "settings.set" -> onIo(id) { settings.set(a.getString(0), a.getString(1)); null }
            "bg.get" -> onMain(id) { Background.state(app).toString() }
            "bg.set" -> onMain(id) { Background.set(app, host.activity, a.getString(0), a.getBoolean(1)); null }
            "version" -> host.reply(id, true, JSONObject.quote(BuildConfig.VERSION_NAME))
            else -> host.reply(id, false, "Неизвестный вызов: $method")
        }
    }

    @JavascriptInterface
    fun notify(json: String) {
        if (!ours()) return
        val n = try {
            JSONObject(json)
        } catch (e: Exception) {
            return
        }
        main.post {
            Notifier.show(
                app, n.optString("title", "Тайник"), n.optString("body"), n.optString("chat"),
                n.optBoolean("call"), n.optBoolean("force"),
            )
        }
    }

    @JavascriptInterface
    fun dismissNotice(json: String) {
        if (!ours()) return
        main.post { Notifier.cancelCall(app) }
    }

    @JavascriptInterface
    fun callActive(active: Boolean, peer: String) {
        if (!ours()) return
        main.post { ConnectionService.setCall(app, if (active) peer.ifEmpty { "собеседник" } else null) }
    }

    @JavascriptInterface
    fun setBadge(n: Int) {
        // Счётчик на значке Android рисует по уведомлениям сама система
    }

    @JavascriptInterface
    fun takePendingChat(): String {
        if (!ours()) return ""
        val chat = host.pendingChat ?: return ""
        host.pendingChat = null
        return chat
    }

    private fun onIo(id: Int, block: () -> String?) = io.execute { finish(id, block) }

    private fun onMain(id: Int, block: () -> String?) = main.post { finish(id, block) }

    private fun finish(id: Int, block: () -> String?) {
        try {
            host.reply(id, true, block())
        } catch (e: Exception) {
            Log.w("Tainik", "ошибка вызова моста", e)
            host.reply(id, false, e.message ?: e.javaClass.simpleName)
        }
    }
}

/** Работа в фоне: постоянное соединение (ConnectionService) и запуск после перезагрузки. */
object Background {
    fun state(app: TainikApp): JSONObject = JSONObject()
        .put("tray", app.prefs.background)
        .put("autostart", app.prefs.autostart)
        .put("autostartSupported", true)
        .put("batteryOptimized", !ignoringBatteryOptimizations(app))

    fun set(app: TainikApp, activity: Activity?, key: String, value: Boolean) {
        when (key) {
            "tray" -> {
                app.prefs.background = value
                ConnectionService.sync(app)
                if (value) requestUnrestricted(activity)
            }
            "autostart" -> app.prefs.autostart = value
            else -> throw IllegalArgumentException("Неизвестная настройка: $key")
        }
    }

    fun ignoringBatteryOptimizations(ctx: Context): Boolean =
        ctx.getSystemService(PowerManager::class.java).isIgnoringBatteryOptimizations(ctx.packageName)

    /**
     * Просит разрешить работу без ограничений батареи: иначе в режиме сна (Doze) система
     * отключает приложению сеть, и сообщения приходят с большой задержкой.
     * Приложение распространяется не через Google Play, так что прямой запрос допустим.
     */
    @SuppressLint("BatteryLife")
    fun requestUnrestricted(activity: Activity?) {
        if (activity == null || ignoringBatteryOptimizations(activity)) return
        try {
            activity.startActivity(
                Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + activity.packageName))
            )
        } catch (_: ActivityNotFoundException) {
        }
    }
}
