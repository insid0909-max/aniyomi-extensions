# 망가요미(Mangayomi)용 확장

Aniyomi 확장 중 망가요미에서 돌릴 수 있는 소스를 자바스크립트로 옮긴 것입니다.

| 소스 | 파일 | 비고 |
|---|---|---|
| 티비위키 | `javascript/anime/src/ko/tvwiki.js` | 중앙신호등 주소, 중계 서버 재생 |
| 고고티비 | `javascript/anime/src/ko/gogotv.js` | 영상 페이지·iframe·압축 스크립트에서 영상 주소를 찾음 |

실시간스포츠 1·2는 앱 안의 숨은 브라우저와 휴대폰 안 중계 서버가 필요해서 망가요미로 옮길 수 없습니다.

## 앱에 추가하기

망가요미 설정의 확장 저장소(Extension repository) 메뉴에서 아래 주소를 추가합니다.

```
https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/master/mangayomi/anime_index.json
```

## 수정할 때

소스 파일 맨 위 `mangayomiSources`의 `version`을 올리고, `anime_index.json`의 같은 소스 `version`도 똑같이 올려야 앱에 업데이트가 뜹니다.
