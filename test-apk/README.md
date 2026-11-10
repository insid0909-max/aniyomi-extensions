# 애니요미 시험 저장소 (시험 APK)

망가요미 시험 저장소(`test` 가지)와 따로 관리. 정식 APK 와 **같이 설치돼도 서로 덮어쓰지 않음.**

- 애니요미 → 확장 저장소에 추가할 주소:
  `https://raw.githubusercontent.com/insid0909-max/aniyomi-extensions/apk-test/index.min.json`
- 시험 APK 는 패키지 이름 뒤 `.test`, 앱 이름 "Aniyomi: TVroom (test)", 소스 이름 앞 "[시험]" → 소스 번호·설정·서재가 정식판과 따로 (시험판으로 서재에 담은 작품은 정식판으로 안 옮겨짐)
- 서명 키도 정식과 다름(`signingkey-test.jks`, 첫 빌드 때 자동 생성)

## 쓰는 법
1. 시험할 코드를 이 `test-apk` 가지에 올림(정식 코드가 바뀌었으면 master 를 먼저 합쳐 옴).
2. `test-apk/modules.txt` 에 빌드할 모듈(tvroom·livesports·adult)과 칸을 적음.
3. 올리면 자동으로 빌드(`.github/workflows/test_apk.yml`) → `apk-test` 가지에 시험 저장소가 만들어짐.
4. 휴대폰에서 잘 되면 칸을 "배포전" 으로 바꾸고, **사용자가 허락할 때만** master 에 합쳐 정식 배포.

## 지금 들어 있는 시험 APK
| 칸 | 모듈 | 메모 |
|---|---|---|
| 시험중 | tvroom | 시험 저장소 첫 설치 확인용 (코드는 정식판과 같음) |

빌드 때만 바뀌는 것(`test-apk/prepare.py`): common.gradle 패키지·앱 이름, 소스 이름·generateId 이름에 "[시험] ". 가지의 파일 자체는 정식 코드와 같게 둠(정식 배포 때 그대로 합칠 수 있게).
