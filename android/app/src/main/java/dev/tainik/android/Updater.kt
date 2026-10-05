package dev.tainik.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.Executors

/**
 * Самообновление: новая версия скачивается с вашего сервера (он ретранслирует релизы GitHub,
 * см. server/releases.js) и ставится системным установщиком Android.
 *
 * Подлинность гарантирует сам Android: обновление встанет, только если APK подписан тем же
 * ключом, что и установленное приложение. Поэтому взломанный сервер не может подсунуть свой
 * APK. Дополнительно сверяется sha256 из SHA256SUMS.txt выпуска (целостность загрузки).
 */
class Updater(private val app: TainikApp) {
    companion object {
        private const val TAG = "TainikUpdate"
        private const val CHECK_EVERY = 6 * 3600_000L
        private const val FIRST_CHECK = 20_000L
        private const val ACTION_RESULT = "dev.tainik.android.UPDATE_RESULT"
        private const val CH_UPDATES = "updates"
        private const val ID_READY = 3

        fun compare(a: String, b: String): Int {
            fun parse(v: String) = Regex("""^v?(\d+)\.(\d+)\.(\d+)""").find(v.trim())?.destructured?.toList()?.map { it.toInt() }
            val x = parse(a) ?: return 0
            val y = parse(b) ?: return 0
            for (i in 0..2) if (x[i] != y[i]) return x[i].compareTo(y[i])
            return 0
        }
    }

    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor { r -> Thread(r, "tainik-update") }
    private val dir = File(app.cacheDir, "updates")
    private val current = BuildConfig.VERSION_NAME.removeSuffix("-debug")

    // Отладочная сборка — другой пакет (.debug), ставить на неё выпуск нельзя
    private val supported = !BuildConfig.DEBUG

    @Volatile
    private var state = JSONObject().put("status", if (supported) "idle" else "unsupported").put("current", current).put("kind", "android")

    @Volatile
    private var readyFile: File? = null

    @Volatile
    private var readyVersion: String? = null

    @Volatile
    private var busy = false

    /** Вызывается при каждом изменении (из любого потока). */
    var onChange: ((JSONObject) -> Unit)? = null

    fun stateJson(): JSONObject = JSONObject(state.toString()).put("auto", app.prefs.autoUpdate)

    private fun set(vararg kv: Pair<String, Any?>) {
        val s = JSONObject(state.toString())
        for ((k, v) in kv) if (v == null) s.remove(k) else s.put(k, v)
        state = s
        val snapshot = stateJson()
        main.post { onChange?.invoke(snapshot) }
    }

    private val tick = object : Runnable {
        override fun run() {
            check(auto = true)
            main.postDelayed(this, CHECK_EVERY)
        }
    }

    fun start() {
        if (!supported) return
        createChannel()
        registerResultReceiver()
        main.postDelayed(tick, FIRST_CHECK)
    }

    // ---------- Сервер ----------

    /** https://сервер — из настроек страницы (адрес, к которому подключён мессенджер). */
    private fun base(): String? {
        val settings = PageSettings(app)
        fun unjson(v: String?): String? = try {
            v?.let { JSONObject("{\"v\":$it}").optString("v") }?.takeIf { it.isNotEmpty() }
        } catch (_: Exception) {
            null
        }
        var ws = unjson(settings.get("server"))
        if (ws == null) {
            ws = try {
                val list = org.json.JSONArray(unjson(settings.get("accounts")) ?: "[]")
                (0 until list.length()).map { list.getJSONObject(it).optString("server") }.firstOrNull { it.isNotEmpty() }
            } catch (_: Exception) {
                null
            }
        }
        if (ws == null) {
            ws = try {
                val cfg = app.assets.open("web/config.js").bufferedReader().use { it.readText() }
                Regex("\"defaultServer\":\\s*\"([^\"]+)\"").find(cfg)?.groupValues?.get(1)
            } catch (_: Exception) {
                null
            }
        }
        val u = try {
            Uri.parse(ws ?: return null)
        } catch (_: Exception) {
            return null
        }
        val scheme = when (u.scheme) {
            "wss" -> "https"
            "ws" -> "http"
            else -> return null
        }
        return "$scheme://${u.encodedAuthority}"
    }

