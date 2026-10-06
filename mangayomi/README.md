# 망가요미(Mangayomi)용 확장

Aniyomi 확장 중 망가요미에서 돌릴 수 있는 소스를 자바스크립트로 옮긴 것입니다.

| 소스 | 파일 | 비고 |
|---|---|---|
| 고고티비 | `javascript/anime/src/ko/gogotv.js` | 영상 페이지·iframe·압축 스크립트에서 영상 주소를 찾음 |
| 실시간스포츠2 | `javascript/anime/src/ko/livesports2.js` | 통티비 경기 API. 플레이어 페이지에서 m3u8을 찾아 헤더를 붙여 바로 재생 (Aniyomi의 "직접" 재생 방식) |
| 라이브TV | `javascript/anime/src/ko/livetv.js` | 방송사 공식 무료 실시간 채널 (본방송·MBC/SBS/KBS 24시 정주행·지역/종교/공공). 방송사 공식 플레이어 주소에서 m3u8을 받아 재생. 대부분 한국에서만 재생 |

실시간스포츠(njtv)는 경기 목록이 브라우저 안에서만 풀리는 암호화 데이터라 망가요미로 옮길 수 없습니다.

## 앱에 추가하기

망가요미 설정의 확장 저장소(Extension repository) 메뉴에서 아래 주소를 추가합니다.

```
https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/mangayomi/anime_index.json
```

## 수정할 때

소스 파일 맨 위 `mangayomiSources`의 `version`을 올리고, `anime_index.json`의 같은 소스 `version`도 똑같이 올려야 앱에 업데이트가 뜹니다.
