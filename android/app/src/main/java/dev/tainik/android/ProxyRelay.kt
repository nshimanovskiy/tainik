package dev.tainik.android

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ServerSocket
import java.net.Socket
import java.util.Base64
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/**
 * Подключение через прокси (SOCKS5 или HTTP, с логином и паролем или без).
 *
 * WebView (Chromium) не умеет SOCKS5 с паролем, поэтому приложение поднимает на 127.0.0.1
 * маленький ретранслятор: WebView ходит в него как в HTTP-прокси (CONNECT host:port — так идут
 * wss:// и https://), а ретранслятор открывает соединение через прокси пользователя — уже с
 * логином и паролем. Внутри туннеля по-прежнему TLS до сервера Тайника.
 * Та же логика на Node — desktop/proxy.cjs.
 */
data class ProxyCfg(
    val enabled: Boolean = false,
    val type: String = "socks5",
    val host: String = "",
    val port: Int = 0,
    val user: String = "",
    val pass: String = "",
) {
    companion object {
        private val HOST_RE = Regex("^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$|^[0-9A-Fa-f:.]+$")

        /** Настройки со страницы; pass = null — оставить прежний. Бросает ProxyException("proxy_bad"). */
        fun from(j: JSONObject, oldPass: String): ProxyCfg {
            val host = j.optString("host").trim().removePrefix("[").removeSuffix("]")
            val port = j.optInt("port", 0)
            val enabled = j.optBoolean("enabled", false)
            val pass = if (j.has("pass") && !j.isNull("pass")) j.optString("pass") else oldPass
            val user = j.optString("user")
            if (enabled || host.isNotEmpty()) {
                if (host.length > 253 || !HOST_RE.matches(host)) throw ProxyException("proxy_bad")
                if (port !in 1..65535) throw ProxyException("proxy_bad")
            }
            if (user.toByteArray().size > 255 || pass.toByteArray().size > 255) throw ProxyException("proxy_bad")
            return ProxyCfg(enabled, if (j.optString("type") == "http") "http" else "socks5", host, port.coerceIn(0, 65535), user, pass)
        }
    }

    fun publicJson(active: Boolean, supported: Boolean): JSONObject = JSONObject()
        .put("enabled", enabled).put("type", type).put("host", host).put("port", port)
        .put("user", user).put("hasPass", pass.isNotEmpty()).put("active", active).put("supported", supported)
}

/** message — код для страницы: proxy_unreachable, proxy_auth, proxy_refused, proxy_bad, proxy_timeout. */
class ProxyException(code: String) : IOException(code)

object Tunnel {
    private const val TIMEOUT = 15_000

    /** Соединение с host:port через прокси пользователя (рукопожатие уже пройдено). */
    fun open(cfg: ProxyCfg, host: String, port: Int): Socket {
        val s = Socket()
        try {
            try {
                s.connect(InetSocketAddress(cfg.host, cfg.port), TIMEOUT)
            } catch (e: IOException) {
                throw ProxyException(if (e is java.net.SocketTimeoutException) "proxy_timeout" else "proxy_unreachable")
            }
            s.soTimeout = TIMEOUT
            val out = s.getOutputStream()
            val inp = DataInputStream(s.getInputStream())
            if (cfg.type == "http") http(cfg, host, port, out, inp) else socks5(cfg, host, port, out, inp)
            s.soTimeout = 0
            return s
        } catch (e: Exception) {
            try {
                s.close()
            } catch (_: Exception) {
            }
            if (e is ProxyException) throw e
            if (e is java.net.SocketTimeoutException) throw ProxyException("proxy_timeout")
            throw ProxyException("proxy_refused")
        }
    }

