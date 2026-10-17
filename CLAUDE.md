# 작업 규칙 (Claude용)

- 사용자는 한국어로 대화하며 개발자가 아님. 답변은 한국어로, 쉽게.
- 사이트의 봇 차단·광고 확인·캡차·암호화·복사 방지를 우회하는 기능은 만들지 않음. 사이트를 직접 찾아 추가하지 않음.
- LiveTv는 방송사 공식 무료 스트림만 사용.

## 새 확장앱(애니·드라마·스포츠 등) 체크리스트 — 요청 없어도 기본 적용

사용자가 "빠진 기능"을 매번 말하지 않도록, 새 소스는 기존 앱(TVchak·GogoTV·HoohooTV)과 같은 기능을 처음부터 넣는다.

### Aniyomi (Kotlin, 예: src/ko/tvroom)
- 네트워크: `SiteRateLimit`, `PageCache`(상세 페이지), `RetryOnce`(GET 1회 재시도)
- 도메인: 기본 도메인 + 설정의 직접 입력 + 자동 찾기 스위치 + 자동 찾기(리다이렉트 저장, 실패 시 후보 탐색) + monitor/ExtStatus 연동(가능하면)
- 목록 탭 규칙: `TabRule`(인기/최신 탭을 필터 조합으로 지정)
- 필터: 사이트의 원래 분류 그대로 + 정렬/장르 등 사이트가 제공하는 것 전부
- 목록 카드/상세 제목: 방영 중 ` · MM.dd`(최근 회차 날짜), 종영 ` (yyyy)`; 상세 상태 ONGOING/COMPLETED
- 회차: `N회 (MM.dd)` 이름, 겹치지 않는 회차 번호, 날짜(dateUpload), 다중 시즌은 `시즌N ` 접두
- 검색: 상세 주소 붙여넣기로 바로 열기, `getAnimeUrl` 제공
- 영상: `HlsQuality`(variant 펼치기, 단일 화질 `라벨 1080p`, 자동 `자동 (최대 Np)`, 파일명 화질 `withRes`, 선호 화질 정렬·설정), 대체 서버/후보 수집("(대체 N)"), 재생 확인(works)
- WebView 탐지가 필요하면: 이미지·광고 차단, 처음엔 자동재생 막고(볼륨바 방지) 시간 초과 시 허용 후 재시도
- 분류별 소스(영화/드라마 등)는 `generateId(기본이름…)`로 설정 공유, 설정 화면은 기본 소스에만
- CI androidx stub 제약: `Preference(ctx)`/`isSelectable` 사용 금지 → EditText/Switch/ListPreference만
- 수정한 모듈의 extVersionCode 올리기, ktlint 통과

### Mangayomi (JS, mangayomi/javascript/anime/src/ko + anime_index.json)
- 위와 같은 기능 동일 적용(도메인 자동 찾기, 날짜/연도 표시, 화질 라벨·정렬, 대체 서버)
- 회차 이름은 회차 번호로 시작(맨 앞 숫자를 회차로 인식), 시즌은 `scanlator`에
- `selectFirst`는 비어도 truthy → `select().length` 사용; appClient는 UA 제거됨(원래 망가요미가 웹뷰 UA를 넣어 줌. 변형 앱 Mangayomi Glitch는 안 넣어 줘서 연결 끊김/403 → appClient가 UA 넣어 한 번 다시 보내고 이후 계속 넣음); followRedirects 옵션 무시됨
- 파일 버전과 anime_index.json 버전 같이 올리기, `node --check` 통과

## 지금까지 고친 것·배운 것 (다시 같은 실수 하지 않기)

