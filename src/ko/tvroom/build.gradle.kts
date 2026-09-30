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
        // common.gradle 이후에 외부 전달된 extCode를 확실히 덮어씀
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
