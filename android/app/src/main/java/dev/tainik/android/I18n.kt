package dev.tainik.android

import android.content.Context
import java.util.Locale

/**
 * Язык нативных текстов (уведомления, обновления). Страница переводится сама (shared/i18n.js)
 * и сохраняет выбор в настройках («lang»); без выбора — язык системы.
 * Тексты в коде — по-русски и по-английски; испанский и японский берутся из словарей ниже
 * по английскому тексту (нет перевода — английский).
 */
object I18n {
    private val RU_LIKE = setOf("ru", "be", "uk", "kk", "ky", "uz", "tg", "hy", "az", "ka")
    private val LANGS = setOf("ru", "en", "es", "ja")

    /** Язык: "ru", "en", "es" или "ja". */
    fun lang(ctx: Context): String {
        val saved = PageSettings(ctx).get("lang")?.trim('"')
        if (saved != null && saved in LANGS) return saved
        val sys = Locale.getDefault().language
        return when {
            sys in RU_LIKE -> "ru"
            sys == "es" -> "es"
            sys == "ja" -> "ja"
            else -> "en"
        }
    }

    fun isEn(ctx: Context): Boolean = lang(ctx) != "ru"

    /** Строка на языке пользователя. */
    fun tr(ctx: Context, ru: String, en: String): String = when (lang(ctx)) {
        "ru" -> ru
        "es" -> ES[en] ?: en
        "ja" -> JA[en] ?: en
        else -> en
    }

    private val ES = mapOf(
        "The new version is signed with a different key than the installed one. Uninstall Tainik and install it again from the website (link your account to another device first)." to "La nueva versión está firmada con una clave distinta a la de la instalada. Desinstala Tainik e instálalo de nuevo desde el sitio web (antes vincula tu cuenta a otro dispositivo).",
        "the server responded " to "el servidor respondió ",
        "Couldn’t check for updates: " to "No se pudieron buscar actualizaciones: ",
        "The update didn’t download: " to "La actualización no se descargó: ",
        "No server is set" to "No hay servidor configurado",
        "The release has no Android file" to "La versión no incluye un archivo para Android",
        "invalid file name" to "nombre de archivo no válido",
        "the file isn’t in the checksum list" to "el archivo no está en la lista de sumas de verificación",
        "checksum mismatch — the file is damaged or was tampered with" to "la suma de verificación no coincide — el archivo está dañado o ha sido manipulado",
        "Couldn’t start the install: " to "No se pudo iniciar la instalación: ",
        "Install failed" to "La instalación falló",
        "Updates" to "Actualizaciones",
        "Tainik update " to "Actualización de Tainik ",
        "Tap to install" to "Toca para instalar",
        "Messages" to "Mensajes",
        "Incoming calls" to "Llamadas entrantes",
        "Background" to "Segundo plano",
        "Shown while Tainik stays connected to the server" to "Se muestra mientras Tainik mantiene la conexión con el servidor",
        "Reply" to "Responder",
        "Message" to "Mensaje",
        "You: " to "Tú: ",
        "Incoming call" to "Llamada entrante",
        "New message" to "Mensaje nuevo",
        "Tainik" to "Tainik",
        "Call: " to "Llamada: ",
        "Tap to return to the call" to "Toca para volver a la llamada",
        "Tainik is connected" to "Tainik conectado",
        "Receives messages and calls when the app is closed" to "Recibe mensajes y llamadas con la app cerrada",
        "contact" to "contacto",
    )

    private val JA = mapOf(
        "The new version is signed with a different key than the installed one. Uninstall Tainik and install it again from the website (link your account to another device first)." to "新しいバージョンは、インストール済みのものとは異なる鍵で署名されています。Tainikをアンインストールし、ウェブサイトから再インストールしてください（その前にアカウントを別の端末にリンクしてください）。",
        "the server responded " to "サーバーの応答: ",
        "Couldn’t check for updates: " to "アップデートを確認できませんでした：",
        "The update didn’t download: " to "アップデートをダウンロードできませんでした：",
        "No server is set" to "サーバーが設定されていません",
        "The release has no Android file" to "リリースにAndroid用のファイルがありません",
        "invalid file name" to "無効なファイル名",
        "the file isn’t in the checksum list" to "ファイルがチェックサムの一覧にありません",
        "checksum mismatch — the file is damaged or was tampered with" to "チェックサムが一致しません — ファイルが破損しているか、改ざんされています",
        "Couldn’t start the install: " to "インストールを開始できませんでした：",
        "Install failed" to "インストールに失敗しました",
        "Updates" to "アップデート",
        "Tainik update " to "Tainikのアップデート ",
        "Tap to install" to "タップしてインストール",
        "Messages" to "メッセージ",
        "Incoming calls" to "着信",
        "Background" to "バックグラウンド動作",
        "Shown while Tainik stays connected to the server" to "Tainikがサーバーとの接続を維持している間に表示されます",
        "Reply" to "返信",
        "Message" to "メッセージ",
        "You: " to "あなた: ",
        "Incoming call" to "着信",
        "New message" to "新しいメッセージ",
        "Tainik" to "Tainik",
        "Call: " to "通話: ",
        "Tap to return to the call" to "タップして通話に戻る",
        "Tainik is connected" to "Tainik 接続中",
        "Receives messages and calls when the app is closed" to "アプリを閉じていてもメッセージと通話を受信します",
        "contact" to "相手",
    )
}
