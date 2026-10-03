package dev.tainik.android

import android.content.Context
import java.util.Locale

/**
 * Язык нативных текстов (уведомления, обновления). Страница переводится сама (shared/i18n.js)
 * и сохраняет выбор в настройках («lang»); без выбора — язык системы.
 */
object I18n {
    private val RU_LIKE = setOf("ru", "be", "uk", "kk", "ky", "uz", "tg", "hy", "az", "ka")

    fun isEn(ctx: Context): Boolean {
        val saved = PageSettings(ctx).get("lang")?.trim('"')
        if (saved == "ru" || saved == "en") return saved == "en"
        return Locale.getDefault().language !in RU_LIKE
    }

    /** Строка на языке пользователя. */
    fun tr(ctx: Context, ru: String, en: String): String = if (isEn(ctx)) en else ru
}