### 앱 동작 (확장으로 못 바꾸는 것)
- 애니요미는 서재에 담긴 작품의 **제목을 갱신하지 않음** → 제목에 바뀌는 정보(방영일 " · MM.dd") 넣지 않음. 최근 방영일은 설명 맨 위("방영 중 · 최근 방영: yyyy.MM.dd (E)"). 종영·영화 " (yyyy)"는 유지. 망가요미는 서재 제목도 갱신되므로 그대로 둠.
- 애니요미/망가요미는 **회차 이름으로 다운로드를 찾음** → 회차 이름을 바꾸면 받은 회차가 안 받은 것처럼 보임을 사용자에게 알림.
- 앱의 `Video`는 data class가 아님 → `copy()` 쓰면 "No static method copy$default" 오류. 새 `Video(url, quality, videoUrl, headers)`로 만들 것.
- 망가요미는 필터를 돌려줄 때 `_status` 같은 사용자 정의 표시를 지움 → 상태 줄은 글자(📡/🩺/❌/🛡)로도 거를 것 (gogotv·livesports2·tvchak).
- 망가요미 목록 표지는 확장의 `getHeaders(url)`(UA + Referer)가 있어야 뜸.
- Mangayomi JS는 master raw에서 바로 배포(빌드 불필요), Kotlin APK는 master push CI(`build_push.yml`)로 배포. PR 검사(googledrive-extractor)는 원래 실패하므로 무시. 저장소 Actions가 꺼지면 빌드가 안 돌므로 사용자에게 켜 달라고 안내.

