package dev.tainik.android

import android.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Ответ, набранный прямо в уведомлении («Ответить»). Текст уходит в страницу (WebHost):
 * она зашифрует и отправит его от нужного аккаунта, как обычное сообщение. Если страница
 * ещё не загружена (процесс только что запустился), ответ подождёт в очереди.
 */
class ReplyReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION = "dev.tainik.android.REPLY"
        const val EXTRA_CHAT = "chat"
        const val EXTRA_TITLE = "title"
    }

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION) return
        val chat = intent.getStringExtra(EXTRA_CHAT)?.takeIf { it.isNotEmpty() && it.length <= 80 } ?: return
        val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notifier.KEY_REPLY)?.toString()?.trim().orEmpty()
        val title = intent.getStringExtra(EXTRA_TITLE).orEmpty()
        if (text.isEmpty()) {
            Notifier.cancelChat(context, chat)
            return
        }
        val app = context.applicationContext as TainikApp
        app.host.sendReply(chat, text.take(20_000))
        Notifier.replied(context, chat, title, text.take(200))
        // Пока страница загружается и отправляет, процесс должен жить: без работы в фоне его держит
        // только этот обработчик — даём ему несколько секунд
        val pending = goAsync()
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ pending.finish() }, 8_000)
    }
}
