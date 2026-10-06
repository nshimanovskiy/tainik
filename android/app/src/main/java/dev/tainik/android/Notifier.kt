package dev.tainik.android

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.graphics.drawable.Icon
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
        val messages = NotificationChannel(CH_MESSAGES, I18n.tr(ctx, "Сообщения", "Messages"), NotificationManager.IMPORTANCE_HIGH).apply {
            lockscreenVisibility = Notification.VISIBILITY_PRIVATE
        }
        val calls = NotificationChannel(CH_CALLS, I18n.tr(ctx, "Входящие звонки", "Incoming calls"), NotificationManager.IMPORTANCE_HIGH).apply {
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
        val service = NotificationChannel(CH_SERVICE, I18n.tr(ctx, "Работа в фоне", "Background"), NotificationManager.IMPORTANCE_MIN).apply {
            description = I18n.tr(ctx, "Значок, пока Тайник держит связь с сервером", "Shown while Tainik stays connected to the server")
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

    const val KEY_REPLY = "reply"

    /** Кнопка «Ответить» с полем ввода прямо в уведомлении — ответ получает ReplyReceiver. */
    private fun replyAction(ctx: Context, chat: String, title: String): Notification.Action {
        val label = I18n.tr(ctx, "Ответить", "Reply")
        val i = Intent(ctx, ReplyReceiver::class.java)
            .setAction(ReplyReceiver.ACTION)
            .putExtra(ReplyReceiver.EXTRA_CHAT, chat)
            .putExtra(ReplyReceiver.EXTRA_TITLE, title)
        // Поле ввода дописывает текст в Intent — поэтому PendingIntent изменяемый (Intent явный)
        val pi = PendingIntent.getBroadcast(ctx, (chat.hashCode() and 0x3fffffff), i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE)
        val input = RemoteInput.Builder(KEY_REPLY).setLabel(I18n.tr(ctx, "Сообщение", "Message")).build()
        return Notification.Action.Builder(Icon.createWithResource(ctx, R.drawable.ic_notification), label, pi)
            .addRemoteInput(input)
            .setAllowGeneratedReplies(false)
            .build()
    }

    /** Ответ отправлен из уведомления — показываем его вместо поля ввода и тихо убираем. */
    fun replied(ctx: Context, chat: String, title: String, text: String) {
        if (!canPost(ctx)) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        val n = Notification.Builder(ctx, CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(BRAND)
            .setContentTitle(title)
            .setContentText(I18n.tr(ctx, "Вы: ", "You: ") + text)
            .setContentIntent(openIntent(ctx, chat))
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setTimeoutAfter(8_000)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setCategory(Notification.CATEGORY_MESSAGE)
            .build()
        nm.notify("msg:$chat", ID_MESSAGE, n)
    }

    fun show(app: TainikApp, title: String, body: String, chat: String, call: Boolean, force: Boolean = false, reply: Boolean = false) {
        if (!canPost(app)) return
        // Окно открыто и в фокусе — о сообщениях не напоминаем (страница и так их показывает).
        // force — сообщение другому аккаунту: на экране его не видно, показываем.
        if (!call && !force && app.inForeground) return
        val nm = app.getSystemService(NotificationManager::class.java)
        val pi = openIntent(app, chat, call)
        val incoming = I18n.tr(app, "Входящий звонок", "Incoming call")
        val newMsg = I18n.tr(app, "Новое сообщение", "New message")
        val text = body.ifEmpty { if (call) incoming else newMsg }
        val public = Notification.Builder(app, if (call) CH_CALLS else CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(BRAND)
            .setContentTitle(I18n.tr(app, "Тайник", "Tainik"))
            .setContentText(if (call) incoming else newMsg)
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
            if (reply && chat.isNotEmpty()) b.addAction(replyAction(app, chat, title))
            nm.notify("msg:$chat", ID_MESSAGE, b.build())
        }
    }

    fun cancelCall(ctx: Context) {
        ctx.getSystemService(NotificationManager::class.java).cancel(TAG_CALL, ID_CALL)
    }

    /** Чат прочитан (на этом или другом устройстве) — убрать его уведомление. */
    fun cancelChat(ctx: Context, chat: String) {
        ctx.getSystemService(NotificationManager::class.java).cancel("msg:$chat", ID_MESSAGE)
    }

    /** Приложение открыли — уведомления о сообщениях и звонке больше не нужны. */
    fun clearOnOpen(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        for (s in nm.activeNotifications) {
            val tag = s.tag ?: continue
            if (tag.startsWith("msg:") || tag == TAG_CALL) nm.cancel(tag, s.id)
        }
    }

    /** Открыть приложение и развернуть идущий звонок. */
    private fun showCallIntent(ctx: Context): PendingIntent {
        val i = Intent(ctx, MainActivity::class.java)
            .setAction(MainActivity.ACTION_SHOW_CALL)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(ctx, 1, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    fun serviceNotification(ctx: Context, callPeer: String?): Notification {
        val b = Notification.Builder(ctx, CH_SERVICE)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(BRAND)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(if (callPeer != null) showCallIntent(ctx) else openIntent(ctx, null))
        if (callPeer != null) {
            b.setContentTitle(I18n.tr(ctx, "Звонок: ", "Call: ") + callPeer).setContentText(I18n.tr(ctx, "Нажмите, чтобы вернуться к звонку", "Tap to return to the call"))
                .setCategory(Notification.CATEGORY_CALL)
        } else {
            b.setContentTitle(I18n.tr(ctx, "Тайник на связи", "Tainik is connected")).setContentText(I18n.tr(ctx, "Получает сообщения и звонки, когда приложение закрыто", "Receives messages and calls when the app is closed"))
                .setCategory(Notification.CATEGORY_SERVICE)
        }
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        return b.build()
    }
}