    private fun open(url: String): HttpURLConnection {
        // Через тот же прокси, что и мессенджер (если включён)
        val c = URL(url).openConnection(app.proxy.javaProxy()) as HttpURLConnection
        c.connectTimeout = 15_000
        c.readTimeout = 30_000
        c.setRequestProperty("Cache-Control", "no-cache")
        if (c.responseCode !in 200..299) {
            val code = c.responseCode
            c.disconnect()
            throw IllegalStateException(I18n.tr(app, "сервер ответил ", "the server responded ") + code)
        }
        return c
    }

    private fun text(url: String): String = open(url).let { c -> try { c.inputStream.bufferedReader().use { it.readText() } } finally { c.disconnect() } }

    // ---------- Проверка и загрузка ----------

    fun check(auto: Boolean = false) {
        if (!supported || busy) return
        busy = true
        io.execute {
            try {
                doCheck(auto)
            } catch (e: Exception) {
                Log.w(TAG, "проверка обновлений", e)
                // Сервер недоступен, а обновление уже скачано — оно по-прежнему готово
                if (readyFile?.exists() == true) set("status" to "ready", "version" to readyVersion)
                else set("status" to "error", "error" to I18n.tr(app, "Не удалось проверить обновления: ", "Couldn’t check for updates: ") + e.message)
            } finally {
                busy = false
            }
        }
    }

    fun download() {
        if (!supported || busy) return
        busy = true
        io.execute {
            try {
                doCheck(auto = false)
            } catch (e: Exception) {
                set("status" to "error", "error" to I18n.tr(app, "Обновление не скачалось: ", "The update didn’t download: ") + e.message)
            } finally {
                busy = false
            }
        }
    }