    private fun socks5(cfg: ProxyCfg, host: String, port: Int, out: OutputStream, inp: DataInputStream) {
        val auth = cfg.user.isNotEmpty() || cfg.pass.isNotEmpty()
        out.write(if (auth) byteArrayOf(5, 2, 0, 2) else byteArrayOf(5, 1, 0))
        out.flush()
        if (inp.readUnsignedByte() != 5) throw ProxyException("proxy_bad")
        when (inp.readUnsignedByte()) {
            0 -> Unit
            2 -> {
                val u = cfg.user.toByteArray()
                val p = cfg.pass.toByteArray()
                val b = ByteArrayOutputStream()
                b.write(1)
                b.write(u.size)
                b.write(u)
                b.write(p.size)
                b.write(p)
                out.write(b.toByteArray())
                out.flush()
                inp.readUnsignedByte()
                if (inp.readUnsignedByte() != 0) throw ProxyException("proxy_auth")
            }
            0xFF -> throw ProxyException(if (auth) "proxy_refused" else "proxy_auth")
            else -> throw ProxyException("proxy_bad")
        }
        val h = host.toByteArray()
        val b = ByteArrayOutputStream()
        b.write(byteArrayOf(5, 1, 0, 3, h.size.toByte()))
        b.write(h)
        b.write(port shr 8)
        b.write(port and 255)
        out.write(b.toByteArray())
        out.flush()
        if (inp.readUnsignedByte() != 5) throw ProxyException("proxy_bad")
        if (inp.readUnsignedByte() != 0) throw ProxyException("proxy_refused")
        inp.readUnsignedByte()
        val len = when (inp.readUnsignedByte()) {
            1 -> 4
            4 -> 16
            3 -> inp.readUnsignedByte()
            else -> throw ProxyException("proxy_bad")
        }
        inp.readFully(ByteArray(len + 2))
    }

    private fun http(cfg: ProxyCfg, host: String, port: Int, out: OutputStream, inp: InputStream) {
        val sb = StringBuilder("CONNECT $host:$port HTTP/1.1\r\nHost: $host:$port\r\n")
        if (cfg.user.isNotEmpty() || cfg.pass.isNotEmpty()) {
            val token = Base64.getEncoder().encodeToString("${cfg.user}:${cfg.pass}".toByteArray())
            sb.append("Proxy-Authorization: Basic ").append(token).append("\r\n")
        }
        sb.append("\r\n")
        out.write(sb.toString().toByteArray(Charsets.ISO_8859_1))
        out.flush()
        val head = readHead(inp)
        val code = Regex("^HTTP/1\\.[01] (\\d{3})").find(head)?.groupValues?.get(1)?.toIntOrNull()
        if (code == 407) throw ProxyException("proxy_auth")
        if (code != 200) throw ProxyException("proxy_refused")
    }

    /** Заголовки HTTP до пустой строки — по байту, чтобы не прочитать лишнего. */
    fun readHead(inp: InputStream, max: Int = 8192): String {
        val b = ByteArrayOutputStream()
        var tail = 0
        while (true) {
            val c = inp.read()
            if (c < 0) throw ProxyException("proxy_refused")
            b.write(c)
            tail = (tail shl 8) or c
            if (tail == 0x0D0A0D0A) return b.toString("ISO-8859-1")
            if (b.size() > max) throw ProxyException("proxy_bad")
        }
    }
}

/** Локальный ретранслятор на 127.0.0.1: принимает CONNECT от WebView и открывает туннель. */
class ProxyRelay(private val upstream: () -> ProxyCfg) {
    private val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    private val pool = Executors.newCachedThreadPool { r -> Thread(r, "tainik-proxy").apply { isDaemon = true } }

    @Volatile
    private var closed = false

    val port: Int get() = server.localPort

    fun start(): ProxyRelay {
        pool.execute {
            while (!closed) {
                val c = try {
                    server.accept()
                } catch (_: IOException) {
                    break
                }
                pool.execute { handle(c) }
            }
        }
        return this
    }

    fun close() {
        closed = true
        try {
            server.close()
        } catch (_: IOException) {
        }
        pool.shutdownNow()
    }

