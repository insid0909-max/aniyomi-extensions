package eu.kanade.tachiyomi.animeextension.ko.tvroom

import eu.kanade.tachiyomi.animesource.model.SEpisode

/**
 * 영화 회차 이름 통일 (2026-11-06, 사용자 "통일시켜"): 확장마다 "바로보기"·"한글자막"·"애니감상"·"1. 극장판 X" 처럼 달라서
 * 회차가 하나뿐이고 회차 번호(N화·N회·EN)가 없으면 "본편" (자막·더빙 같은 구분은 괄호로). 망가요미 확장과 같은 기준
 */
internal object MovieName {
    private val NUM = Regex("""\d+\s*(?:화|회)|(?:^|\s)E\d+""", RegexOption.IGNORE_CASE)
    private val VARIANT = Regex("""바로\s*보기|본편|자막|더빙|애니감상""")
    private val TAG = Regex("""한글\s*자막|영어\s*자막|자막|더빙|무삭제|감독판|확장판""")
    private val LEAD = Regex("""^\s*\d+\s*(?:회)?\s*[.·]\s*""")
    private val TAIL_DATE = Regex("""\s*\(\d{2}\.\d{2}\)\s*$""")
    private val SPACES = Regex("""\s+""")

    private fun core(n: String) = n.replace(LEAD, "").replace(TAIL_DATE, "").trim()

    private fun hasNo(n: String) = NUM.containsMatchIn(core(n))

    private fun name(n: String): String {
        val tags = TAG.findAll(core(n)).map { it.value.replace(SPACES, "") }.distinct().toList()
        return if (tags.isEmpty()) "본편" else "본편 (${tags.joinToString(" · ")})"
    }

    fun isMovie(list: List<SEpisode>): Boolean = when {
        list.size == 1 -> !hasNo(list[0].name)
        list.size > 1 -> list.all { !hasNo(it.name) && VARIANT.containsMatchIn(core(it.name)) }
        else -> false
    }

    fun unify(list: List<SEpisode>): List<SEpisode> {
        if (isMovie(list)) list.forEach { it.name = name(it.name) }
        return list
    }
}
