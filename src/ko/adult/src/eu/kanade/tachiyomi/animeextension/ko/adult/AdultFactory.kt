package eu.kanade.tachiyomi.animeextension.ko.adult

import eu.kanade.tachiyomi.animesource.AnimeSource
import eu.kanade.tachiyomi.animesource.AnimeSourceFactory
import eu.kanade.tachiyomi.animesource.model.AnimeFilterList
import eu.kanade.tachiyomi.animesource.model.AnimesPage
import eu.kanade.tachiyomi.animesource.model.SAnime
import eu.kanade.tachiyomi.animesource.model.SEpisode
import eu.kanade.tachiyomi.animesource.online.AnimeHttpSource
import okhttp3.Request
import okhttp3.Response

/**
 * 성인 전용 확장 묶음 (2026-11-09, 사용자 요청: 개인 저장소 my-ext 의 망가요미 확장 3개를 애니요미로).
 * 애니요미는 성인 표시를 APK 단위로 붙여서 TVroom 과 따로 둠.
 */
class AdultFactory : AnimeSourceFactory {
    override fun createSources(): List<AnimeSource> {
        val list = mutableListOf<AnimeSource>()
        try {
            list.add(MissAV())
        } catch (e: Throwable) {
            list.add(ErrorSource("MissAV 오류", e))
        }
        try {
            list.add(XHamster())
        } catch (e: Throwable) {
            list.add(ErrorSource("xHamster 오류", e))
        }
        try {
            list.add(Avflix())
        } catch (e: Throwable) {
            list.add(ErrorSource("AVFLIX 오류", e))
        }
        return list
    }
}

/** 소스 생성이 실패해도 확장 전체가 사라지지 않고, 오류 내용을 소스 이름에 보여줌 */
class ErrorSource(label: String, err: Throwable) : AnimeHttpSource() {
    override val name = "$label: ${err.javaClass.simpleName} ${err.message ?: ""}".take(120)
    override val lang = "ko"
    override val baseUrl = "https://example.invalid"
    override val supportsLatest = false
    private fun fail(): Nothing = throw UnsupportedOperationException(name)
    override fun popularAnimeRequest(page: Int): Request = fail()
    override fun popularAnimeParse(response: Response): AnimesPage = fail()
    override fun latestUpdatesRequest(page: Int): Request = fail()
    override fun latestUpdatesParse(response: Response): AnimesPage = fail()
    override fun searchAnimeRequest(page: Int, query: String, filters: AnimeFilterList): Request = fail()
    override fun searchAnimeParse(response: Response): AnimesPage = fail()
    override fun animeDetailsParse(response: Response): SAnime = fail()
    override fun episodeListParse(response: Response): List<SEpisode> = fail()
}
