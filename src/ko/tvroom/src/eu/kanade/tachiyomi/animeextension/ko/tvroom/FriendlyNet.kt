package eu.kanade.tachiyomi.animeextension.ko.tvroom

import okhttp3.Interceptor
import okhttp3.Response
import java.io.IOException

/**
 * 맨 바깥 가로채기: 주소를 못 찾는 오류(UnknownHost, 웹뷰의 ERR_NAME_NOT_RESOLVED 와 같은 것)를
 * 바로 할 일이 보이는 쉬운 말로 바꿈. 안쪽의 주소 찾기 등은 원래 오류를 그대로 보고 처리한 뒤라 동작은 같음.
 * (2026-11-03 뉴엑스툰 5: 새 주소가 막 생긴 직후·DNS 에 따라 앱에서만 주소를 못 찾던 일)
 */
internal object FriendlyNet : Interceptor {
    const val DNS_HELP = "사이트 주소를 찾지 못했어요. ① 잠시 뒤 다시 ② 앱을 완전히 껐다 켜기 " +
        "③ 유니콘 등 DNS 앱을 쓰면 DNS 를 Google 로 ④ 주소가 바뀌었으면 검색창에 새 주소 붙여 넣기"

    override fun intercept(chain: Interceptor.Chain): Response = try {
        chain.proceed(chain.request())
    } catch (e: java.net.UnknownHostException) {
        throw IOException("$DNS_HELP [${chain.request().url.host}]", e)
    }
}
