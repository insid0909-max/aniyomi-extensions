package eu.kanade.tachiyomi.animeextension.ko.tvroom

import android.util.Base64
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

/**
 * 앱 안 영상 중계 (http://127.0.0.1:포트/…, 2026-11-09).
 * 영상 서버가 애니요미 재생기(ffmpeg)의 접속은 막고(MissAV 403·미미티비 502) 확장의 통신은 받아 줌 →
 * 재생기는 이 앱 안 주소로 요청하고, 확장이 같은 머리글로 원래 서버에서 받아 그대로 넘김.
 * 재생 목록(m3u8)은 안의 주소만 이 중계 주소로 바꾸고, 조각·열쇠는 내용을 바꾸지 않고 그대로 전달 (순정 망가요미 createHlsProxyUrl 과 같은 방식)
 */
internal object LocalProxy {
    private class Session(val client: OkHttpClient, val headers: Headers, val at: Long, val diag: Boolean = false)

    // [임시 진단] diag 세션의 요청 기록 (2026-11-17 링크애니 조각 403 원인 찾기 — 원인 찾으면 뺄 것)
    private val DIAG = java.util.concurrent.ConcurrentLinkedDeque<String>()
    private val DIAG_SUM = IntArray(4) // 0 조각 수, 1 첫 시도 403, 2 다시 받아 성공, 3 끝내 실패

    /** 진단 기록 (요약 1줄 + 최근 기록), 없으면 빈 목록 */
    fun diagLines(max: Int = 20): List<String> {
        if (DIAG.isEmpty()) return emptyList()
        val head = "🩺 중계 기록(앱 켠 뒤 모두): 조각 ${DIAG_SUM[0]}개 · 첫 시도 거부 ${DIAG_SUM[1]} · 다시 받아 성공 ${DIAG_SUM[2]} · 끝내 실패 ${DIAG_SUM[3]}"
        return listOf(head) + DIAG.toList().takeLast(max).map { "🩺 $it" }
    }

