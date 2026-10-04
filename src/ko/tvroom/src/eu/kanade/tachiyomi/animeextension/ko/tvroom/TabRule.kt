package eu.kanade.tachiyomi.animeextension.ko.tvroom

import android.content.SharedPreferences
import eu.kanade.tachiyomi.animesource.model.AnimeFilter

/**
 * 인기/최신 탭에 필터 조건을 저장해 두는 기능 (실시간스포츠의 "탭 규칙"과 같은 방식).
 * 저장 값은 필터 선택 번호를 쉼표로 이은 문자열 (예: "1,0,2").
 */
internal object TabRule {
    private const val PREF_POP = "pref_pop_rule"
    private const val PREF_LATEST = "pref_latest_rule"

    // 번호 순서가 apply()의 처리와 일치해야 함
    private val CHOICES = arrayOf(
        "저장하지 않음 (필터 결과만 보기)",
        "현재 조건을 인기 탭에 저장",
        "현재 조건을 최신 탭에 저장",
        "인기 탭을 기본값으로 복원",
        "최신 탭을 기본값으로 복원",
        "두 탭 모두 기본값으로 복원",
    )

    class RuleFilter : AnimeFilter.Select<String>("인기/최신 탭 규칙", CHOICES)

    /** 저장된 조건. 없거나 선택지 개수가 바뀌어 맞지 않으면 null (= 기본값) */
    fun read(p: SharedPreferences?, popular: Boolean, sizes: IntArray): IntArray? {
        val raw = p?.getString(if (popular) PREF_POP else PREF_LATEST, null) ?: return null
        val idx = raw.split(",").map { it.toIntOrNull() ?: return null }
        if (idx.size != sizes.size || idx.indices.any { idx[it] !in 0 until sizes[it] }) return null
        return idx.toIntArray()
    }

    fun apply(p: SharedPreferences?, rule: Int, idx: IntArray) {
        val e = p?.edit() ?: return
        val value = idx.joinToString(",")
        when (rule) {
            1 -> e.putString(PREF_POP, value)
            2 -> e.putString(PREF_LATEST, value)
            3 -> e.remove(PREF_POP)
            4 -> e.remove(PREF_LATEST)
            5 -> e.remove(PREF_POP).remove(PREF_LATEST)
            else -> return
        }
        e.apply()
    }

    /** 필터 화면 맨 아래에 붙는 부분: 현재 저장 상태 + 규칙 선택 */
    fun filters(
        p: SharedPreferences?,
        sizes: IntArray,
        defaults: Pair<String, String>,
        text: (IntArray) -> String,
    ): List<AnimeFilter<*>> {
        val pop = read(p, true, sizes)?.let(text) ?: "${defaults.first} (기본)"
        val latest = read(p, false, sizes)?.let(text) ?: "${defaults.second} (기본)"
        return listOf(
            AnimeFilter.Separator(),
            AnimeFilter.Header("현재 인기: $pop"),
            AnimeFilter.Header("현재 최신: $latest"),
            RuleFilter(),
        )
    }
}
