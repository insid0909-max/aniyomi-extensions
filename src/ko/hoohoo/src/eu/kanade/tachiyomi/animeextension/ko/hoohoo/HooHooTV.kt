package eu.kanade.tachiyomi.animeextension.ko.hoohoo

import eu.kanade.tachiyomi.animesource.model.AnimeFilterList
import eu.kanade.tachiyomi.animesource.model.SAnime
import eu.kanade.tachiyomi.animesource.model.SEpisode
import eu.kanade.tachiyomi.animesource.model.Video
import eu.kanade.tachiyomi.animesource.online.ParsedAnimeHttpSource
import eu.kanade.tachiyomi.network.GET
import eu.kanade.tachiyomi.util.asJsoup
import okhttp3.Headers
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.jsoup.nodes.Document
import org.jsoup.nodes.Element

class HooHooTV : ParsedAnimeHttpSource() {

    override val name = "후후티비"

    override val lang = "ko"

    override val supportsLatest = true

    override val client: OkHttpClient = network.cloudflareClient

    // --- 신호등(다중 우회 도메인) 후보 목록 ---
    private val candidateDomains = listOf(
        "https://fq.hoohootv458.xyz",
        "https://hoohootv.net",
        "https://hoohootv.com",
        "https://hoohootv.org",
    )

    private var activeBaseUrl: String = candidateDomains.first()

    override val baseUrl: String
        get() = activeBaseUrl

    override fun headersBuilder(): Headers.Builder = Headers.Builder()
        .add(
            "User-Agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .add("Referer", baseUrl)

    // 신호등: 정상 응답(200 OK)이 오는 도메인을 찾아 baseUrl 갱신
    private fun getWorkingUrl(endpoint: String = "/home"): String {
        for (domain in candidateDomains) {
            try {
                val req = Request.Builder()
                    .url("$domain$endpoint")
                    .headers(headers)
                    .head()
                    .build()
                client.newCall(req).execute().use { res ->
                    if (res.isSuccessful) {
                        activeBaseUrl = domain
                        return "$domain$endpoint"
                    }
                }
            } catch (_: Exception) {
                // 접속 불가 시 다음 도메인 탐색
            }
        }
        return "$activeBaseUrl$endpoint"
    }

    // --- 인기 목록 ---
    override fun popularAnimeRequest(page: Int): Request {
        val targetUrl = getWorkingUrl("/home")
        return GET(targetUrl, headers)
    }

    override fun popularAnimeSelector(): String = "div.item, div.post-item, .list-item"

    override fun popularAnimeFromElement(element: Element): SAnime {
        return SAnime.create().apply {
            title = element.select("a, .title").text().trim()
            setUrlWithoutDomain(element.select("a").attr("href"))
            thumbnail_url = element.select("img").attr("abs:src")
        }
    }

    override fun popularAnimeNextPageSelector(): String? = null

    // --- 최신 목록 ---
    override fun latestUpdatesRequest(page: Int): Request = popularAnimeRequest(page)

    override fun latestUpdatesSelector(): String = popularAnimeSelector()

    override fun latestUpdatesFromElement(element: Element): SAnime = popularAnimeFromElement(element)

    override fun latestUpdatesNextPageSelector(): String? = null

    // --- 검색 ---
    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        return GET("$baseUrl/search?q=$query", headers)
    }

    override fun searchAnimeSelector(): String = popularAnimeSelector()

    override fun searchAnimeFromElement(element: Element): SAnime = popularAnimeFromElement(element)

    override fun searchAnimeNextPageSelector(): String? = null

    // --- 상세 정보 ---
    override fun animeDetailsParse(document: Document): SAnime {
        return SAnime.create().apply {
            title = document.select("h1, .entry-title").text().trim()
            description = document.select(".desc, .summary").text().trim()
        }
    }

    // --- 회차 목록 ---
    override fun episodeListSelector(): String = "ul.episodes li, .ep-list a, .episode-item"

    override fun episodeFromElement(element: Element): SEpisode {
        return SEpisode.create().apply {
            name = element.text().trim()
            setUrlWithoutDomain(element.attr("href"))
        }
    }

    // --- 비디오 링크 추출 ---
    override fun videoListParse(response: Response): List<Video> {
        val document = response.asJsoup()
        val videoUrl = document.select("iframe").attr("src")
        return if (videoUrl.isNotEmpty()) {
            listOf(Video(videoUrl, "기본 화질", videoUrl))
        } else {
            emptyList()
        }
    }

    override fun videoListSelector(): String = throw UnsupportedOperationException("Not used")
    override fun videoFromElement(element: Element): Video = throw UnsupportedOperationException("Not used")
    override fun videoUrlParse(document: Document): String = throw UnsupportedOperationException("Not used")
}
