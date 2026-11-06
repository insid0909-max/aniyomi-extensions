# 애니·드라마 확장 비교 자료

날짜별 폴더에 그날 받은 확장별 작품 목록(`확장키.tsv`)과 `요약.md`. 웹툰은 웹툰 저장소 `monitor/compare/`.

다시 비교하기:
```
for k in gogotv ohli24 aniwolf tvchak anilife kotbc; do
  node mangayomi/tools/compare/crawl.js $k mangayomi/tools/compare/날짜/$k.tsv &
done; wait
node mangayomi/tools/compare/analyze.js mangayomi/tools/compare/날짜
```
(mangayomi/tools/monitor/runtime.js 가 쓰는 linkedom 필요: `npm i --no-save linkedom`. 티비착·애니라이프·코티비씨는 해외에서 403 이라 한국에서 돌려야 받아짐)
