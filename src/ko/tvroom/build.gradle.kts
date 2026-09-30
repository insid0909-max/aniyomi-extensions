plugins {
    id("com.android.application")
    id("kotlin-android")
}

// 워크플로우에서 전달한 extVersionCode를 최우선 적용, 없을 경우 기본값 21
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

// common.gradle이 계산한 버전을 최종 패키징 단계에서 확실히 강제 주입
android.applicationVariants.all {
    outputs.all {
        val output = this as? com.android.build.gradle.internal.api.BaseVariantOutputImpl
        output?.versionCodeOverride = extCode
        output?.versionNameOverride = "14.$extCode"
    }
}
