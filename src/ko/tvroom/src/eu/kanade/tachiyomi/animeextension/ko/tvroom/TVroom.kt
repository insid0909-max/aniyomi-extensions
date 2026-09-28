package eu.kanade.tachiyomi.animeextension.ko.tvroom

import android.util.Base64
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
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element
import java.net.URLEncoder

class TVroom : ParsedAnimeHttpSource() {

    override val name = "티비위키"
    override val baseUrl = "https://tvwiki51.net"
    override val lang = "ko"
    override val supportsLatest = true

    override val client: OkHttpClient = network.client

    private val bridgeBaseUrl = "https://dc-toki-mangayomi-media.pages.dev"
    private val userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

    override fun headersBuilder(): Headers.Builder = Headers.Builder()
        .add("User-Agent", userAgent)
        .add("Referer", "$baseUrl/")

    // ============================== 인기 목록 ==============================
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

    // ============================== 최신 목록 ==============================
    override fun latestUpdatesRequest(page: Int): Request =
        GET("$baseUrl/drama?page=$page", headers)

    override fun latestUpdatesSelector(): String = popularAnimeSelector()
    override fun latestUpdatesFromElement(element: Element): SAnime = popularAnimeFromElement(element)
    override fun latestUpdatesNextPageSelector(): String? = popularAnimeNextPageSelector()
    override fun latestUpdatesParse(response: Response): AnimesPage = popularAnimeParse(response)

    // ============================== 검색 및 필터 ==============================
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

    // ============================== 상세 정보 ==============================
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

    // ============================== 회차 목록 ==============================
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

    // ============================== 비디오 재생 파싱 (망가요미 동일 복호화/브릿지 이식) ==============================
    override fun videoListParse(response: Response): List<Video> {
        val episodePath = response.request.url.encodedPath
        val parts = episodePath.trim('/').split("/")
        if (parts.size < 3) {
            return fallbackVideoParse(response)
        }

        val boTable = parts[0]
        val wrId = parts[1]
        val epIdx = parts[2]

        // 1. 회차 메타데이터 호출
        val metaUrl = "$baseUrl/bbs/get_episode.php?bo_table=$boTable&wr_id=$wrId&ep_idx=$epIdx"
        val metaHeaders = Headers.Builder()
            .add("User-Agent", userAgent)
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

        // 2. 세션 발급 (브릿지 우선 -> 사이트 직접 시도)
        var sessionJson: JSONObject? = null
        for (payload in sessionDataList) {
            val payloadStr = payload.toString()

            // 2-1. 브릿지 세션 시도
            runCatching {
                val bridgeReqObj = JSONObject().apply {
                    put("baseUrl", baseUrl)
                    put("episodePath", episodePath)
                    put("sessionData", if (payloadStr.startsWith("{")) JSONObject(payloadStr) else payloadStr)
                }
                val bridgeHeaders = Headers.Builder()
                    .add("User-Agent", userAgent)
                    .add("Referer", "$bridgeBaseUrl/")
                    .add("Content-Type", "application/json; charset=utf-8")
                    .build()
                val reqBody = bridgeReqObj.toString().toRequestBody("application/json; charset=utf-8".toMediaType())
                val bridgeRes = client.newCall(POST("$bridgeBaseUrl/api/tvwiki-session", bridgeHeaders, reqBody)).execute()
                val resJson = JSONObject(bridgeRes.body.string())
                if (resJson.optBoolean("success", false) && resJson.has("player_url")) {
                    sessionJson = resJson
                }
            }
            if (sessionJson != null) break

            // 2-2. 사이트 직접 세션 시도
            runCatching {
                val directHeaders = Headers.Builder()
                    .add("User-Agent", userAgent)
                    .add("Referer", "$baseUrl$episodePath")
                    .add("Origin", baseUrl)
                    .add("Content-Type", "application/json; charset=utf-8")
                    .build()
                val reqBody = payloadStr.toRequestBody("application/json; charset=utf-8".toMediaType())
                val directRes = client.newCall(POST("$baseUrl/api/create_session.php", directHeaders, reqBody)).execute()
                val resJson = JSONObject(directRes.body.string())
                if (resJson.optBoolean("success", false) && resJson.has("player_url")) {
                    sessionJson = resJson
                }
            }
            if (sessionJson != null) break
        }

        if (sessionJson == null) {
            return fallbackVideoParse(response)
        }

        // 3. 토큰 결합 플레이어 URL & 플레이리스트 URL 완성
        val rawPlayerUrl = sessionJson.getString("player_url")
        val sep = if (rawPlayerUrl.contains("?")) "&" else "?"
        val playerUrl = resolveAbsolute("$baseUrl$episodePath", rawPlayerUrl) +
            "${sep}t=${URLEncoder.encode(sessionJson.optString("t"), "UTF-8")}&sig=${URLEncoder.encode(sessionJson.optString("sig"), "UTF-8")}"

        val playlistUrl = resolveAbsolute(playerUrl, rawHlsUrl)

        val playerOrigin = runCatching {
            val u = okhttp3.HttpUrl.parse(playerUrl)
            "${u?.scheme}://${u?.host}"
        }.getOrDefault(baseUrl)

        val streamHeaders = Headers.Builder()
            .add("User-Agent", userAgent)
            .add("Accept", "*/*")
            .add("Referer", playerUrl)
            .add("Origin", playerOrigin)
            .build()

        // 4. 플레이리스트 다운로드 및 EXT-X-KEY 암호화 키 확인
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

            // 호환 중계 (403 100% 우회 스트림)
            videoList.add(Video("$bridgeBaseUrl/api/tvwiki-playlist.m3u8?m=p&$common", "호환 재생 (중계)", "$bridgeBaseUrl/api/tvwiki-playlist.m3u8?m=p&$common", headers = streamHeaders))
            // CDN 직결
            videoList.add(Video("$bridgeBaseUrl/api/tvwiki-playlist.m3u8?m=f&$common", "빠른 재생 (CDN 직접)", "$bridgeBaseUrl/api/tvwiki-playlist.m3u8?m=f&$common", headers = streamHeaders))
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

    // ============================== 헬퍼 함수 ==============================
    private fun toBase64Url(value: String): String {
        return Base64.encodeToString(value.toByteArray(Charsets.UTF_8), Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING).trim()
    }

    private fun resolveAbsolute(base: String, target: String): String {
        val t = target.trim()
        if (t.startsWith("http://") || t.startsWith("https://")) return t
        if (t.startsWith("//")) return "https:$t"
        return if (t.startsWith("/")) {
            val baseUri = okhttp3.HttpUrl.parse(base)
            "${baseUri?.scheme}://${baseUri?.host}$t"
        } else {
            val dir = base.substringBeforeLast('/')
            "$dir/$t"
        }
    }

    private fun fixUrl(url: String): String = when {
        url.startsWith("//") -> "https:$url"
        url.startsWith("/") -> "$baseUrl$url
