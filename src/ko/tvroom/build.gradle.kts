plugins {
    id("com.android.application")
    id("kotlin-android")
}

val extCode = if (project.hasProperty("extVersionCode")) {
    project.property("extVersionCode").toString().toInt()
} else {
    12
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
        // common.gradle이 매니페스트에 주입하는 앱 이름을 한글로 강제 치환
        manifestPlaceholders["appName"] = "티비위키"
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
