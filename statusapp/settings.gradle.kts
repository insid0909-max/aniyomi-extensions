// 확장 상태판 앱 (2026-11-14, 사용자 "apk 설치 가능하게 위젯까지" → "알림도 넣고 시험판 진행")
// 애니요미 확장과 따로인 작은 앱 — 이 폴더만으로 빌드됨 (../gradlew -p statusapp assembleRelease)
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "statusboard"
