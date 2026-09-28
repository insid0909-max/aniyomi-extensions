package eu.kanade.tachiyomi.animeextension.ko.tvroom

import android.annotation.SuppressLint
import android.app.Application
import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import android.widget.Toast
import androidx.preference.EditTextPreference
import androidx.preference.PreferenceScreen
import eu.kanade.tachiyomi.animesource.ConfigurableAnimeSource
import eu.kanade.tachiyomi.animesource.model.AnimeFilter
import eu.kanade.tachiyomi.animesource.model.AnimeFilterList
import eu.kanade.tachiyomi.animesource.model.AnimesPage
import eu.kanade.tachiyomi.animesource.model.SAnime
import eu.kanade.tachiyomi.animesource.model.SEpisode
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.animesource.online.ParsedAnimeHttpSource
import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.network.POST
import eu.kanade.tachiyomi.util.asJsoup
import okhttp3.Headers
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element
import java.net.URLEncoder

class TVroom : ParsedAnimeHttpSource(), ConfigurableAnimeSource {

    override val name = "티비위키"
    override val lang = "ko"
    override val supportsLatest = true

    // Injekt 의존성 없이 Android Application Context 직접 획득
    @SuppressLint("PrivateApi")
    private val preferences: SharedPreferences by lazy {
        val app = try {
            Class.forName("android.app.ActivityThread")
                .getMethod("currentApplication")
                .invoke(null) as? Application
        } catch (_: Throwable) {
            null
        }
        app?.getSharedPreferences("source_$id", Context.MODE_PRIVATE)
            ?: throw IllegalStateException("Context not available")
    }

    override val baseUrl: String
        get() = try {
            preferences.getString(PREF_DOMAIN_KEY, DEFAULT_BASE_URL)
                ?.takeIf { it.isNotBlank() }
                ?: DEFAULT_BASE_URL
        } catch (_: Throwable) {
            DEFAULT_BASE_URL
        }

    override val client: OkHttpClient = network.client

    private val bridgeBaseUrl = "https://dc-toki-mangayomi-media.pages.dev"
    private val defaultUserAgent =
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 " +
            "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

    override fun headersBuilder(): Headers.Builder = Headers.Builder()
        .add("User-Agent", defaultUserAgent)
        .add("Referer", "$baseUrl/")

    override fun popularAnimeRequest(page: Int): Request =
        GET("$baseUrl/popular?page=$page", headers)

    override fun popularAnimeSelector(): String =
        "#list_type .box, #line_type .box, #mov_con_list .box, div.box, .slide_popular .box"

    override fun popularAnimeFromElement(element: Element): SAnime = SAnime.create().apply {
        val link = element.selectFirst("a.title2, a.title, a.img, a[href]")!!
        setUrlWithoutDomain(link.attr("href"))

        val titleNode = element.selectFirst("a.title2, a.title, .subject, .title")
        val imgNode = element.selectFirst("img")

        val rawTitle = titleNode?.attr("title")?.ifEmpty { null }
            ?: titleNode?.text()?.trim()?.ifEmpty { null }
            ?: imgNode?.attr("alt")?.trim()?.ifEmpty { null }
            ?: link.text().trim()

        title = cleanSeriesTitle(rawTitle)

        thumbnail_url = imgNode?.let { img ->
            val src = img.attr("data-original").ifEmpty {
                img.attr("data-src").ifEmpty {
                    img.attr("src")
                }
            }
            fixUrl(src)
        }
    }

    override fun popularAnimeNextPageSelector(): String? =
        "a[rel='next'], .pg_next, .pagination .next, a:contains(다음)"

    override fun popularAnimeParse(response: Response): AnimesPage {
        val document = response.asJsoup()
        var elements = document.select(popularAnimeSelector())

        if (elements.isEmpty()) {
            elements = document.select("a[href~=^/(movie|kor_movie|drama|ent|ani|foreign_drama|docu)/\\d+$]")
        }

        val animeList = ArrayList<SAnime>()
        for (el in elements) {
            runCatching {
                val anime = popularAnimeFromElement(el)
                if (anime.url.isNotBlank() && !anime.url.contains("notice")) {
                    animeList.add(anime)
                }
            }
        }

        val uniqueList = animeList.distinctBy { it.url }
        val hasNextPage = popularAnimeNextPageSelector()?.let { document.selectFirst(it) } != null
        return AnimesPage(uniqueList, hasNextPage)
    }

