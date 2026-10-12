package dev.tainik.android

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import java.util.Locale

/**
 * Озвучка сообщений голосом системы (TextToSpeech): в WebView нет speechSynthesis.
 * Все вызовы — в главном потоке. Ответ на speak приходит, когда текст дочитан
 * ("true"), остановлен ("false") или озвучить нельзя (ошибка tts_*).
 */
class Speech(private val ctx: Context, private val reply: (Int, Boolean, String?) -> Unit) {
    private val main = Handler(Looper.getMainLooper())
    private var tts: TextToSpeech? = null
    private var status: Int? = null // null — движок ещё запускается
    private val queued = ArrayList<() -> Unit>()
    private var currentId = 0

    private val listener = object : UtteranceProgressListener() {
        override fun onStart(utteranceId: String?) {}
        override fun onDone(utteranceId: String?) = main.post { finish(utteranceId, true, "true") }.let {}
        @Deprecated("Deprecated in Java")
        override fun onError(utteranceId: String?) = main.post { finish(utteranceId, false, "tts_failed") }.let {}
        override fun onError(utteranceId: String?, errorCode: Int) = main.post { finish(utteranceId, false, "tts_failed") }.let {}
    }

    private fun finish(utteranceId: String?, ok: Boolean, text: String) {
        val id = currentId
        if (id == 0 || utteranceId != "u$id") return
        currentId = 0
        reply(id, ok, text)
    }

    private fun withTts(block: (TextToSpeech?) -> Unit) {
        val t = tts
        if (t != null && status != null) return block(if (status == TextToSpeech.SUCCESS) t else null)
        queued.add { block(if (status == TextToSpeech.SUCCESS) tts else null) }
        if (t == null) {
            tts = TextToSpeech(ctx.applicationContext) { st ->
                status = st
                tts?.setOnUtteranceProgressListener(listener)
                val q = queued.toList()
                queued.clear()
                q.forEach { it() }
            }
        }
    }

    /** Остановить то, что читается сейчас: его speak получит "false". */
    private fun stopCurrent() {
        val old = currentId
        if (old == 0) return
        currentId = 0
        tts?.stop()
        reply(old, true, "false")
    }

    fun speak(id: Int, text: String, lang: String) = withTts { t ->
        if (t == null) return@withTts reply(id, false, "tts_unavailable")
        stopCurrent()
        if (lang.isNotBlank()) {
            val r = t.setLanguage(Locale.forLanguageTag(lang))
            if (r == TextToSpeech.LANG_MISSING_DATA || r == TextToSpeech.LANG_NOT_SUPPORTED) return@withTts reply(id, false, "tts_no_voice")
        }
        // Длинный текст — частями (у движка есть предел на одну фразу)
        val max = (TextToSpeech.getMaxSpeechInputLength() - 1).coerceAtLeast(100)
        val parts = text.chunked(max).ifEmpty { listOf(" ") }
        currentId = id
        parts.forEachIndexed { i, p ->
            val mode = if (i == 0) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
            val utt = if (i == parts.lastIndex) "u$id" else "p$id.$i"
            if (t.speak(p, mode, null, utt) != TextToSpeech.SUCCESS) {
                currentId = 0
                t.stop()
                return@withTts reply(id, false, "tts_failed")
            }
        }
    }

    fun stop() = withTts { stopCurrent() }

    fun shutdown() {
        stopCurrent()
        tts?.shutdown()
        tts = null
        status = null
    }
}