### 소스별
- 후후티비: 포스터는 사이트 주소(/media/poster_image)에 있음 → `SiteRateLimit(skipImages = true)`, 포스터 실패 시 0.8초 후 재시도, 포스터 실패는 주소 변경 신호로 보지 않음, 목록 끝 404는 "더 없음".
- 후후티비 재생: 플레이어가 재생해야 주소를 냄 → 자동재생이 필요한 플레이어 host를 기억(`pref_autoplay_hosts`)해 처음부터 음소거 자동재생, 숨은 WebView엔 영상 주소만 기록하고 빈 응답. 확장 처리 ≈2초, 나머지는 사이트·영상 서버 속도.
- 후후티비 주소: 앞 두 글자가 모두 바뀜(bd.hoohootv460 → al.hoohootv461) → 안내 사이트(hoohootv1.com) 주소를 먼저 확인, 1시간마다 가볍게 확인. 직접 넣은 주소(`pref_domain_key`)와 자동 주소(`pref_auto_found_domain`)는 따로 저장, 직접 넣은 주소가 끊기면 `pref_manual_dead_host`로 표시. 사이트 첫 화면(/)은 소개 페이지, 실제 목록은 /home.
- 후후티비 영화·드라마: 설정(주소·자동 찾기·화질)을 기본 후후티비와 공유하며 각 화면에도 표시.
- 후후티비 회차 날짜는 사이트가 대부분 안 줌(앱이 받은 날로 표시) — 확장으로 채울 수 없음.
- 고고티비: go.php 회차 링크는 만료됨 → 작품 페이지에서 재생 시 다시 찾음.
- 삼성 TV 플러스(LiveSports 모듈 SamsungTvPlus.kt + samsungtvplus.js): 삼성 공식 무료 채널. 목록·편성은 i.mjh.nz/SamsungTVPlus/.channels.json 의 regions.kr(안 되면 dc-toki-aniyomi-media.pages.dev m3u 사본), 영상은 jmp2.uk/stvp-{ID} → 삼성 공식 akamaized/mediatailor HLS(DRM 없음). 고고티비처럼 채널마다 카드(로고)·분류는 필터, 설명에 지금·다음 편성, 회차는 "🔴 실시간" 하나(scanlator에 편성). 사용자는 실시간스포츠식 묶음 카드보다 이 모양을 원함. 망가요미는 넘어간 최종 주소를 모르므로 자동 화질은 jmp2 주소 그대로.
- 삼성 TV 플러스 분류별 소스: 실시간/드라마/영화/뉴스/예능. Kotlin은 `SamsungTvPlus(fixedGroup)`(설정·채널 목록을 기본 소스와 공유, 화질 설정은 기본 소스 저장소에 같이 씀). 망가요미는 `samsungtvplus_{live,drama,movie,news,ent}.js` = samsungtvplus.js 복사본(이름·pkgPath·`STV_FIXED`만 다름, id 1543270621~625) → 원본 고치면 5개도 같이 다시 만들고 버전 같이 올릴 것. 망가요미는 소스마다 설정이 따로라 화질 설정은 각자. 기본 소스엔 인기/최신 탭 규칙(stv_tab_popular/stv_tab_latest, 최신 기본 "실시간").
- 애니라이프(TVroom 모듈 Anilife.kt + anilife.js, id 1543270630): 사이트가 해외 접속을 막음(403) → 개발 때는 web.archive.org 보관본(JS·API 응답)으로 구조 확인. 전부 JSON API: 목록 /api/anime?page&limit=24&scope(popular|updates)&status(방영중|완결)&day&genre&year&format(TV|Movie|OVA|ONA)&sort(popular|latest|rating|title)&q&v=catalog-media-2 (pagination.pages), 작품·회차 /api/anime/{id}?v=playback-url-v1 (item.episodes[].playbackUrl), 재생 /api/playback/{id}/{key}?request=… → {videoUrl, backupUrl, subtitleUrl}(VTT 자막은 늦게 생길 수 있음). 작품 주소 /content/{id}. 성인 분류(scope=adult)는 로그인 필요라 제외. 주소 anilife01.tv → 번호 2자리 유지하며 자동 찾기(표시 글자 "애니라이프"). 재생 API가 휴대폰에서 실패한 적 있음(원인 미확인) → Referer를 /content/{id}/{key}로, 실패하면 숨은 WebView로 /content/{id}/{key}를 열어 m3u8 요청을 받음(Kotlin). 재생 API는 휴대폰 앱에서 403(사이트 화면 안에서만 허용되는 듯) → 애니요미는 WebView로 재생됨 확인. 망가요미는 evaluateJavascriptViaWebview로 재생 화면을 열고 화면 안에서 API를 다시 묻거나 performance 기록의 m3u8을 돌려받음. 오류 메시지에 [API 실패 이유] 표시. 실제 영상은 aniplayer1.site/h/…/index.m3u8?md5&expires, 조각은 getvfa.site·noblepulse539.com 의 .jpg.
- 애니24(ohli24.net, TVroom 모듈 Ohli24.kt + ohli24.js, id 1543270631): 사이트는 해외에서도 열림, 영상 플레이어(michealcdn.com/video/{id})는 해외에서 404라 재생 미확인. 목록은 /index.php?s=api&c=api&m=template&format=jsonp&name={ong|list|movie}.html&catid={3|1|2}&order(updatetime|air_date|hits)&weeks(1=일…7=토,8=기타)&keyword(장르)&page → callback({"msg":HTML}), 카드 div.show-item(제목이 "..."로 잘리면 주소의 제목 부분 사용). 검색 /search/keyword-{q}.html, 2쪽부터 keyword-{q}-parent_id-0-page-N.html. 작품 /{번호}/{제목}.html: 분류는 breadcrumb(/ing·/finished·/movie), 정보 .article-box-meta li, 회차 .eps-box .eps-item a + .eps-date. 재생: 회차 화면 iframe#video → 플레이어 POST /player/index.php?data={id}&do=getVideo(hash,r) 응답의 m3u8(추측, 미확인) → 안 되면 WebView(망가요미는 evaluateJavascriptViaWebview + performance 기록). 휴대폰 확인: 애니요미 재생됨. 실제 플레이어 cdndania.com/video/{id}, 재생 목록은 확장자 없는 nnmo0oi1.com/m3/{base64} 와 /cdn/hls/{id}/master.txt (".m3u8"만 찾으면 못 찾음) → 망가요미는 /m3/·master.txt도 인정, 응답 JSON의 videoSource/securedLink 우선, 실패 이유를 오류 [ ]에 표시.
- 성능 변경은 한 번에 하나씩, 측정이 필요하면 임시 표시를 넣고 끝나면 반드시 뺄 것.