    override fun latestUpdatesRequest(page: Int): Request =
        GET("$baseUrl/drama?page=$page", headers)

    override fun latestUpdatesSelector(): String = popularAnimeSelector()
    override fun latestUpdatesFromElement(element: Element): SAnime = popularAnimeFromElement(element)
    override fun latestUpdatesNextPageSelector(): String? = popularAnimeNextPageSelector()
    override fun latestUpdatesParse(response: Response): AnimesPage = popularAnimeParse(response)

    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        if (query.isNotBlank()) {
            val encodedQuery = URLEncoder.encode(query, "UTF-8")
            return GET("$baseUrl/search?stx=$encodedQuery&sst=subIdx&page=$page", headers)
        }

        var category = "all"
        var period = "d"
        var mode = "latest"

        filters.forEach { filter ->
            when (filter) {
                is CategoryFilter -> category = CATEGORIES[filter.state].second
                is PeriodFilter -> period = PERIODS[filter.state].second
                is ModeFilter -> mode = MODES[filter.state].second
                else -> {}
            }
        }

        val url = if (mode == "popular") {
            val catParam = if (category != "all") "&sb=$category" else ""
            "$baseUrl/popular?period=$period$catParam&page=$page"
        } else {
            val path = if (category == "all") "drama" else category
            "$baseUrl/$path?page=$page"
        }

