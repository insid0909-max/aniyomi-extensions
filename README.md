# 시험 저장소 (망가요미)

새 확장이나 큰 수정을 정식 배포 전에 휴대폰에서 시험하는 곳.

- 망가요미 애니 칸에 추가할 주소:
  `https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/test/index.json`
- 시험판은 이름 앞에 "[시험]", 정식판과 다른 시험용 id 사용.
- 확장 파일은 `js/` 에 두고 `sourceCodeUrl` 은 이 가지(test) 주소.
- 휴대폰에서 잘 되면 master 의 `mangayomi/javascript/anime/src/ko/` 와 `anime_index.json` 에 정식 id 로 올리고, 여기서는 지움.
- 이 가지에 올려도 빌드·배포 작업은 돌지 않음.
