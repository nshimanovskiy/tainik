package dev.tainik.android

import android.content.res.AssetManager
import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.io.IOException

/**
 * Отдаёт интерфейс из ассетов APK по адресу https://appassets.androidplatform.net/
 * (зарезервирован Google как раз для этого: запросы к нему не уходят в сеть).
 * Как и app:// в десктопе: код интерфейса не скачивается с сервера, поэтому
 * взломанный сервер не может подменить JavaScript и украсть ключи.
 */
class AssetServer(private val am: AssetManager) {
    companion object {
        const val BRIDGE_PATH = "/__native/bridge.js"

        // Та же политика, что у десктопа (desktop/lib.cjs)
        val CSP = listOf(
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self'",
            "img-src 'self' data: blob:",
            "media-src 'self' blob:", // фото и видео из вложений расшифровываются в blob:
            "connect-src ws: wss: https: http:", // адрес сервера выбирает пользователь; http(s) — вложения
            "object-src 'none'",
            "base-uri 'none'",
            "form-action 'none'",
            "frame-ancestors 'none'",
        ).joinToString("; ")

        private val MIME = mapOf(
            "html" to "text/html",
            "js" to "text/javascript",
            "css" to "text/css",
            "svg" to "image/svg+xml",
            "png" to "image/png",
            "json" to "application/json",
            "webmanifest" to "application/manifest+json",
        )
        private val TEXT = setOf("html", "js", "css", "svg", "json", "webmanifest")
    }

    fun serve(rawPath: String): WebResourceResponse {
        val path = if (rawPath.isEmpty() || rawPath == "/") "/index.html" else rawPath
        if (!path.startsWith("/") || path.contains("..") || path.contains('\\') || path.contains("//")) return notFound()
        val ext = path.substringAfterLast('.', "").lowercase()
        val mime = MIME[ext] ?: return notFound()
        val asset = if (path == BRIDGE_PATH) "native/bridge.js" else "web$path"
        return try {
            var bytes = am.open(asset).use { it.readBytes() }
            if (path == "/index.html") bytes = injectBridge(String(bytes, Charsets.UTF_8)).toByteArray(Charsets.UTF_8)
            WebResourceResponse(
                mime,
                if (ext in TEXT) "utf-8" else null,
                200,
                "OK",
                headers(),
                ByteArrayInputStream(bytes),
            )
        } catch (e: IOException) {
            notFound()
        }
    }

    /** Мост подключается первым, обычным (не module) скриптом — до app.js. */
    private fun injectBridge(html: String): String {
        val i = html.indexOf("<head>")
        if (i < 0) throw IOException("В index.html нет <head>")
        val at = i + "<head>".length
        return html.substring(0, at) + "\n  <script src=\"$BRIDGE_PATH\"></script>" + html.substring(at)
    }

    private fun headers() = mapOf(
        "Content-Security-Policy" to CSP,
        "X-Content-Type-Options" to "nosniff",
        "Referrer-Policy" to "no-referrer",
        "Cache-Control" to "no-cache",
    )

    private fun notFound() =
        WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers(), ByteArrayInputStream(ByteArray(0)))
}
