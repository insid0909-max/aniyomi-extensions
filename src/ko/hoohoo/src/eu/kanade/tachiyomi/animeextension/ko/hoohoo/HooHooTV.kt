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

    // --- 인기 탭 ---
    override fun popularAnimeRequest(page: Int): Request {
        val url = if (page <= 1) "$baseUrl/popular" else "$baseUrl/popular?page=$page"
        return GET(url, headers)
    }

    // 상세(/detail/) 링크를 가진 카드만 정확히 타겟팅 (상단 메뉴/사이트 헤더 혼입 방지)
    override fun popularAnimeSelector(): String =
        "a[href*='/detail/']:has(img), div.item:has(a[href*='/detail/']), div.post-item:has(a[href*='/detail/'])"

    override fun popularAnimeFromElement(element: Element): SAnime {
        return SAnime.create().apply {
            val anchor = if (element.tagName() == "a") element else element.selectFirst("a[href*='/detail/']") ?: element
            setUrlWithoutDomain(anchor.attr("href"))

            // 제목 추출 (사이트 공통 문구 배제)
            val titleNode = element.selectFirst(".title, .subject, .name, h2, h3, a[title]")
            val rawTitle = titleNode?.attr("title")?.takeIf { it.isNotBlank() }
                ?: titleNode?.text()?.takeIf { it.isNotBlank() }
                ?: anchor.attr("title").takeIf { it.isNotBlank() }
                ?: anchor.text().takeIf { it.isNotBlank() }
                ?: "제목 없음"
            title = cleanTitle(rawTitle)

            // 썸네일 추출
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

    override fun popularAnimeNextPageSelector(): String? = ".pagination .next, a.next, .nav-links .next, a[rel='next']"

    // --- 최신 탭 ---
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

    // --- 상세 정보 (사이트 헤더 문구로 덮어쓰기 방지) ---
    override fun animeDetailsParse(document: Document): SAnime {
        return SAnime.create().apply {
            // 상세 페이지 내의 실제 콘텐츠 제목 태그 추출
            val titleNode = document.selectFirst(".detail-title, .content-title, .view-title, h1:not(:contains(후후티비)), h2:not(:contains(후후티비))")
            val extractedTitle = titleNode?.text()?.trim()
            if (!extractedTitle.isNullOrBlank()) {
                title = cleanTitle(extractedTitle)
            }

            description = document.select(".desc, .summary, .detail-desc, .content-desc, .entry-content").text().trim()
            
            val img = document.selectFirst(".poster img, .detail-thumb img, .view-thumb img, img.poster")
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
        "a[href*='/watch/'], a[href*='/view/'], a[href*='/play/'], .episodes a, .ep-list a, .episode-item, ul.list-group li a"

    override fun episodeFromElement(element: Element): SEpisode {
        return SEpisode.create().apply {
            name = element.text().trim().ifEmpty { "회차 바로보기" }
            setUrlWithoutDomain(element.attr("href"))
        }
    }

    // --- 비디오 재생 링크 파싱 ---
    override fun videoListParse(response: Response): List<Video> {
        val document = response.asJsoup()
        val videoList = mutableListOf<Video>()

        // 1. iframe 주소
        val iframes = document.select("iframe[src], iframe[data-src]")
        for (iframe in iframes) {
            val src = iframe.attr("abs:src").ifEmpty { iframe.attr("abs:data-src") }
            if (src.isNotBlank() && !src.contains("google") && !src.contains("ad")) {
                videoList.add(Video(src, "기본 재생 서버", src))
            }
        }

        // 2. 외부 재생 버튼 및 플레이어 링크
        val playButtons = document.select("a[href*='stream'], a[href*='play'], a[href*='watch'], a[href*='embed']")
        for (btn in playButtons) {
            val link = btn.attr("abs:href")
            if (link.isNotBlank() && !link.startsWith(baseUrl)) {
                val label = btn.text().trim().ifEmpty { "외부 플레이어" }
                videoList.add(Video(link, label, link))
            }
        }

        // 3. 본문 스크립트 스트리밍 주소(m3u8, mp4)
        val html = document.html()
        """https?://[^\s"'<>]+\.m3u8[^\s"'<>]*""".toRegex().findAll(html).forEach {
            videoList.add(Video(it.value, "고화질 스트림 (m3u8)", it.value))
        }
        """https?://[^\s"'<>]+\.mp4[^\s"'<>]*""".toRegex().findAll(html).forEach {
            videoList.add(Video(it.value, "직접 재생 (mp4)", it.value))
        }

        return videoList
    }

    override fun videoListSelector(): String = throw UnsupportedOperationException("Not used")
    override fun videoFromElement(element: Element): Video = throw UnsupportedOperationException("Not used")
    override fun videoUrlParse(document: Document): String = throw UnsupportedOperationException("Not used")

    // 제목 정리 헬퍼 함수
    private fun cleanTitle(raw: String): String {
        return raw.replace(Regex("후후티비.*"), "").trim().ifEmpty { raw.trim() }
    }
}
