package io.github.insid0909.statusboard

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.SystemClock
import android.content.res.Configuration
import android.util.TypedValue
import android.widget.RemoteViews
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * 확장 상태판 자료(저장소 repo 가지 status.json)를 받아 위젯·알림에 씀.
 * 웹 상태판·망가요미/애니요미 상태판 확장과 같은 자료.
 */
object Status {
    const val PAGE = "https://insid0909-max.github.io/aniyomi-extensions/status/"
    private const val DATA = "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/repo/status.json"
    const val VERSION_URL = "https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/status-app/version.json"
    const val ACTION_REFRESH = "io.github.insid0909.statusboard.REFRESH"
    private const val CHANNEL = "status"
    private const val STALE_HOURS = 36

    class Item(val group: String, val key: String, val name: String, val addr: String, val msg: String)

    class Summary(
        val ok: Int,
        val bad: Int,
        val abroad: Int,
        val none: Int,
        val badItems: List<Item>,
        val generatedAt: Long,
        val staleGroups: List<String>,
        val lastRun: Long,
    )

    private fun prefs(ctx: Context) = ctx.getSharedPreferences("status", Context.MODE_PRIVATE)

    fun get(url: String): String {
        val c = URL(url + (if ('?' in url) "&" else "?") + "t=" + System.currentTimeMillis() / 60000).openConnection() as HttpURLConnection
        c.connectTimeout = 10000
        c.readTimeout = 15000
        c.setRequestProperty("Cache-Control", "no-cache")
        try {
            if (c.responseCode != 200) throw Exception("HTTP ${c.responseCode}")
            return c.inputStream.bufferedReader().readText()
        } finally {
            c.disconnect()
        }
    }

