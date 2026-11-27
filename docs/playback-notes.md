# 재생 방식 기록 (새 사이트 만들 때 참고)

## 공통 점검 순서
1. 회차 화면 HTML에서 iframe(data-src/src), m3u8, 토큰 문자열부터 찾는다.
2. 웹뷰 없이 일반 요청만으로 되는지 먼저 시험한다. 되면 가장 빠르고 안정적이다.
3. 막히면 사용자가 준 실제 m3u8 주소와 회차 HTML을 기준으로 단계별 진단(항목명 한 줄씩)으로 어디서 끊기는지 찾는다.
4. 앱 40초 제한: 큰 페이지 전체 분석은 멈출 수 있다. 빠른 길(정해진 경로만 따라가기)을 먼저, 실패하면 기존 분석으로 넘긴다.
5. 해외 IP는 대부분 Cloudflare 403이라 직접 시험 불가. 모의 시험 후 사용자 확인으로 검증한다.

## 후후티비 (hoohootv483.xyz, 주소 자주 바뀜: hs, ht, hu, hv)
- 회차 화면 iframe: vid.jwpcdn.net/video/embed/<id>/1280x720/<id> (세션 없음)
- embed 응답 안에 creatorofvideo.com/play/<player_uuid> 포함
- play 화면 인라인 스크립트에 window._HLS_PLAYLIST_TOKEN = "<JWT>" (30분, 접속 IP /64 묶임)
- 영상: creatorofvideo.com/hls/<segment_uuid>/1080p.m3u8?token=<JWT>&t=0 (720p, 480p, 360p 대안)
- 재생목록 200, 키 없음, 조각은 photoq.com 확장자 없는 정상 MPEG-TS
- 조각 요청은 Referer=play 주소, Origin=creatorofvideo.com 필요
- 웹뷰는 불필요했다. 웹뷰 의심은 추정이었고 틀렸다.
- 작품 화면 og:image는 사이트 기본 로고. 실제 표지는 목록 카드 이미지(data-src)를 기억해서 쓴다.

## 티비룸식
- stream/m3u8 + 키 복원(hhUnscramble) 패턴. 키가 가려져 있으면 이 방식.

## 야툰 영상
- 일반 요청으로 재생 성공(0.0.8). 정식판 공통 규칙(필터, 회차 정렬) 적용.

## 교훈
- 추정으로 우회책을 쌓기 전에 사용자의 실제 HTML, m3u8을 받아 구조부터 확정한다.
- 진단 결과는 앱 오류 화면(약 4줄)이나 영상 항목명 한 줄씩으로 내보낸다.
- 재생 시간은 재생목록 확인 생략처럼 불필요한 요청을 줄여 단축한다.
