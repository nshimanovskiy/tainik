package dev.tainik.android

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build

/**
 * Системные уведомления. Текст сообщений показывается, только если пользователь включил
 * «Показывать текст» в настройках страницы; на заблокированном экране — без имени отправителя.
 */
object Notifier {
    private const val CH_MESSAGES = "messages"
    private const val CH_CALLS = "calls"
    const val CH_SERVICE = "service"
    private const val ID_MESSAGE = 1
    private const val ID_CALL = 2
    private const val TAG_CALL = "call"
    private const val BRAND = 0xFF1F6F5C.toInt()

    fun createChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val messages = NotificationChannel(CH_MESSAGES, "Сообщения", NotificationManager.IMPORTANCE_HIGH).apply {
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        }
        val calls = NotificationChannel(CH_CALLS, "Входящие звонки", NotificationManager.IMPORTANCE_HIGH).apply {
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
            setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build()
            )
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 800, 600, 800, 600)
        }
        val service = NotificationChannel(CH_SERVICE, "Работа в фоне", NotificationManager.IMPORTANCE_MIN).apply {
            description = "Значок, пока Тайник держит связь с сервером"
            setShowBadge(false)
        }
        nm.createNotificationChannels(listOf(messages, calls, service))
    }

    private fun canPost(ctx: Context) =
        Build.VERSION.SDK_INT < 33 ||
            ctx.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    /** Открыть приложение (и чат, если указан). */
    fun openIntent(ctx: Context, chat: String?, call: Boolean = false): PendingIntent {
        val i = Intent(ctx, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        if (!chat.isNullOrEmpty()) i.setAction(MainActivity.ACTION_OPEN_CHAT).putExtra(MainActivity.EXTRA_CHAT, chat)
        val code = if (chat.isNullOrEmpty()) 0 else (chat.hashCode() and 0x3fffffff) * 2 + (if (call) 1 else 0) + 2
        return PendingIntent.getActivity(ctx, code, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    fun show(app: TainikApp, title: String, body: String, chat: String, call: Boolean) {
        if (!canPost(app)) return
        // Окно открыто и в фокусе — о сообщениях не напоминаем (страница и так их показывает)
        if (!call && app.inForeground) return
        val nm = app.getSystemService(NotificationManager::class.java)
        val pi = openIntent(app, chat, call)
        val text = body.ifEmpty { if (call) "Входящий звонок" else "Новое сообщение" }
        val public = Notification.Builder(app, if (call) CH_CALLS else CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(BRAND)
            .setContentTitle("Тайник")
            .setContentText(if (call) "Входящий звонок" else "Новое сообщение")
            .build()
        val b = Notification.Builder(app, if (call) CH_CALLS else CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(BRAND)
            .setContentTitle(title)
            .setContentText(text)
            .setContentIntent(pi)
            .setAutoCancel(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(public)
        if (call) {
            b.setCategory(Notification.CATEGORY_CALL)
                .setFullScreenIntent(pi, true)
                .setOngoing(true)
                .setTimeoutAfter(45_000)
            val n = b.build()
            n.flags = n.flags or Notification.FLAG_INSISTENT // звонит, пока не ответят или не отменят
            nm.notify(TAG_CALL, ID_CALL, n)
        } else {
            b.setCategory(Notification.CATEGORY_MESSAGE)
            nm.notify("msg:$chat", ID_MESSAGE, b.build())
        }
    }

    fun cancelCall(ctx: Context) {
        ctx.getSystemService(NotificationManager::class.java).cancel(TAG_CALL, ID_CALL)
    }

    /** Приложение открыли — уведомления о сообщениях и звонке больше не нужны. */
    fun clearOnOpen(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        for (s in nm.activeNotifications) {
            val tag = s.tag ?: continue
            if (tag.startsWith("msg:") || tag == TAG_CALL) nm.cancel(tag, s.id)
        }
    }

    fun serviceNotification(ctx: Context, callPeer: String?): Notification {
        val b = Notification.Builder(ctx, CH_SERVICE)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(BRAND)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(openIntent(ctx, null))
        if (callPeer != null) {
            b.setContentTitle("Звонок: $callPeer").setContentText("Нажмите, чтобы вернуться к звонку")
                .setCategory(Notification.CATEGORY_CALL)
        } else {
            b.setContentTitle("Тайник на связи").setContentText("Получает сообщения и звонки, когда приложение закрыто")
                .setCategory(Notification.CATEGORY_SERVICE)
        }
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        return b.build()
    }
}
