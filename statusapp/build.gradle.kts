plugins {
    id("com.android.application") version "8.2.1"
    id("org.jetbrains.kotlin.android") version "1.8.22"
}

// 시험판: -PstatusTest=true → 패키지 뒤 .test · 이름 "확장 상태판 (시험)" (정식판과 따로 설치됨)
val isTest = (findProperty("statusTest") as String?) == "true"
val vc = ((findProperty("vc") as String?) ?: "1").toInt()

android {
    namespace = "io.github.insid0909.statusboard"
    compileSdk = 34

    defaultConfig {
        applicationId = "io.github.insid0909.statusboard" + if (isTest) ".test" else ""
        minSdk = 24
        targetSdk = 34
        versionCode = vc
        versionName = "0.1.$vc" + if (isTest) "-test" else ""
        resValue("string", "app_name", if (isTest) "확장 상태판 (시험)" else "확장 상태판")
        resValue("string", "channel_tag", if (isTest) "test" else "main")
    }

    signingConfigs {
        create("rel") {
            val ks = System.getenv("KS_PATH")
            if (ks != null) {
                storeFile = file(ks)
                storePassword = System.getenv("KS_PASS")
                keyAlias = System.getenv("KS_ALIAS")
                keyPassword = System.getenv("KS_PASS")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (System.getenv("KS_PATH") != null) signingConfigs.getByName("rel") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}
