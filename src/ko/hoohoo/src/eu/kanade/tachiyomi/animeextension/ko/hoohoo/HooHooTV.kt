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

    override val baseUrl = "https://fu.hoohootv458.xyz"

    override fun headersBuilder(): Headers.Builder = Headers.Builder()
        .add("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .add("Referer", "$baseUrl/")

    // --- 인기 탭 (두 번째 성공했던 /popular 복원) ---
    override fun popularAnimeRequest(page: Int): Request {
        val url = if (page <= 1) "$baseUrl/popular" else "$baseUrl/popular?page=$page"
        return GET(url, headers)
    }

    // 두 번째 목록 성공 셀렉터 기반 (메뉴 태그 제외를 위해 a[href] 필수 지정)
    override fun popularAnimeSelector(): String =
        "div.list-item, div.post-item, div.video-item, div.item:has(a), div.card:has(a), div.col-6:has(a), div.col-4:has(a), div.col-md-3:has(a)"

    override fun popularAnimeFromElement(element: Element): SAnime {
        return SAnime.create().apply {
            val titleElement = element.selectFirst(".title, .subject, .name, .entry-title, h2, h3, a[title]")
            val extractedTitle = titleElement?.attr("title")?.takeIf { it.isNotBlank() }
                ?: titleElement?.text()?.takeIf { it.isNotBlank() }
                ?: element.selectFirst("a")?.text()?.takeIf { it.isNotBlank() }
                ?: "제목 없음"
            title = extractedTitle.trim()

            val linkElement = element.selectFirst("a[href]")
            setUrlWithoutDomain(linkElement?.attr("href") ?: "")

            val img = element.selectFirst("img")
            thumbnail_url = img?.let {
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

    override fun popularAnimeNextPageSelector(): String? =
        ".pagination .next, a.next, a[rel='next'], li.next a, a:contains(다음)"

    // --- 최신 탭 (두 번째 성공했던 /home 복원) ---
    override fun latestUpdatesRequest(page: Int): Request {
        val url = if (page <= 1) "$baseUrl/home" else "$baseUrl/home?page=$page"
        return GET(url, headers)
    }

    override fun latestUpdatesSelector(): String = popularAnimeSelector()

    override fun latestUpdatesFromElement(element: Element): SAnime = popularAnimeFromElement(element)

    override fun latestUpdatesNextPageSelector(): String? = popularAnimeNextPageSelector()

    // --- 검색 ---
    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request {
        val url = if (page <= 1) {
            "$baseUrl/search?q=$query"
        } else {
            "$baseUrl/search?q=$query&page=$page"
        }
        return GET(url, headers)
    }

    override fun searchAnimeSelector(): String = popularAnimeSelector()

    override fun searchAnimeFromElement(element: Element): SAnime = popularAnimeFromElement(element)

    override fun searchAnimeNextPageSelector(): String? = popularAnimeNextPageSelector()

    // --- 상세 정보 ---
    override fun animeDetailsParse(document: Document): SAnime {
        return SAnime.create().apply {
            title = (document.selectFirst("h1, .entry-title, .title, .view-title")?.text() ?: "").trim()
            description = document.select(".desc, .summary, .view-content, .entry-content").text().trim()
            val img = document.selectFirst(".poster img, .view-wrap img, img.thumb")
            thumbnail_url = img?.let {
                it.attr("abs:data-src").ifEmpty {
                    it.attr("abs:data-original").ifEmpty {
                        it.attr("abs:src")
                    }
                }
            }
        }
    }

    // --- 회차 목록 (두 번째 1화~10화 파싱 성공했던 코드 그대로 유지) ---
    override fun episodeListSelector(): String =
        "ul.episodes a, div.ep-list a, .episode-item, ul.list-group li a, a[href*='watch'], a[href*='view'], a[href*='episode']"

    override fun episodeFromElement(element: Element): SEpisode {
        return SEpisode.create().apply {
            name = element.text().trim().ifEmpty { "회차 보기" }
            setUrlWithoutDomain(element.attr("href"))
        }
    }

    // --- 비디오 재생 링크 파싱 (플레이어 URL 다중 대응) ---
    override fun videoListParse(response: Response): List<Video> {
        val document = response.asJsoup()
        val videoList = mutableListOf<Video>()

        // 1. iframe 방식 (후후티비는 iframe src나 data-src에 실제 플레이어 주소를 둠)
        val iframes = document.select("iframe[src], iframe[data-src]")
        for (iframe in iframes) {
            val src = iframe.attr("abs:src").ifEmpty { iframe.attr("abs:data-src") }
            if (src.isNotBlank() && !src.contains("ad") && !src.contains("google")) {
                videoList.add(Video(src, "기본 화질 (Iframe)", src))
            }
        }

        // 2. 직접 비디오 태그
        val directSources = document.select("video source[src], video[src]")
        for (source in directSources) {
            val src = source.attr("abs:src")
            if (src.isNotBlank()) {
                videoList.add(Video(src, "직접 재생", src))
            }
        }

        // 3. 페이지 본문 script 안의 m3u8 / mp4 / iframe URL 정규식 추출
        if (videoList.isEmpty()) {
            val html = document.html()
            val m3u8Regex = """https?://[^\s"'<>]+\.m3u8[^\s"'<>]*""".toRegex()
            val mp4Regex = """https?://[^\s"'<>]+\.mp4[^\s"'<>]*""".toRegex()
            
            m3u8Regex.findAll(html).forEach { match ->
                videoList.add(Video(match.value, "HLS 스트림", match.value))
            }
            mp4Regex.findAll(html).forEach { match ->
                videoList.add(Video(match.value, "MP4 비디오", match.value))
            }
        }

        return videoList
    }

    override fun videoListSelector(): String = throw UnsupportedOperationException("Not used")
    override fun videoFromElement(element: Element): Video = throw UnsupportedOperationException("Not used")
    override fun videoUrlParse(document: Document): String = throw UnsupportedOperationException("Not used")
}