    private fun iso(s: String?): Long {
        if (s.isNullOrBlank()) return 0
        return try {
            val f = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US)
            f.timeZone = TimeZone.getTimeZone("UTC")
            f.parse(s.substring(0, minOf(19, s.length)))?.time ?: 0
        } catch (e: Exception) {
            0
        }
    }

    fun parse(text: String): Summary {
        val d = JSONObject(text)
        var ok = 0
        var bad = 0
        var abroad = 0
        var none = 0
        val badItems = ArrayList<Item>()
        val groups = d.optJSONArray("groups")
        for (i in 0 until (groups?.length() ?: 0)) {
            val g = groups!!.getJSONObject(i)
            val items = g.optJSONArray("items") ?: continue
            for (j in 0 until items.length()) {
                val it = items.getJSONObject(j)
                when (it.optString("state")) {
                    "ok" -> ok++
                    "bad" -> {
                        bad++
                        badItems.add(Item(g.optString("id"), it.optString("key"), it.optString("name"), it.optString("addr"), it.optString("msg")))
                    }
                    "abroad" -> abroad++
                    else -> none++
                }
            }
        }
        val runs = d.optJSONObject("runs")
        val stale = ArrayList<String>()
        val now = System.currentTimeMillis()
        var lastRun = 0L
        for ((k, label) in listOf("anime" to "애니", "webtoon" to "웹툰")) {
            val t = iso(runs?.optString(k))
            if (t > 0 && now - t > STALE_HOURS * 3600_000L) stale.add(label)
            if (t > lastRun) lastRun = t
        }
        return Summary(ok, bad, abroad, none, badItems, iso(d.optString("generatedAt")), stale, lastRun)
    }

    /** 감시 작업 예약 시각: 매일 한국 시간 08:41 (monitor.yml cron 41 23 * * * UTC) — 지금 다음 차례 */
    fun nextRun(now: Long = System.currentTimeMillis()): Long {
        val cal = java.util.Calendar.getInstance(TimeZone.getTimeZone("Asia/Seoul"))
        cal.timeInMillis = now
        cal.set(java.util.Calendar.HOUR_OF_DAY, 8)
        cal.set(java.util.Calendar.MINUTE, 41)
        cal.set(java.util.Calendar.SECOND, 0)
        cal.set(java.util.Calendar.MILLISECOND, 0)
        if (cal.timeInMillis <= now) cal.add(java.util.Calendar.DAY_OF_MONTH, 1)
        return cal.timeInMillis
    }

    fun hhmm(t: Long): String {
        val f = SimpleDateFormat("HH:mm", Locale.KOREA)
        f.timeZone = TimeZone.getTimeZone("Asia/Seoul")
        return f.format(Date(t))
    }

    fun hm(t: Long): String {
        if (t <= 0) return "-"
        val f = SimpleDateFormat("MM.dd HH:mm", Locale.KOREA)
        f.timeZone = TimeZone.getTimeZone("Asia/Seoul")
        return f.format(Date(t))
    }

    /** 자료를 새로 받아 위젯을 고치고, 바뀐 점이 있으면 알림. 실패하면 위젯에 마지막 자료 + 실패 표시. */
    fun refresh(ctx: Context) {
        val p = prefs(ctx)
        var err = ""
        try {
            val text = get(DATA)
            parse(text) // 읽을 수 있는지 확인
            p.edit().putString("json", text).putLong("fetched", System.currentTimeMillis()).apply()
        } catch (e: Exception) {
            err = e.message ?: e.javaClass.simpleName
        }
        val text = p.getString("json", null)
        val s = text?.let { runCatching { parse(it) }.getOrNull() }
        updateWidgets(ctx, s, err)
        if (s != null && err.isEmpty()) notifyChanges(ctx, s)
    }

    // ---------- 위젯 모양 설정 (투명도·글자 크기·배경색) ----------
    val SCALES = floatArrayOf(0.85f, 1.0f, 1.2f, 1.4f)
    val SCALE_NAMES = arrayOf("작게", "보통", "크게", "아주 크게")
    val BG_NAMES = arrayOf("휴대폰 따라", "밝게", "어둡게")

    fun transparency(ctx: Context) = prefs(ctx).getInt("w_transparency", 0) // 0 = 불투명, 100 = 완전 투명
    fun scaleIndex(ctx: Context) = prefs(ctx).getInt("w_scale", 1)
    fun bgMode(ctx: Context) = prefs(ctx).getInt("w_bg", 0)

    fun saveStyle(ctx: Context, transparency: Int, scale: Int, bg: Int) {
        prefs(ctx).edit().putInt("w_transparency", transparency).putInt("w_scale", scale).putInt("w_bg", bg).apply()
    }

    /** 받아 둔 자료로 위젯만 다시 그림 (설정 바꿀 때) */
    fun redraw(ctx: Context) {
        val s = prefs(ctx).getString("json", null)?.let { runCatching { parse(it) }.getOrNull() }
        updateWidgets(ctx, s)
    }

    private fun style(ctx: Context, v: RemoteViews) {
        val dark = when (bgMode(ctx)) {
            1 -> false
            2 -> true
            else -> (ctx.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
        }
        val bg = if (dark) 0xFF22252B.toInt() else 0xFFFFFFFF.toInt()
        val text = if (dark) 0xFFECEDEF.toInt() else 0xFF1B1D22.toInt()
        val sub = if (dark) 0xFFB0B6C0.toInt() else 0xFF5B6270.toInt()
        v.setInt(R.id.bg, "setColorFilter", bg)
        v.setInt(R.id.bg, "setImageAlpha", ((100 - transparency(ctx).coerceIn(0, 100)) * 255) / 100)
        val k = SCALES.getOrElse(scaleIndex(ctx)) { 1f }
        for ((id, size, color) in listOf(
            Triple(R.id.title, 12f, sub), Triple(R.id.settings, 16f, sub), Triple(R.id.refresh, 18f, sub),
            Triple(R.id.summary, 20f, text), Triple(R.id.detail, 13f, text), Triple(R.id.time, 11f, sub),
        )) {
            v.setTextViewTextSize(id, TypedValue.COMPLEX_UNIT_SP, size * k)
            v.setTextColor(id, color)
        }
    }

    fun updateWidgets(ctx: Context, s: Summary?, err: String = "") {
        val mgr = AppWidgetManager.getInstance(ctx)
        val ids = mgr.getAppWidgetIds(ComponentName(ctx, StatusWidget::class.java))
        if (ids.isEmpty()) return
        val v = RemoteViews(ctx.packageName, R.layout.widget)
        style(ctx, v)
        if (s == null) {
            v.setTextViewText(R.id.summary, "자료를 못 받았어요")
            v.setTextViewText(R.id.detail, err)
            v.setTextViewText(R.id.time, "↻ 를 눌러 다시")
        } else {
            val total = s.ok + s.bad + s.abroad + s.none
            v.setTextViewText(R.id.summary, if (s.bad == 0) "✅ 모두 정상 ($total)" else "❌ 문제 ${s.bad} / $total")
            val lines = ArrayList<String>()
            if (s.staleGroups.isNotEmpty()) lines.add("⚠ 감시 작업 멈춤 (${s.staleGroups.joinToString("·")}) — GitHub Actions 확인")
            for (it in s.badItems) lines.add("❌ ${it.name} · ${it.msg}")
            lines.add("마지막 점검 ${hm(s.lastRun)}")
            lines.add("다음 점검 ${hm(nextRun())}")
            v.setTextViewText(R.id.detail, lines.joinToString("\n"))
            val fetched = prefs(ctx).getLong("fetched", 0)
            v.setTextViewText(R.id.time, (if (fetched > 0) "${hhmm(fetched)} 확인" else "") + if (err.isNotEmpty()) " · 새로 받기 실패" else "")
        }
        val open = PendingIntent.getActivity(
            ctx, 0, Intent(ctx, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        v.setOnClickPendingIntent(R.id.root, open)
        v.setOnClickPendingIntent(R.id.refresh, refreshIntent(ctx, 1))
        v.setOnClickPendingIntent(
            R.id.settings,
            PendingIntent.getActivity(
                ctx, 4, Intent(ctx, WidgetSettings::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            ),
        )
        mgr.updateAppWidget(ids, v)
    }

    fun refreshIntent(ctx: Context, code: Int): PendingIntent = PendingIntent.getBroadcast(
        ctx, code, Intent(ctx, RefreshReceiver::class.java).setAction(ACTION_REFRESH),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    /** 30분마다 새로 받기 (위젯이 없어도 알림을 위해). 휴대폰이 절전이면 조금 늦어질 수 있음. */
    fun schedule(ctx: Context) {
        val am = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager
        am.setInexactRepeating(
            AlarmManager.ELAPSED_REALTIME,
            SystemClock.elapsedRealtime() + AlarmManager.INTERVAL_HALF_HOUR,
            AlarmManager.INTERVAL_HALF_HOUR,
            refreshIntent(ctx, 2),
        )
    }

    // ---------- 알림: 새 문제·멈춤·모두 정상으로 돌아옴 ----------
    private fun notifyChanges(ctx: Context, s: Summary) {
        val p = prefs(ctx)
        val first = !p.contains("bad_keys")
        val before = p.getString("bad_keys", "")!!.split(',').filter { it.isNotEmpty() }.toSet()
        val now = s.badItems.map { it.group + "/" + it.key }.toSet()
        val newBad = s.badItems.filter { (it.group + "/" + it.key) !in before }
        val staleKey = s.staleGroups.joinToString(",")
        val staleBefore = p.getString("stale", "")!!
        p.edit().putString("bad_keys", now.joinToString(",")).putString("stale", staleKey).apply()
        if (first) return // 처음 설치 때는 알리지 않음 (지금 상태를 기준으로 삼음)
        if (newBad.isNotEmpty()) {
            notify(
                ctx, 10, "❌ 확장 문제 ${newBad.size}개 생김",
                newBad.joinToString("\n") { "${it.name} · ${it.msg}" },
            )
        } else if (before.isNotEmpty() && now.isEmpty()) {
            notify(ctx, 10, "✅ 확장 모두 정상으로 돌아왔어요", "문제였던 확장: " + before.size + "개")
        }
        if (staleKey.isNotEmpty() && staleKey != staleBefore) {
            notify(
                ctx, 11, "⚠ 감시 작업이 하루 넘게 멈췄어요",
                "${s.staleGroups.joinToString("·")} — GitHub 저장소 Actions 탭에서 초록 버튼(re-enable)을 눌러 주세요",
            )
        }
    }

    private fun notify(ctx: Context, id: Int, title: String, text: String) {
        val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "확장 상태 변화", NotificationManager.IMPORTANCE_DEFAULT))
        }
        val open = PendingIntent.getActivity(
            ctx, 3, Intent(ctx, MainActivity::class.java),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        @Suppress("DEPRECATION")
        val b = if (Build.VERSION.SDK_INT >= 26) android.app.Notification.Builder(ctx, CHANNEL) else android.app.Notification.Builder(ctx)
        b.setSmallIcon(android.R.drawable.stat_notify_error)
            .setContentTitle(title)
            .setContentText(text.lineSequence().firstOrNull() ?: "")
            .setStyle(android.app.Notification.BigTextStyle().bigText(text))
            .setContentIntent(open)
            .setAutoCancel(true)
        try {
            nm.notify(id, b.build())
        } catch (e: SecurityException) {
            // 알림 권한이 없으면 조용히 넘어감 (위젯에는 보임)
        }
    }
}
