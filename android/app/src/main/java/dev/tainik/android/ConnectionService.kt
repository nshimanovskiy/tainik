package dev.tainik.android

import android.Manifest
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log

/**
 * Служба переднего плана: пока она работает, система не завершает процесс, и страница
 * в WebHost держит WebSocket с вашим сервером. Push-сервисы (Google и др.) не нужны.
 * Во время звонка служба объявляет микрофон и камеру — иначе Android 14+ отключит их,
 * если свернуть приложение.
 */
class ConnectionService : Service() {
    companion object {
        private const val TAG = "TainikService"
        private const val NOTIFICATION_ID = 100

        @Volatile
        var running = false
            private set

        @Volatile
        private var callPeer: String? = null

        private fun wanted(app: TainikApp) = app.prefs.background || callPeer != null

        /** Запустить или остановить службу по настройке и наличию звонка. */
        fun sync(ctx: Context) {
            val app = ctx.applicationContext as TainikApp
            val intent = Intent(app, ConnectionService::class.java)
            if (wanted(app)) {
                try {
                    app.startForegroundService(intent)
                } catch (e: Exception) {
                    // Android 12+ не даёт запускать службу из фона — запустим при открытии окна
                    Log.w(TAG, "не удалось запустить службу", e)
                }
            } else if (running) {
                app.stopService(intent)
            }
        }

        fun setCall(app: TainikApp, peer: String?) {
            if (callPeer == peer) return
            callPeer = peer
            sync(app)
        }

        /** Появились разрешения на микрофон или камеру — обновить типы службы. */
        fun refresh(app: TainikApp) {
            if (running && callPeer != null) sync(app)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        running = true
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val app = application as TainikApp
        try {
            goForeground()
        } catch (e: Exception) {
            Log.w(TAG, "служба не может работать на переднем плане", e)
            stopSelf()
            return START_NOT_STICKY
        }
        if (!wanted(app)) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
            return START_NOT_STICKY
        }
        app.host // поднять страницу, если приложение запущено без окна (после перезагрузки)
        return START_STICKY
    }

    override fun onDestroy() {
        running = false
        super.onDestroy()
        // Окна нет и фон выключили — страница больше не нужна
        val app = application as TainikApp
        if (app.hostIfCreated?.activity == null && !app.prefs.background) app.dropHost()
    }

    private fun granted(p: String) = checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private fun goForeground() {
        val peer = callPeer
        val n = Notifier.serviceNotification(this, peer)
        if (Build.VERSION.SDK_INT >= 34) {
            var type = ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            if (peer != null) {
                if (granted(Manifest.permission.RECORD_AUDIO)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                if (granted(Manifest.permission.CAMERA)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            }
            try {
                startForeground(NOTIFICATION_ID, n, type)
            } catch (e: SecurityException) {
                // Микрофон/камеру можно объявить только из открытого приложения
                startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            }
        } else {
            startForeground(NOTIFICATION_ID, n)
        }
    }
}

/** После перезагрузки телефона и после обновления приложения — снова на связи. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(ctx: Context, intent: Intent) {
        val app = ctx.applicationContext as TainikApp
        when (intent.action) {
            Intent.ACTION_BOOT_COMPLETED -> if (app.prefs.background && app.prefs.autostart) ConnectionService.sync(app)
            Intent.ACTION_MY_PACKAGE_REPLACED -> if (app.prefs.background) ConnectionService.sync(app)
        }
    }
}