    private fun handle(client: Socket) {
        var up: Socket? = null
        try {
            client.soTimeout = 15_000
            val head = Tunnel.readHead(client.getInputStream())
            val m = Regex("^CONNECT (\\[[0-9A-Fa-f:.]+\\]|[^\\s:]+):(\\d{1,5}) HTTP/1\\.[01]\r\n").find(head)
            val port = m?.groupValues?.get(2)?.toIntOrNull() ?: 0
            if (m == null || port !in 1..65535) {
                client.getOutputStream().write("HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                client.close()
                return
            }
            val host = m.groupValues[1].removePrefix("[").removeSuffix("]")
            val tunnel: Socket = try {
                Tunnel.open(upstream(), host, port)
            } catch (e: ProxyException) {
                Log.w("TainikProxy", "туннель не открылся: ${e.message}")
                client.getOutputStream().write("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                client.close()
                return
            }
            up = tunnel
            client.soTimeout = 0
            client.getOutputStream().write("HTTP/1.1 200 Connection Established\r\n\r\n".toByteArray())
            pool.execute { copy(tunnel.getInputStream(), client.getOutputStream(), client, tunnel) }
            copy(client.getInputStream(), tunnel.getOutputStream(), tunnel, client)
        } catch (_: Exception) {
            closeQuietly(client)
            up?.let { closeQuietly(it) }
        }
    }

    private fun copy(from: InputStream, to: OutputStream, toSock: Socket, fromSock: Socket) {
        val buf = ByteArray(32 * 1024)
        try {
            while (true) {
                val n = from.read(buf)
                if (n < 0) break
                to.write(buf, 0, n)
                to.flush()
            }
        } catch (_: IOException) {
        } finally {
            closeQuietly(toSock)
            closeQuietly(fromSock)
        }
    }

    private fun closeQuietly(s: Socket) {
        try {
            s.close()
        } catch (_: IOException) {
        }
    }
}

/**
 * Настройки прокси приложения: хранение (пароль — в зашифрованном хранилище), запуск
 * ретранслятора и подмена прокси у WebView (androidx.webkit ProxyController).
 */
class ProxyManager(private val app: Context) {
    private val sp = app.getSharedPreferences("proxy", Context.MODE_PRIVATE)
    private val secret = SecureStore(app.noBackupFilesDir, "proxy")
    private val main = Handler(Looper.getMainLooper())
    private val mainExec = Executor { main.post(it) }

    @Volatile
    var cfg: ProxyCfg = load()
        private set

    @Volatile
    private var relay: ProxyRelay? = null

    val supported: Boolean
        get() = try {
            WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)
        } catch (_: Throwable) {
            false
        }

    private fun load(): ProxyCfg {
        val pass = try {
            secret.get("pass")?.let { JSONObject("{\"v\":$it}").optString("v") } ?: ""
        } catch (_: Exception) {
            ""
        }
        return ProxyCfg(
            sp.getBoolean("enabled", false),
            sp.getString("type", "socks5") ?: "socks5",
            sp.getString("host", "") ?: "",
            sp.getInt("port", 0),
            sp.getString("user", "") ?: "",
            pass,
        )
    }

    fun stateJson(): JSONObject = cfg.publicJson(relay != null, supported)

    /** Сохранить и применить. Вызывать не из главного потока (запись на диск). */
    fun save(next: ProxyCfg) {
        sp.edit().putBoolean("enabled", next.enabled).putString("type", next.type).putString("host", next.host)
            .putInt("port", next.port).putString("user", next.user).commit()
        if (next.pass.isEmpty()) secret.del("pass") else secret.set("pass", JSONObject.quote(next.pass))
        cfg = next
        apply()
    }

    /** Запустить или остановить ретранслятор и сообщить WebView. */
    fun apply() {
        relay?.close()
        relay = null
        val c = cfg
        if (c.enabled && c.host.isNotEmpty() && supported) {
            val r = ProxyRelay { cfg }.start()
            relay = r
            main.post {
                try {
                    val pc = ProxyConfig.Builder().addProxyRule("127.0.0.1:${r.port}").build()
                    ProxyController.getInstance().setProxyOverride(pc, mainExec) {}
                } catch (e: Exception) {
                    Log.e("TainikProxy", "не удалось включить прокси в WebView", e)
                }
            }
        } else if (supported) {
            main.post {
                try {
                    ProxyController.getInstance().clearProxyOverride(mainExec) {}
                } catch (e: Exception) {
                    Log.w("TainikProxy", "не удалось выключить прокси в WebView", e)
                }
            }
        }
    }

    /** Для собственных запросов приложения (обновления): тот же ретранслятор, что и у WebView. */
    fun javaProxy(): Proxy = relay?.let { Proxy(Proxy.Type.HTTP, InetSocketAddress("127.0.0.1", it.port)) } ?: Proxy.NO_PROXY

    /** Проверка: открыть через прокси соединение с сервером. Возвращает время в мс. */
    fun test(c: ProxyCfg, host: String, port: Int): Long {
        val t0 = System.currentTimeMillis()
        Tunnel.open(c, host, port).close()
        return System.currentTimeMillis() - t0
    }
}
