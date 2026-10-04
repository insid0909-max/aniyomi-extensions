package eu.kanade.tachiyomi.animeextension.ko.tvroom

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
 * 확장앱 하나에 여러 소스를 담는 구조.
 * 소스를 늘리려면 아래 목록에 한 줄 추가하면 됩니다.
 */
class TVroomFactory : AnimeSourceFactory {
    override fun createSources(): List<AnimeSource> {
        val list = mutableListOf<AnimeSource>()
        try {
            list.add(TVroom()) // 티비위키
        } catch (e: Throwable) {
            list.add(ErrorSource("티비위키 오류", e))
        }
        try {
            list.add(GogoTV()) // 고고티비
        } catch (e: Throwable) {
            list.add(ErrorSource("고고티비 오류", e))
        }
        try {
            list.add(TVchak()) // 티비착
        } catch (e: Throwable) {
            list.add(ErrorSource("티비착 오류", e))
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