    private fun doCheck(auto: Boolean) {
        val base = base() ?: return set("status" to "error", "error" to I18n.tr(app, "Не задан сервер", "No server is set"))
        // Обновление уже скачано — всё равно спрашиваем сервер: вдруг вышла версия ещё новее
        val ready = readyFile?.takeIf { it.exists() }
        if (ready == null) set("status" to "checking", "error" to null)
        val rel = JSONObject(text("$base/api/releases"))
        val version = rel.optString("version")
        val now = System.currentTimeMillis()
        if (ready != null) {
            val rv = readyVersion
            if (rv != null && compare(version, rv) <= 0) return set("status" to "ready", "version" to rv, "checkedAt" to now)
            ready.delete() // скачанное устарело — качаем новое
            readyFile = null
            readyVersion = null
        }
        if (compare(version, current) <= 0) return set("status" to "latest", "version" to version, "checkedAt" to now)
        val assets = rel.optJSONArray("assets") ?: org.json.JSONArray()
        val asset = (0 until assets.length()).map { assets.getJSONObject(it) }.firstOrNull { it.optString("platform") == "android" }
            ?: return set("status" to "manual", "version" to version, "downloadUrl" to "$base/?home#download", "reason" to I18n.tr(app, "В выпуске нет файла для Android", "The release has no Android file"), "checkedAt" to now)
        if (auto && !app.prefs.autoUpdate) return set("status" to "available", "version" to version, "checkedAt" to now)

        val name = asset.getString("name")
        require(Regex("^[A-Za-z0-9._-]+\\.apk$").matches(name)) { I18n.tr(app, "недопустимое имя файла", "invalid file name") }
        set("status" to "downloading", "version" to version, "progress" to 0.0)
        val sums = text("$base/download/SHA256SUMS.txt")
        val want = sums.lines().mapNotNull { Regex("^([0-9a-f]{64})\\s+\\*?(\\S+)$").find(it.trim())?.destructured }
            .firstOrNull { it.component2() == name }?.component1()
            ?: throw IllegalStateException(I18n.tr(app, "файла нет в списке контрольных сумм", "the file isn’t in the checksum list"))

        dir.mkdirs()
        dir.listFiles()?.forEach { it.delete() }
        val part = File(dir, "$name.part")
        val md = MessageDigest.getInstance("SHA-256")
        val c = open(base + asset.getString("url"))
        try {
            val total = c.contentLengthLong.takeIf { it > 0 } ?: asset.optLong("size")
            var got = 0L
            var last = 0L
            c.inputStream.use { input ->
                part.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        md.update(buf, 0, n)
                        got += n
                        val t = System.currentTimeMillis()
                        if (total > 0 && t - last > 300) {
                            last = t
                            set("progress" to got.toDouble() / total)
                        }
                    }
                }
            }
        } finally {
            c.disconnect()
        }
        val have = md.digest().joinToString("") { "%02x".format(it) }
        if (have != want) {
            part.delete()
            throw IllegalStateException(I18n.tr(app, "контрольная сумма не совпала — файл повреждён или подменён", "checksum mismatch — the file is damaged or was tampered with"))
        }
        val file = File(dir, name)
        part.renameTo(file)
        readyFile = file
        readyVersion = version
        set("status" to "ready", "version" to version, "progress" to 1.0)
        if (!app.inForeground) notifyReady(version)
    }

    // ---------- Установка ----------

    /** Запустить установку. Android покажет окно подтверждения. */
    fun install(): String {
        val file = readyFile ?: return "none"
        if (!file.exists()) {
            readyFile = null
            set("status" to "idle")
            return "none"
        }
        // Разрешение «Установка из этого источника» даёт пользователь в настройках
        if (!app.packageManager.canRequestPackageInstalls()) {
            val i = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${app.packageName}"))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            app.startActivity(i)
            return "permission"
        }
        set("status" to "installing")
        io.execute {
            try {
                val pi = app.packageManager.packageInstaller
                val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
                params.setAppPackageName(app.packageName)
                if (Build.VERSION.SDK_INT >= 31) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
                val id = pi.createSession(params)
                pi.openSession(id).use { s ->
                    s.openWrite("tainik.apk", 0, file.length()).use { out ->
                        file.inputStream().use { it.copyTo(out) }
                        s.fsync(out)
                    }
                    val intent = Intent(ACTION_RESULT).setPackage(app.packageName)
                    val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
                    s.commit(PendingIntent.getBroadcast(app, id, intent, flags).intentSender)
                }
            } catch (e: Exception) {
                Log.e(TAG, "установка", e)
                set("status" to "error", "error" to I18n.tr(app, "Не удалось начать установку: ", "Couldn’t start the install: ") + e.message)
            }
        }
        return "started"
    }

    private fun registerResultReceiver() {
        val r = object : BroadcastReceiver() {
            override fun onReceive(ctx: Context, intent: Intent) {
                when (val st = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
                    PackageInstaller.STATUS_PENDING_USER_ACTION -> {
                        @Suppress("DEPRECATION")
                        val confirm = intent.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)
                        confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)?.let { ctx.startActivity(it) }
                    }
                    PackageInstaller.STATUS_SUCCESS -> set("status" to "latest") // процесс сейчас перезапустится
                    PackageInstaller.STATUS_FAILURE_ABORTED -> set("status" to "ready") // нажали «Отмена»
                    PackageInstaller.STATUS_FAILURE_CONFLICT, PackageInstaller.STATUS_FAILURE_INCOMPATIBLE -> set(
                        "status" to "error",
                        "error" to I18n.tr(
                            app,
                            "Новая версия подписана другим ключом, чем установленная. Удалите Тайник и установите заново с сайта (перед этим привяжите аккаунт к другому устройству).",
                            "The new version is signed with a different key than the installed one. Uninstall Tainik and install it again from the website (link your account to another device first).",
                        ),
                    )
                    else -> set("status" to "error", "error" to I18n.tr(app, "Установка не удалась", "Install failed") + " (${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: st})")
                }
            }
        }
        val filter = IntentFilter(ACTION_RESULT)
        if (Build.VERSION.SDK_INT >= 33) {
            app.registerReceiver(r, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("UnspecifiedRegisterReceiverFlag")
            app.registerReceiver(r, filter)
        }
    }

    // ---------- Уведомление «обновление готово» ----------

    private fun createChannel() {
        val ch = NotificationChannel(CH_UPDATES, I18n.tr(app, "Обновления", "Updates"), NotificationManager.IMPORTANCE_DEFAULT).apply {
            setShowBadge(false)
        }
        app.getSystemService(NotificationManager::class.java).createNotificationChannel(ch)
    }

    private fun notifyReady(version: String) {
        if (Build.VERSION.SDK_INT >= 33 &&
            app.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED
        ) return
        val open = Intent(app, MainActivity::class.java)
            .setAction(MainActivity.ACTION_INSTALL_UPDATE)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        val pi = PendingIntent.getActivity(app, 7, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = Notification.Builder(app, CH_UPDATES)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(0xFF1F6F5C.toInt())
            .setContentTitle(I18n.tr(app, "Обновление Тайника ", "Tainik update ") + version)
            .setContentText(I18n.tr(app, "Нажмите, чтобы установить", "Tap to install"))
            .setContentIntent(pi)
            .setAutoCancel(true)
            .build()
        app.getSystemService(NotificationManager::class.java).notify(ID_READY, n)
    }
}
