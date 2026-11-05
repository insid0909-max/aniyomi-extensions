package eu.kanade.tachiyomi.animeextension.ko.tvroom

import eu.kanade.tachiyomi.animesource.model.AnimesPage
import rx.Observable
import java.text.Normalizer

/**
 * 검색 띄어쓰기 (2026-11-05, 망가요미 JS 와 같은 규칙).
 * 사이트 검색이 띄어쓰기를 구분해 "나혼자만레벨업" 으로는 "나 혼자만 레벨업" 이 안 나오는 곳이 있음(애니24·애니울프 등).
 * 결과가 0개일 때만: ① 띄어쓰기를 뺀 검색어 ② 검색어 앞부분(절반) ③ 두 글자씩(앞에서부터) 으로 최대 6번 다시 찾아,
 * 띄어쓰기·기호를 빼고 비교했을 때 검색어가 들어 있는 작품만 보여 줌. 결과가 있거나 주소 붙여 넣기면 원래 그대로.
 */
object SearchSpacing {
    private val STRIP = Regex("""[\s\-_:·.,!?~'"()\[\]{}]""")

    private fun squash(s: String?): String = Normalizer.normalize(s.orEmpty(), Normalizer.Form.NFC).replace(STRIP, "").lowercase()

    fun wrap(page: Int, query: String, search: (String, Int) -> Observable<AnimesPage>): Observable<AnimesPage> {
        val q = query.trim()
        val first = search(query, page)
        if (q.isEmpty() || page > 1 || q.any { it == '/' || it == '.' || it == ':' }) return first
        return first.map { r -> if (r.animes.isNotEmpty()) r else retry(q, search) ?: r }
    }

    private fun retry(q: String, search: (String, Int) -> Observable<AnimesPage>): AnimesPage? {
        val want = squash(q)
        if (want.length < 2) return null
        val joined = q.replace(Regex("""\s+"""), "")
        val tries = LinkedHashSet<String>()
        if (joined != q) tries.add(joined)
        if (joined.length > 2) tries.add(joined.substring(0, maxOf(2, (joined.length + 1) / 2)))
        for (i in 0..joined.length - 2) tries.add(joined.substring(i, i + 2))
        for (t in tries.filter { it.length >= 2 && it != q }.take(6)) {
            val page = runCatching { search(t, 1).toBlocking().first() }.getOrNull() ?: continue
            val hit = page.animes.filter { squash(it.title).contains(want) }
            if (hit.isNotEmpty()) return AnimesPage(hit, false)
        }
        return null
    }
}
