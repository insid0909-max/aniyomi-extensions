# 시험 저장소 (망가요미)

새 확장이나 큰 수정을 정식 배포 전에 휴대폰에서 시험하는 곳.

- 망가요미 애니 칸에 추가할 주소:
  `https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/test/index.json`
- 시험판은 이름 앞에 "[시험]", 정식판과 다른 시험용 id 사용.
- 확장 파일은 `js/` 에 두고 `sourceCodeUrl` 은 이 가지(test) 주소.
- 휴대폰에서 잘 되면 master 의 `mangayomi/javascript/anime/src/ko/` 와 `anime_index.json` 에 정식 id 로 올리고, 여기서는 지움.
- 이 가지에 올려도 빌드·배포 작업은 돌지 않음.

## 모에니 0.0.6 재생 시험

전체 Blob HLS 목록과 실제 `gets` 헤더를 같은 기기의 Node 프록시로 인계하는 시험판이다. 프록시 없이 확장만 업데이트하면 Blob 회차는 재생되지 않으며, Android 실기기·전체 회차 완주·자막·토큰 만료는 미검증이다.

- 실행 안내: [모에니 0.0.6 시험 절차](https://github.com/insid0909-max/aniyomi-extensions/blob/test/docs/moeni-0.0.6.md)
- 프록시: [moeni-loopback-bridge.cjs](https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/test/tools/moeni-loopback-bridge.cjs)
- 같은 휴대폰의 Termux 등에서 Node 20 이상으로 프록시를 실행하고, 시작 화면의 등록 키를 확장 설정에 입력한다.
