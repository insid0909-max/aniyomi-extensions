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
- `selectFirst`는 비어도 truthy → `select().length` 사용; appClient는 UA 제거됨; followRedirects 옵션 무시됨
- 파일 버전과 anime_index.json 버전 같이 올리기, `node --check` 통과
