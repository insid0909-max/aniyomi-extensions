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
import java.net.URLEncoder

class HooHooTV : ParsedAnimeHttpSource() {

    override val name = "후후티비"

    override val lang = "ko"

    override val supportsLatest = true

    override val client: OkHttpClient = network.cloudflareClient

    override val baseUrl = "https://fu.hoohootv458.xyz"

    override fun headersBuilder(): Headers.Builder = Headers.Builder()
        .add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .add("Referer", "$baseUrl/")

    // --- 인기 탭 (Popular) ---
    override fun popularAnimeRequest(page: Int): Request {
        val url = if (page <= 1) "$baseUrl/popular" else "$baseUrl/popular?page=$page"
        return GET(url, headers)
    }

    override fun popularAnimeSelector(): String =
        ".post-item, .list-item, .item, article, .card, div[class*='post'], div[class*='item'], div[class*='video-item'], div[class*='thumb']"

    override fun popularAnimeFromElement(element: Element): SAnime {
        return SAnime.create().apply {
            val titleElement = element.selectFirst(".title, .post-title, .entry-title, h2, h3, a[title], .subject")
            title = (titleElement?.attr("title")?.takeIf { it.isNotBlank() }
                ?: titleElement?.text()
                ?: element.selectFirst("a")?.text()
                ?: "제목 없음").trim()

            val linkElement = element.selectFirst("a[href*='/']") ?: element
            setUrlWithoutDomain(linkElement.attr("href"))

            val imgElement = element.selectFirst("img")
            thumbnail_url = imgElement?.let {
                it.attr("abs:data-src").ifEmpty {
                    it.attr("abs:data-original").ifEmpty {
                        it.attr("abs:data-lazy-src").ifEmpty {
                            it.attr("abs:src")
                        }
                    }
                }
            }
        }
    }

    override fun popularAnimeNextPageSelector(): String? = ".pagination .next, a.next, .nav-links .next, a[rel='next']"

    // --- 최신 탭 (Home) ---
    override fun latestUpdatesRequest(page: Int): Request {
        val url = if (page <= 1) "$baseUrl/home" else "$baseUrl/home?page=$page"
        return GET(url, headers)
    }

    override fun latestUpdatesSelector(): String = popularAnimeSelector()

    override fun latestUpdatesFromElement(element: Element): SAnime = popularAnimeFromElement(element)

    override fun latestUpdatesNextPageSelector(): String? = popularAnimeNextPageSelector()

    // --- 검색 ---
    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        val encodedQuery = URLEncoder.encode(query, "UTF-8")
        val url = if (page <= 1) {
            "$baseUrl/?s=$encodedQuery"
        } else {
            "$baseUrl/page/$page/?s=$encodedQuery"
        }
        return GET(url, headers)
    }

    override fun searchAnimeSelector(): String = popularAnimeSelector()

    override fun searchAnimeFromElement(element: Element): SAnime = popularAnimeFromElement(element)

    override fun searchAnimeNextPageSelector(): String? = popularAnimeNextPageSelector()

    // --- 상세 정보 ---
    override fun animeDetailsParse(document: Document): SAnime {
        return SAnime.create().apply {
            title = (document.selectFirst("h1, .entry-title, .post-title, .title")?.text() ?: "").trim()
            description = document.select(".desc, .summary, .entry-content, .post-content").text().trim()
            val img = document.selectFirst(".poster img, .entry-content img, .post-thumbnail img, img[class*='poster']")
            thumbnail_url = img?.let {
                it.attr("abs:data-src").ifEmpty {
                    it.attr("abs:data-original").ifEmpty {
                        it.attr("abs:src")
                    }
                }
            }
        }
    }

    // --- 회차 목록 ---
    override fun episodeListSelector(): String =
        ".episodes a, .ep-list a, .episode-item, ul.list-group li a, a[href*='episode'], a[href*='watch'], a[href*='view']"

    override fun episodeFromElement(element: Element): SEpisode {
        return SEpisode.create().apply {
            name = element.text().trim().ifEmpty { "회차 바로보기" }
            setUrlWithoutDomain(element.attr("href"))
        }
    }

    // --- 비디오 재생 링크 파싱 (iframe, 버튼, 스트립트 추출) ---
    override fun videoListParse(response: Response): List<Video> {
        val document = response.asJsoup()
        val videoList = mutableListOf<Video>()

        // 1. iframe 추출
        val iframes = document.select("iframe[src], iframe[data-src]")
        for (iframe in iframes) {
            val src = iframe.attr("abs:src").ifEmpty { iframe.attr("abs:data-src") }
            if (src.isNotBlank() && !src.contains("google") && !src.contains("ad")) {
                videoList.add(Video(src, "재생 서버 (Iframe)", src))
            }
        }

        // 2. 외부 재생 버튼 추출
        val playButtons = document.select("a[href*='stream'], a[href*='play'], a[href*='watch'], a[href*='embed']")
        for (btn in playButtons) {
            val link = btn.attr("abs:href")
            if (link.isNotBlank()) {
                val label = btn.text().trim().ifEmpty { "외부 플레이어" }
                videoList.add(Video(link, label, link))
            }
        }

        // 3. 본문 스크립트 내부 주소(m3u8, mp4) 추출
        val html = document.html()
        val m3u8Matches = """https?://[^\s"'<>]+\.m3u8[^\s"'<>]*""".toRegex().findAll(html)
        for (m in m3u8Matches) {
            videoList.add(Video(m.value, "HLS 고화질 스트림", m.value))
        }

        val mp4Matches = """https?://[^\s"'<>]+\.mp4[^\s"'<>]*""".toRegex().findAll(html)
        for (m in mp4Matches) {
            videoList.add(Video(m.value, "MP4 직접 재생", m.value))
        }

        return videoList
    }

    override fun videoListSelector(): String = throw UnsupportedOperationException("Not used")
    override fun videoFromElement(element: Element): Video = throw UnsupportedOperationException("Not used")
    override fun videoUrlParse(document: Document): String = throw UnsupportedOperationException("Not used")
}
