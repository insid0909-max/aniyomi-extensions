plugins {
    id("com.android.application")
    id("kotlin-android")
}

// CI의 sed 명령어로 주입되는 고정 버전 코드
val extCode = 8736

ext {
    set("extName", "LiveSports")
    set("extClass", ".LiveSports")
    set("extVersionCode", extCode)
}

apply(from = "$rootDir/common.gradle")

android {
    namespace = "eu.kanade.tachiyomi.animeextension.ko.livesports"

    defaultConfig {
        versionCode = extCode
        versionName = "14.$extCode"
    }

    signingConfigs {
        getByName("release") {
            // common.gradle에 정의된 공용 릴리즈 서명 키 그대로 사용
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    sourceSets {
        getByName("main") {
            res.srcDirs("res")
        }
    }
}

configurations.all {
    exclude(group = "com.github.inorichi.injekt")
}