        return GET(url, headers)
    }

    override fun searchAnimeSelector(): String = popularAnimeSelector()
    override fun searchAnimeFromElement(element: Element): SAnime = popularAnimeFromElement(element)
    override fun searchAnimeNextPageSelector(): String? = popularAnimeNextPageSelector()
    override fun searchAnimeParse(response: Response): AnimesPage = popularAnimeParse(response)

    override fun animeDetailsParse(document: Document): SAnime = SAnime.create().apply {
        val titleNode = document.selectFirst("#bo_v_title .bo_v_tit, #bo_v_title h1, h1, .view-title")
        val ogTitle = document.selectFirst("meta[property='og:title']")?.attr("content")
        title = cleanSeriesTitle(ogTitle ?: titleNode?.text() ?: "티비위키")

        thumbnail_url = document.selectFirst(".poster img, .thumb img, img.cover, #bo_v_img img")?.let { img ->
            val src = img.attr("data-original").ifEmpty {
                img.attr("data-src").ifEmpty {
                    img.attr("src")
                }
            }
            fixUrl(src)
        }

        description = document.selectFirst(".thumb-desc, .desc, .summary, .content, #bo_v_con, p")?.text()?.trim()
    }

    override fun episodeListSelector(): String =
        "#other_list li, ul.episode-list > li, div[class*='ep'] a, a"

    override fun episodeFromElement(element: Element): SEpisode = SEpisode.create().apply {
        val link = if (element.tagName() == "a") element else element.selectFirst("a")!!
        setUrlWithoutDomain(link.attr("href"))

        val rawText = link.text().trim().ifEmpty {
            link.attr("title").ifEmpty { element.text().trim() }
        }

        name = formatEpisodeName(rawText)

        val match = Regex("(\\d+(?:\\.\\d+)?)\\s*[화회]").find(rawText)
        episode_number = match?.groupValues?.get(1)?.toFloatOrNull() ?: 1f
    }

    override fun episodeListParse(response: Response): List<SEpisode> {
        val document = response.asJsoup()
        val currentPath = response.request.url.encodedPath.trimEnd('/')
        val episodes = ArrayList<SEpisode>()

        val items = document.select("#other_list li")
        if (items.isNotEmpty()) {
            for (item in items) {
                val link = item.selectFirst("a.title.ep-link, a.title, a.ep-link, a[href]") ?: continue
                val href = link.attr("href")
                if (href.isNotBlank()) {
                    val rawName = link.attr("title").ifEmpty { link.text().ifEmpty { item.text() } }.trim()
                    val match = Regex("(\\d+(?:\\.\\d+)?)\\s*[화회]").find(rawName)
                    episodes.add(
                        SEpisode.create().apply {
                            setUrlWithoutDomain(href)
                            name = formatEpisodeName(rawName)
                            episode_number = match?.groupValues?.get(1)?.toFloatOrNull() ?: 1f
                        },
                    )
                }
            }
        }

        if (episodes.isEmpty()) {
            val links = document.select("a[href]")
            for (link in links) {
                val href = link.attr("href")
                val text = link.text().trim()
                val isEpisodeUrl = href.startsWith(currentPath) && href.matches(Regex(".*/\\d+$")) && href != currentPath
                val hasEpText = text.matches(Regex(".*\\d+\\s*[화회].*"))

                if (href.isNotBlank() && (isEpisodeUrl || hasEpText)) {
                    val match = Regex("(\\d+(?:\\.\\d+)?)\\s*[화회]").find(text)
                    episodes.add(
                        SEpisode.create().apply {
                            setUrlWithoutDomain(href)
                            name = formatEpisodeName(text)
                            episode_number = match?.groupValues?.get(1)?.toFloatOrNull() ?: 1f
                        },
                    )
                }
            }
        }

        val uniqueList = episodes.distinctBy { it.url }
        if (uniqueList.isEmpty()) {
            return listOf(
                SEpisode.create().apply {
                    setUrlWithoutDomain(response.request.url.encodedPath)
                    name = "영상 재생"
                    episode_number = 1f
                },
            )
        }
        return uniqueList
    }

    override fun videoListParse(response: Response): List<Video> {
        val episodePath = response.request.url.encodedPath
        val parts = episodePath.trim('/').split("/")
        if (parts.size < 3) {
            return fallbackVideoParse(response)
        }

        val boTable = parts[0]
        val wrId = parts[1]
        val epIdx = parts[2]

        val metaUrl = "$baseUrl/bbs/get_episode.php?bo_table=$boTable&wr_id=$wrId&ep_idx=$epIdx"
        val metaHeaders = Headers.Builder()
            .add("User-Agent", defaultUserAgent)
            .add("Referer", "$baseUrl$episodePath")
            .add("Accept", "application/json")
            .add("X-Requested-With", "XMLHttpRequest")
            .build()

        val metaResponse = client.newCall(GET(metaUrl, metaHeaders)).execute()
        val metaJson = JSONObject(metaResponse.body.string())
        if (!metaJson.optBoolean("success", false)) {
            return fallbackVideoParse(response)
        }

        val episodeObj = metaJson.getJSONObject("episode")
        val rawHlsUrl = episodeObj.optString("hls_url")
        val sessionDataList = listOfNotNull(episodeObj.opt("session_data1"), episodeObj.opt("session_data2"))

        var acquiredSession: JSONObject? = null
        for (payload in sessionDataList) {
            val payloadStr = payload.toString()

            runCatching {
                val bridgeReqObj = JSONObject().apply {
                    put("baseUrl", baseUrl)
                    put("episodePath", episodePath)
                    put("sessionData", if (payloadStr.startsWith("{")) JSONObject(payloadStr) else payloadStr)
                }
                val bridgeHeaders = Headers.Builder()
                    .add("User-Agent", defaultUserAgent)
                    .add("Referer", "$bridgeBaseUrl/")
                    .add("Content-Type", "application/json; charset=utf-8")
                    .build()
                val reqBody = bridgeReqObj.toString().toRequestBody("application/json; charset=utf-8".toMediaType())
                val bridgeRes = client.newCall(POST("$bridgeBaseUrl/api/tvwiki-session", bridgeHeaders, reqBody)).execute()
                val resJson = JSONObject(bridgeRes.body.string())
                if (resJson.optBoolean("success", false) && resJson.has("player_url")) {
                    acquiredSession = resJson
                }
            }
            if (acquiredSession != null) break

            runCatching {
                val directHeaders = Headers.Builder()
                    .add("User-Agent", defaultUserAgent)
                    .add("Referer", "$baseUrl$episodePath")
                    .add("Origin", baseUrl)
                    .add("Content-Type", "application/json; charset=utf-8")
                    .build()
                val reqBody = payloadStr.toRequestBody("application/json; charset=utf-8".toMediaType())
                val directRes = client.newCall(POST("$baseUrl/api/create_session.php", directHeaders, reqBody)).execute()
                val resJson = JSONObject(directRes.body.string())
                if (resJson.optBoolean("success", false) && resJson.has("player_url")) {
                    acquiredSession = resJson
                }
            }
            if (acquiredSession != null) break
        }

        val sessionJson = acquiredSession ?: return fallbackVideoParse(response)

        val rawPlayerUrl = sessionJson.getString("player_url")
        val sep = if (rawPlayerUrl.contains("?")) "&" else "?"
        val playerUrl = resolveAbsolute("$baseUrl$episodePath", rawPlayerUrl) +
            "${sep}t=${URLEncoder.encode(sessionJson.optString("t"), "UTF-8")}&sig=${URLEncoder.encode(sessionJson.optString("sig"), "UTF-8")}"

        val playlistUrl = resolveAbsolute(playerUrl, rawHlsUrl)

        val playerOrigin = runCatching {
            val u = playerUrl.toHttpUrlOrNull()
            "${u?.scheme}://${u?.host}"
        }.getOrDefault(baseUrl)

        val streamHeaders = Headers.Builder()
            .add("User-Agent", defaultUserAgent)
            .add("Accept", "*/*")
            .add("Referer", playerUrl)
            .add("Origin", playerOrigin)
            .build()

        val playlistRes = client.newCall(GET(playlistUrl, streamHeaders)).execute()
        val playlistContent = playlistRes.body.string()

        val keyMatch = Regex("""#EXT-X-KEY:[^\r\n]*URI="([^"]+)"""", RegexOption.IGNORE_CASE).find(playlistContent)
        val videoList = ArrayList<Video>()

        if (keyMatch != null) {
            val keyUrl = resolveAbsolute(playlistUrl, keyMatch.groupValues[1])
            val envelopeRes = client.newCall(GET(keyUrl, streamHeaders)).execute()
            val envelope = envelopeRes.body.string()

            val uParam = URLEncoder.encode(toBase64Url(playlistUrl), "UTF-8")
            val rParam = URLEncoder.encode(toBase64Url(playerUrl), "UTF-8")
            val xParam = URLEncoder.encode(toBase64Url(envelope), "UTF-8")
            val common = "u=$uParam&r=$rParam&x=$xParam"

            videoList.add(
                Video(
                    "$bridgeBaseUrl/api/tvwiki-playlist.m3u8?m=p&$common",
                    "호환 재생 (중계)",
                    "$bridgeBaseUrl/api/tvwiki-playlist.m3u8?m=p&$common",
                    headers = streamHeaders,
                ),
            )
            videoList.add(
                Video(
                    "$bridgeBaseUrl/api/tvwiki-playlist.m3u8?m=f&$common",
                    "빠른 재생 (CDN 직접)",
                    "$bridgeBaseUrl/api/tvwiki-playlist.m3u8?m=f&$common",
                    headers = streamHeaders,
                ),
            )
        } else {
            videoList.add(Video(playlistUrl, "자동 (HLS)", playlistUrl, headers = streamHeaders))
        }

        return if (videoList.isNotEmpty()) videoList else fallbackVideoParse(response)
    }

    private fun fallbackVideoParse(response: Response): List<Video> {
        val document = response.asJsoup()
        val list = ArrayList<Video>()
        document.select("video source, video").forEach { v ->
            val src = v.attr("src")
            if (src.isNotBlank()) list.add(Video(fixUrl(src), "직접 재생", fixUrl(src)))
        }
        return list
    }

    private fun toBase64Url(value: String): String {
        return Base64.encodeToString(
            value.toByteArray(Charsets.UTF_8),
            Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING,
        ).trim()
    }

    private fun resolveAbsolute(base: String, target: String): String {
        val t = target.trim()
        if (t.startsWith("http://") || t.startsWith("https://")) return t
        if (t.startsWith("//")) return "https:$t"
        return if (t.startsWith("/")) {
            val baseUri = base.toHttpUrlOrNull()
            "${baseUri?.scheme}://${baseUri?.host}$t"
        } else {
            val dir = base.substringBeforeLast('/')
            "$dir/$t"
        }
    }

    private fun fixUrl(url: String): String = when {
        url.startsWith("//") -> "https:$url"
        url.startsWith("/") -> "$baseUrl$url"
        else -> url
    }

    private fun cleanSeriesTitle(raw: String): String =
        raw.replace(Regex("""\s+\d+(?:[-.]\d+)?화(?:\s+다시보기)?\s*$"""), "")
            .replace(Regex("""\s+다시보기(?:\s*-\s*티비위키)?\s*$"""), "")
            .trim()

    private fun formatEpisodeName(raw: String): String {
        val trimmed = raw.trim()
        val match = Regex("""(?:^|\s)(\d+(?:[-.]\d+)?화)""").find(trimmed)
        return match?.groupValues?.get(1) ?: trimmed
    }

    override fun videoListSelector(): String = throw UnsupportedOperationException()
    override fun videoFromElement(element: Element): Video = throw UnsupportedOperationException()
    override fun videoUrlParse(document: Document): String = throw UnsupportedOperationException()

    override fun getFilterList(): AnimeFilterList = AnimeFilterList(
        CategoryFilter(CATEGORIES),
        PeriodFilter(PERIODS),
        ModeFilter(MODES),
    )

    override fun setupPreferenceScreen(screen: PreferenceScreen) {
        val domainPref = EditTextPreference(screen.context).apply {
            key = PREF_DOMAIN_KEY
            title = "티비위키 주소 직접 지정 (선택)"
            summary = "빈 값이면 기본 주소를 사용합니다.\n현재 주소: $baseUrl"
            dialogTitle = "기본값: $DEFAULT_BASE_URL"
            dialogMessage = "https://tvwiki숫자.net 형식의 HTTPS 주소만 허용됩니다."
            setDefaultValue(DEFAULT_BASE_URL)

            setOnPreferenceChangeListener { _, newValue ->
                val newUrl = (newValue as String).trim().trimEnd('/')
                if (newUrl.isBlank()) {
                    preferences.edit().putString(PREF_DOMAIN_KEY, DEFAULT_BASE_URL).apply()
                    summary = "빈 값이면 기본 주소를 사용합니다.\n현재 주소: $DEFAULT_BASE_URL"
                    Toast.makeText(screen.context, "기본 주소로 초기화되었습니다.", Toast.LENGTH_SHORT).show()
                    true
                } else if (newUrl.matches(Regex("""^https://tvwiki\d+\.net$"""))) {
                    preferences.edit().putString(PREF_DOMAIN_KEY, newUrl).apply()
                    summary = "빈 값이면 기본 주소를 사용합니다.\n현재 주소: $newUrl"
                    Toast.makeText(screen.context, "주소가 변경되었습니다: $newUrl", Toast.LENGTH_SHORT).show()
                    true
                } else {
                    Toast.makeText(screen.context, "올바른 주소 형식이 아닙니다 (예: https://tvwiki51.net)", Toast.LENGTH_LONG).show()
                    false
                }
            }
        }
        screen.addPreference(domainPref)
    }

    class CategoryFilter(categories: Array<Pair<String, String>>) :
        AnimeFilter.Select<String>("카테고리", categories.map { it.first }.toTypedArray())

    class PeriodFilter(periods: Array<Pair<String, String>>) :
        AnimeFilter.Select<String>("기간 (인기탭)", periods.map { it.first }.toTypedArray())

    class ModeFilter(modes: Array<Pair<String, String>>) :
        AnimeFilter.Select<String>("정렬 방식", modes.map { it.first }.toTypedArray())

    companion object {
        private const val PREF_DOMAIN_KEY = "pref_domain_key"
        private const val DEFAULT_BASE_URL = "https://tvwiki51.net"

        private val CATEGORIES = arrayOf(
            Pair("전체", "all"),
            Pair("영화", "movie"),
            Pair("한국영화", "kor_movie"),
            Pair("드라마", "drama"),
            Pair("예능프로그램", "ent"),
            Pair("시사·다큐", "sisa"),
            Pair("해외드라마", "world"),
            Pair("해외 예능·다큐", "ott_ent"),
            Pair("숏폼 드라마", "short_drama"),
            Pair("극장판 애니", "ani_movie"),
            Pair("일반 애니", "animation"),
            Pair("추억의 예능", "old_ent"),
            Pair("추억의 드라마", "old_drama"),
        )

        private val PERIODS = arrayOf(
            Pair("일간", "d"),
            Pair("주간", "w"),
            Pair("월간", "m"),
            Pair("전체 기간", "a"),
        )

        private val MODES = arrayOf(
            Pair("최신순", "latest"),
            Pair("인기순", "popular"),
        )
    }
}