    private fun diagAdd(line: String) {
        val t = java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.KOREA).format(java.util.Date())
        DIAG.addLast("$t $line")
        while (DIAG.size > 60) DIAG.pollFirst()
    }

    private val SESSIONS = ConcurrentHashMap<String, Session>()
    private val TEXTS = ConcurrentHashMap<String, Pair<String, String>>()
    private const val KEEP_MS = 6 * 3600_000L
    private val URI_ATTR = Regex("""URI="([^"]+)"""")

    @Volatile private var server: ServerSocket? = null

    @Synchronized
    private fun port(): Int {
        server?.takeIf { !it.isClosed }?.let { return it.localPort }
        val s = ServerSocket(0, 32, InetAddress.getByName("127.0.0.1"))
        server = s
        thread(isDaemon = true, name = "LocalProxy") {
            while (!s.isClosed) {
                val sock = runCatching { s.accept() }.getOrNull() ?: break
                thread(isDaemon = true) { runCatching { serve(sock) } }
            }
        }
        return s.localPort
    }

    private fun newSession(client: OkHttpClient, headers: Headers, diag: Boolean = false): String {
        val now = System.currentTimeMillis()
        SESSIONS.entries.removeIf { now - it.value.at > KEEP_MS }
        val sid = now.toString(36) + (SESSIONS.size + 1)
        SESSIONS[sid] = Session(client, headers, now, diag)
        // 앞 기록은 지우지 않음(회차를 다시 열면 멈춘 기록이 사라졌음) — 구분 줄만
        if (diag) diagAdd("── 회차 열기: 중계 준비 (재생기가 아직 요청 안 함)")
        return sid
    }

    /** 원래 재생 목록 주소 → 재생기에 줄 중계 주소 (diag = 요청 기록 남기기) */
    fun playlist(client: OkHttpClient, headers: Headers, url: String, diag: Boolean = false): String = proxied(newSession(client, headers, diag), url, true)

    /** [임시 진단] 재생 목록 + 자막(.vtt)도 같은 중계로 — 자막 요청도 기록 (2026-11-17 링크애니: 조각 2개 받고 멈춤) */
    fun playlistWithSub(client: OkHttpClient, headers: Headers, url: String, sub: String?, diag: Boolean = false): Pair<String, String?> {
        val sid = newSession(client, headers, diag)
        return proxied(sid, url, true) to sub?.let { proxied(sid, it) }
    }

    /** 웹뷰 안에서 이미 받은 재생 목록 글자 → 재생기에 줄 중계 주소 (안의 조각은 중계로) */
    fun fromText(client: OkHttpClient, headers: Headers, text: String, baseUrl: String): String {
        val sid = newSession(client, headers)
        val tid = System.currentTimeMillis().toString(36) + (TEXTS.size + 1)
        TEXTS[tid] = text to baseUrl
        return "http://127.0.0.1:${port()}/t/$sid/$tid.m3u8"
    }

    private fun enc(u: String) = Base64.encodeToString(u.toByteArray(), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)

    private fun dec(s: String) = String(Base64.decode(s, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))

    /**
     * 끝 이름: 재생 목록은 원래 이름(.m3u8), 그 밖(조각·열쇠)은 ".ts" — 조각을 그림(.jpeg·.png)으로 꾸민 사이트가 있어
     * 재생기가 이름·형식 표시로 그림으로 읽으면 "unrecognized file format" (2026-11-09 MissAV)
     */
    private fun proxied(sid: String, url: String, list: Boolean = false): String {
        val last = url.toHttpUrlOrNull()?.pathSegments?.lastOrNull().orEmpty()
        // 재생 목록인데 이름이 .m3u8 이 아니면(티비위키 c.html) "index.m3u8" 로
        val name = if (last.endsWith(".m3u8") || last.endsWith(".vtt")) last else if (list) "index.m3u8" else "s.ts"
        return "http://127.0.0.1:${port()}/m/$sid/${enc(url)}/$name"
    }

    private fun rewrite(sid: String, text: String, base: String): String {
        val b = base.toHttpUrlOrNull() ?: return text
        // 화질 목록(#EXT-X-STREAM-INF 다음 줄)·음성/자막 목록(#EXT-X-MEDIA)은 재생 목록 이름으로
        var nextIsList = false
        return text.lines().joinToString("\n") { line ->
            val t = line.trim()
            when {
                t.isEmpty() -> line
                t.startsWith("#") -> {
                    if (t.startsWith("#EXT-X-STREAM-INF")) nextIsList = true
                    val tagList = t.startsWith("#EXT-X-MEDIA") || t.startsWith("#EXT-X-I-FRAME-STREAM-INF")
                    URI_ATTR.replace(line) { m -> "URI=\"${proxied(sid, (b.resolve(m.groupValues[1]) ?: return@replace m.value).toString(), tagList)}\"" }
                }
                else -> (b.resolve(t)?.let { proxied(sid, it.toString(), nextIsList) } ?: line).also { nextIsList = false }
            }
        }
    }

    private fun serve(sock: Socket) = sock.use { c ->
        c.soTimeout = 30_000
        val reader = c.getInputStream().bufferedReader()
        val first = reader.readLine().orEmpty()
        var range: String? = null
        while (true) {
            val line = reader.readLine() ?: break
            if (line.isEmpty()) break
            if (line.startsWith("Range:", true)) range = line.substringAfter(':').trim()
        }
        val head = first.startsWith("HEAD")
        val parts = first.split(" ").getOrNull(1).orEmpty().substringBefore('?').trim('/').split('/')
        val out = c.getOutputStream()
        val sess = parts.getOrNull(1)?.let { SESSIONS[it] }
        if (sess == null) return@use reply(out, 404, "text/plain", ByteArray(0), head, "no-session")
        when (parts.getOrNull(0)) {
            "t" -> {
                val (text, base) = TEXTS[parts.getOrNull(2)?.substringBefore('.')]
                    ?: return@use reply(out, 404, "text/plain", ByteArray(0), head, "no-list")
                reply(out, 200, "application/vnd.apple.mpegurl", rewrite(parts[1], text, base).toByteArray(), head)
            }
            "m" -> {
                val url = runCatching { dec(parts.getOrNull(2).orEmpty()) }.getOrNull()
                    ?: return@use reply(out, 400, "text/plain", ByteArray(0), head, "bad-path")
                // 중계 주소 끝 이름이 .m3u8 이면(재생 목록으로 만든 주소) 원래 주소가 .m3u8 이 아니어도 재생 목록
                val listLike = url.substringBefore('?').endsWith(".m3u8") || parts.lastOrNull().orEmpty().endsWith(".m3u8")
                val subLike = parts.lastOrNull().orEmpty().endsWith(".vtt")

                // 재생 목록에는 Range 를 넘기지 않음. 조각은 Range 로 400·416 이면 Range 없이 한 번 더 (2026-11-09 MissAV "400")
                fun call(withRange: Boolean) = sess.client.newCall(
                    Request.Builder().url(url).headers(sess.headers)
                        .apply { if (withRange && range != null && !listLike) header("Range", range!!) }.build(),
                ).execute()
                val t0 = System.currentTimeMillis()
                var res = call(true)
                val firstCode = res.code
                if ((res.code == 400 || res.code == 416) && range != null && !listLike) {
                    res.close()
                    res = call(false)
                }
                // 영상 서버가 조각을 가끔씩 거부(403 "Video request blocked")하면 잠깐 쉬고 다시 (2026-11-17 링크애니 noblepulse539·getvfa,
                // 애니요미 재생기는 거부된 조각을 다시 받지 않아 계속 로딩만 됨). 재생 목록은 그대로
                var tries = 0
                while (res.code == 403 && !listLike && tries < 5) {
                    res.close()
                    tries++
                    Thread.sleep(400L * tries)
                    res = call(true)
                }
                if (sess.diag && subLike) {
                    val len = res.header("Content-Length") ?: "?"
                    diagAdd("자막 ${url.toHttpUrlOrNull()?.host.orEmpty().substringBefore('.')} $firstCode→${res.code} ${System.currentTimeMillis() - t0}ms ${len}B" + (range?.let { " r" } ?: ""))
                } else if (sess.diag) {
                    val host = url.toHttpUrlOrNull()?.host.orEmpty().substringBefore('.')
                    val name = url.toHttpUrlOrNull()?.pathSegments?.lastOrNull().orEmpty().take(14)
                    val ms = System.currentTimeMillis() - t0
                    if (!listLike) {
                        DIAG_SUM[0]++
                        if (firstCode == 403) DIAG_SUM[1]++
                        if (firstCode == 403 && res.isSuccessful) DIAG_SUM[2]++
                        if (!res.isSuccessful) DIAG_SUM[3]++
                    }
                    diagAdd((if (listLike) "목록 " else "조각 ") + "$host $name $firstCode" + (if (tries > 0) "→${res.code} 다시$tries" else "") + " ${ms}ms" + (range?.let { " r" } ?: ""))
                }
                res.use { rs ->
                    val type = rs.header("Content-Type").orEmpty()
                    // 이름·형식 표시가 재생 목록이 아니어도 글자가 #EXTM3U 로 시작하면 재생 목록 (티비위키 c.html 은 text/html 로 올 수 있음)
                    val isList = listLike || type.contains("mpegurl", true) ||
                        (rs.isSuccessful && runCatching { rs.peekBody(16).string().trimStart().startsWith("#EXTM3U") }.getOrDefault(false))
                    if (isList && rs.isSuccessful) {
                        reply(out, 200, "application/vnd.apple.mpegurl", rewrite(parts[1], rs.body.string(), rs.request.url.toString()).toByteArray(), head)
                    } else {
                        // 원래 서버가 거절하면 재생기 오류 글자(상태 뒤)에 무엇이 막혔는지 적음: list|seg 파일이름 r=Range
                        val why = if (rs.isSuccessful) {
                            "OK"
                        } else {
                            val name = url.toHttpUrlOrNull()?.pathSegments?.lastOrNull().orEmpty().take(24)
                            ("up " + (if (isList) "list " else "seg ") + name + " r=" + (range ?: "-")).filter { it.code in 32..126 }
                        }
                        val sb = StringBuilder("HTTP/1.1 ${rs.code} $why\r\n")
                        // 그림·글자로 꾸민 조각은 영상(MPEG-TS) 형식으로 알려 줌 (내용은 그대로)
                        val outType = if (subLike) {
                            "text/vtt"
                        } else if (type.isEmpty() || type.startsWith("image/") || type.startsWith("text/")) {
                            "video/mp2t"
                        } else {
                            type
                        }
                        sb.append("Content-Type: ").append(outType).append("\r\n")
                        rs.header("Content-Length")?.let { sb.append("Content-Length: ").append(it).append("\r\n") }
                        rs.header("Content-Range")?.let { sb.append("Content-Range: ").append(it).append("\r\n") }
                        sb.append("Accept-Ranges: bytes\r\nConnection: close\r\n\r\n")
                        out.write(sb.toString().toByteArray())
                        if (!head) rs.body.byteStream().copyTo(out)
                        out.flush()
                    }
                }
            }
            else -> reply(out, 404, "text/plain", ByteArray(0), head, "bad-kind")
        }
    }

    private fun reply(out: OutputStream, code: Int, type: String, body: ByteArray, head: Boolean, why: String = "OK") {
        out.write("HTTP/1.1 $code $why\r\nContent-Type: $type\r\nContent-Length: ${body.size}\r\nConnection: close\r\n\r\n".toByteArray())
        if (!head) out.write(body)
        out.flush()
    }
}
