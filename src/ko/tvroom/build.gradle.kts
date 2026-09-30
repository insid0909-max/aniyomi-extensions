plugins {
    id("com.android.application")
    id("kotlin-android")
}

// 워크플로우에서 -PextVersionCode로 넘겨준 값을 최우선 적용, 기본값은 21
val extCode = if (project.hasProperty("extVersionCode")) {
    project.property("extVersionCode").toString().toInt()
} else {
    21
}

ext {
    set("extName", "TVroom")
    set("extClass", ".TVroom")
    set("extVersionCode", extCode)
}

apply(from = "$rootDir/common.gradle")

android {
    namespace = "eu.kanade.tachiyomi.animeextension.ko.tvroom"

    defaultConfig {
        // common.gradle 적용 후 최종 패키징 버전을 extCode 값으로 명시적 고정
        versionCode = extCode
        versionName = "14.$extCode"
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
