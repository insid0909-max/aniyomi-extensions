package eu.kanade.tachiyomi.animeextension.ko.adult

import android.app.Application
import android.webkit.WebSettings

/**
 * 휴대폰 웹뷰의 실제 User-Agent (2026-11-09, 애니야24 "인증 반복").
 * 애니요미 기본 User-Agent 는 PC 크롬 이름이라, 휴대폰 웹뷰에서 푼 Cloudflare 확인이 이름이 달라 계속 다시 걸림
 * → Cloudflare 를 쓰는 사이트는 요청·웹뷰 모두 이 값을 써서 통과 쿠키가 맞게 함. 못 읽으면 null (앱 기본값 그대로)
 */
internal object WebUa {
    private val CACHED: String? by lazy {
        runCatching {
            val app = Class.forName("android.app.ActivityThread")
                .getMethod("currentApplication").invoke(null) as Application
            WebSettings.getDefaultUserAgent(app)
        }.getOrNull()?.takeIf { it.isNotBlank() }
    }

    fun value(): String? = CACHED
}
