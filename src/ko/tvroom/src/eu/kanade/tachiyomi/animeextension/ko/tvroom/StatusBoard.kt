package eu.kanade.tachiyomi.animeextension.ko.tvroom

import eu.kanade.tachiyomi.animesource.model.AnimeFilter
import eu.kanade.tachiyomi.animesource.model.AnimeFilterList
import eu.kanade.tachiyomi.animesource.model.AnimeUpdateStrategy
import eu.kanade.tachiyomi.animesource.model.AnimesPage
import eu.kanade.tachiyomi.animesource.model.SAnime
import eu.kanade.tachiyomi.animesource.model.SEpisode
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.animesource.online.AnimeHttpSource
import eu.kanade.tachiyomi.network.GET
import okhttp3.Request
import okhttp3.Response
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

/**
 * 확장 상태판 (2026-11-13, 망가요미 statusboard.js 0.1.0 과 같은 내용).
 * 작품 대신 확장 하나가 카드 하나. 자료는 상태판 웹 화면(GitHub Pages /status/)과 같은 repo 가지 status.json,
 * 회차 칸은 그 확장의 업데이트 내역(애니 master·웹툰 main changelog.json). 웹뷰 버튼은 그 사이트를 엶.
 */
class StatusBoard : AnimeHttpSource() {

    override val name = "확장 상태판"
    override val lang = "ko"
    override val supportsLatest = true
    override val baseUrl = PAGE

    // ================= 자료 =================
    private class Item(
        val group: String,
        val groupTitle: String,
        val key: String,
        val name: String,
        val addr: String,
        val link: String,
        val state: String,
        val indirect: Boolean,
        val checkedAt: String,
        val msg: String,
        val since: String,
        val js: String,
        val kt: Boolean,
        val source: String,
        val addrSince: String,
    )

    private class Data(val items: List<Item>, val runs: JSONObject, val generatedAt: String)

    private fun dataRequest(): Request = GET("$DATA_URL?t=${System.currentTimeMillis() / 60_000}", headers)

    private fun parseData(response: Response): Data {
        if (!response.isSuccessful) throw Exception("상태 자료를 받지 못했어요 (HTTP ${response.code}). 잠시 뒤 다시 열어 주세요.")
        val root = JSONObject(response.body.string())
        val items = mutableListOf<Item>()
        val groups = root.optJSONArray("groups")
        for (g in 0 until (groups?.length() ?: 0)) {
            val grp = groups!!.getJSONObject(g)
            val arr = grp.optJSONArray("items") ?: continue
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                items.add(
                    Item(
                        group = grp.optString("id"),
                        groupTitle = grp.optString("title"),
                        key = o.optString("key"),
                        name = o.optString("name"),
                        addr = o.optString("addr"),
                        link = o.optString("link"),
                        state = o.optString("state", "none"),
                        indirect = o.optBoolean("indirect"),
                        checkedAt = o.optString("checkedAt"),
                        msg = o.optString("msg"),
                        since = o.optString("since"),
                        js = o.optString("js"),
                        kt = o.optBoolean("kt"),
                        source = o.optString("source"),
                        addrSince = o.optString("addrSince"),
                    ),
                )
            }
        }
        return Data(items, root.optJSONObject("runs") ?: JSONObject(), root.optString("generatedAt"))
    }

    private fun card(it: Item) = SAnime.create().apply {
        title = "${MARK[it.state] ?: ""} ${it.name}".trim()
        url = "/st/${it.group}/${it.key}"
        thumbnail_url = IMG + (if (MARK.containsKey(it.state)) it.state else "none") + ".png"
    }

    private fun list(d: Data, group: String, state: String, query: String): List<SAnime> {
        val order = mapOf("bad" to 0, "ok" to 1, "abroad" to 2, "none" to 3)
        val q = query.replace(Regex("\\s+"), "").lowercase()
        return d.items
            .filter { (group.isEmpty() || it.group == group) && (state.isEmpty() || it.state == state) }
            .filter { q.isEmpty() || it.name.replace(Regex("\\s+"), "").lowercase().contains(q) || it.addr.contains(q) }
            .let { l -> if (state.isEmpty()) l.sortedBy { order[it.state] ?: 9 } else l }
            .map(::card)
    }

    // ================= 목록 =================
    // 인기 = 전체(문제 있는 것이 맨 앞), 최신 = 문제 있는 것만(없으면 안내 카드)
    override fun popularAnimeRequest(page: Int): Request = dataRequest()

    override fun popularAnimeParse(response: Response): AnimesPage = AnimesPage(list(parseData(response), "", "", ""), false)

    override fun latestUpdatesRequest(page: Int): Request = dataRequest()

    override fun latestUpdatesParse(response: Response): AnimesPage {
        val l = list(parseData(response), "", "bad", "")
        if (l.isNotEmpty()) return AnimesPage(l, false)
        return AnimesPage(
            listOf(
                SAnime.create().apply {
                    title = "✅ 문제 있는 확장이 없어요"
                    url = "/st/all/none"
                    thumbnail_url = IMG + "ok.png"
                },
            ),
            false,
        )
    }

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        val group = filters.filterIsInstance<GroupFilter>().firstOrNull()?.state ?: 0
        val st = filters.filterIsInstance<StateFilter>().firstOrNull()?.state ?: 0
        return GET("$DATA_URL?t=${System.currentTimeMillis() / 60_000}&g=$group&s=$st&q=${java.net.URLEncoder.encode(query, "UTF-8")}", headers)
    }

    override fun searchAnimeParse(response: Response): AnimesPage {
        val u = response.request.url
        val group = GROUPS.getOrNull(u.queryParameter("g")?.toIntOrNull() ?: 0)?.second.orEmpty()
        val st = STATES.getOrNull(u.queryParameter("s")?.toIntOrNull() ?: 0)?.second.orEmpty()
        return AnimesPage(list(parseData(response), group, st, u.queryParameter("q").orEmpty()), false)
    }

    // ================= 카드 열기 =================
    private fun keyOf(url: String): Pair<String, String> {
        val p = url.trim('/').split('/')
        return (p.getOrNull(1).orEmpty()) to (p.getOrNull(2).orEmpty())
    }

    override fun animeDetailsRequest(anime: SAnime): Request = GET("$DATA_URL?t=${System.currentTimeMillis() / 60_000}#${anime.url}", headers)

    // 웹뷰 버튼: 그 확장의 사이트 (모르면 상태판 웹 화면)
    override fun getAnimeUrl(anime: SAnime): String = siteLinks[anime.url] ?: PAGE

    private val siteLinks = java.util.concurrent.ConcurrentHashMap<String, String>()

    override fun animeDetailsParse(response: Response): SAnime {
        val path = response.request.url.fragment.orEmpty()
        val d = parseData(response)
        val (group, key) = keyOf(path)
        val runs = d.runs
        val it = d.items.firstOrNull { x -> x.group == group && x.key == key }
            ?: return SAnime.create().apply {
                title = "✅ 문제 있는 확장이 없어요"
                description = "감시 작업이 마지막으로 확인한 결과, 문제 있는 확장이 없어요.\n마지막 점검: 애니 ${kst(runs.optString("anime"))} · 웹툰 ${kst(runs.optString("webtoon"))}"
                status = SAnime.UNKNOWN
                thumbnail_url = IMG + "ok.png"
                update_strategy = AnimeUpdateStrategy.ALWAYS_UPDATE
                initialized = true
            }
        if (it.link.isNotEmpty()) siteLinks[path] = it.link
        val run = runs.optString(it.group)
        val stale = run.isNotEmpty() && (System.currentTimeMillis() - parseIso(run)) / 3_600_000.0 > 36
        val check = when {
            it.indirect -> "${if (it.state == "ok") "✅ 정상" else "❌ 문제"} (간접 확인 · 30분마다) · ${it.msg}\n" +
                if (it.msg.contains("해외")) "해외에서 막혀 목록은 못 열고, 서버가 답하는지로 살아 있는지 봤어요." else "서버가 답하는지로 살아 있는지 봤어요."
            it.state == "ok" -> "✅ 정상 · ${kst(it.checkedAt)} 점검 · ${it.msg}"
            it.state == "bad" -> "❌ 문제 · ${if (it.since.isNotEmpty()) kst(it.since) + "부터 · " else ""}${kst(it.checkedAt)} 점검\n${it.msg}"
            it.state == "abroad" -> "🌐 해외 서버에서 막혀 감시 작업이 못 열어요. 휴대폰에서 안 되면 그 확장 필터 맨 위 📡·🔎 줄을 찍어 보내 주세요."
            else -> "➖ 감시 작업이 매일 열어 보는 목록에 없는 확장이에요."
        }
        val since = if (it.addrSince.isNotEmpty()) kst(if (it.addrSince.length > 10) it.addrSince else it.addrSince + "T03:00:00Z").take(5) + "부터 이 주소" else ""
        val lines = listOf(
            check,
            "주소: ${it.addr}" + if (it.link.isNotEmpty()) " (오른쪽 위 지구본을 누르면 사이트가 열려요)" else "",
            listOf(it.source, since).filter { s -> s.isNotEmpty() }.joinToString(" · "),
            "버전: " + (listOf(if (it.js.isNotEmpty()) "망가요미 ${it.js}" else "", if (it.kt) "애니요미 있음" else "").filter { s -> s.isNotEmpty() }.joinToString(" · ").ifEmpty { "-" }),
            "감시 작업 마지막 실행: ${kst(run).ifEmpty { "기록 없음" }}" + if (stale) " ⚠ 하루 넘게 멈춤 — GitHub Actions 가 꺼졌을 수 있어요" else "",
            "상태판 자료: ${kst(d.generatedAt)}",
            "아래 목록은 이 확장의 업데이트 내역이에요.",
        ).filter { s -> s.isNotEmpty() }
        return SAnime.create().apply {
            title = "${MARK[it.state] ?: ""} ${it.name}".trim()
            thumbnail_url = IMG + (if (MARK.containsKey(it.state)) it.state else "none") + ".png"
            description = lines.joinToString("\n")
            author = it.groupTitle
            genre = listOf(LABEL[it.state].orEmpty(), it.groupTitle).filter { s -> s.isNotEmpty() }.joinToString(", ")
            status = SAnime.UNKNOWN
            update_strategy = AnimeUpdateStrategy.ALWAYS_UPDATE
            initialized = true
        }
    }

    // ================= 회차 = 업데이트 내역 =================
    override fun episodeListRequest(anime: SAnime): Request {
        val (group, _) = keyOf(anime.url)
        val log = LOG_URLS[group] ?: LOG_URLS.getValue("anime")
        return GET("$log?t=${System.currentTimeMillis() / 60_000}#${anime.url}", headers)
    }

    override fun episodeListParse(response: Response): List<SEpisode> {
        val path = response.request.url.fragment.orEmpty()
        val (group, key) = keyOf(path)
        if (key.isEmpty() || key == "none" || !response.isSuccessful) return emptyList()
        val arr = JSONObject(response.body.string()).optJSONObject("items")?.optJSONArray(key) ?: return emptyList()
        val n = minOf(arr.length(), 30)
        return (0 until n).map { i ->
            val o = arr.getJSONObject(i)
            val d = o.optString("d")
            val t = o.optString("t")
            SEpisode.create().apply {
                episode_number = (n - i).toFloat()
                name = "${n - i}. ${d.drop(5).replace('-', '.')} ${t.replace(Regex("^(망가요미|애니요미):\\s*"), "")}"
                url = "/log/$group/$key/$i"
                date_upload = runCatching { DAY.parse(d)?.time }.getOrNull() ?: 0L
                scanlator = when {
                    t.startsWith("애니요미") -> "애니요미"
                    t.startsWith("망가요미") -> "망가요미"
                    else -> null
                }
            }
        }
    }

    override suspend fun getVideoList(episode: SEpisode): List<Video> =
        throw Exception("이 줄은 업데이트 내역이에요. 재생할 영상은 없어요.")

    override fun videoListParse(response: Response): List<Video> = throw UnsupportedOperationException()

    // ================= 필터 =================
    private class GroupFilter : AnimeFilter.Select<String>("분류", GROUPS.map { it.first }.toTypedArray())

    private class StateFilter : AnimeFilter.Select<String>("상태", STATES.map { it.first }.toTypedArray())

    override fun getFilterList(): AnimeFilterList = AnimeFilterList(
        AnimeFilter.Header("인기 = 전체(문제 있는 것이 맨 앞) · 최신 = 문제 있는 것만"),
        GroupFilter(),
        StateFilter(),
    )

    // ================= 도움 =================
    private fun parseIso(iso: String): Long = runCatching {
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.parse(iso.take(19))!!.time
    }.getOrDefault(0L)

    private fun kst(iso: String): String {
        if (iso.length < 19) return ""
        val t = parseIso(iso)
        if (t == 0L) return ""
        return SimpleDateFormat("MM.dd HH:mm", Locale.KOREA).apply { timeZone = TimeZone.getTimeZone("Asia/Seoul") }.format(java.util.Date(t))
    }

    companion object {
        private const val PAGE = "https://insid0909-max.github.io/aniyomi-extensions/status/"
        private const val RAW = "https://raw.githubusercontent.com/insid0909-max/"
        private const val DATA_URL = RAW + "aniyomi-extensions/repo/status.json"
        private const val IMG = RAW + "aniyomi-extensions/master/mangayomi/javascript/anime/thumbs/status_"
        private val LOG_URLS = mapOf(
            "anime" to RAW + "aniyomi-extensions/master/changelog.json",
            "webtoon" to RAW + "aniyomi-manga-extensions/main/changelog.json",
        )
        private val MARK = mapOf("ok" to "✅", "bad" to "❌", "abroad" to "🌐", "none" to "➖")
        private val LABEL = mapOf("ok" to "정상", "bad" to "문제", "abroad" to "해외에서 막혀 확인 못 함", "none" to "점검 안 함")
        private val GROUPS = listOf("전체" to "", "애니·드라마·스포츠" to "anime", "웹툰·소설" to "webtoon")
        private val STATES = listOf("전체" to "", "문제" to "bad", "정상" to "ok", "해외 차단" to "abroad", "점검 안 함" to "none")
        private val DAY = SimpleDateFormat("yyyy-MM-dd", Locale.KOREA).apply { timeZone = TimeZone.getTimeZone("Asia/Seoul") }
    }
}
