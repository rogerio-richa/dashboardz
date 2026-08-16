plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.dashboardz.device"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.dashboardz.device"
        minSdk = 23
        targetSdk = 36
        // versionCode must go up for every release, or Android refuses the update.
        versionCode = 8
        versionName = "0.7.0"
    }

    // Release signing. The keystore lives outside the repo and its password is never written to
    // a file: scripts/release-apk.sh reads it from the macOS Keychain and passes it in through
    // the environment. Without DASHBOARDZ_SIGNING_PASSWORD the release build stays unsigned, so
    // CI and other contributors build exactly as before.
    val signingPassword: String? = System.getenv("DASHBOARDZ_SIGNING_PASSWORD")
    signingConfigs {
        if (signingPassword != null) {
            create("release") {
                storeFile = file(
                    System.getenv("DASHBOARDZ_KEYSTORE")
                        ?: "${System.getProperty("user.home")}/.android/dashboardz-release.p12"
                )
                storePassword = signingPassword
                keyAlias = System.getenv("DASHBOARDZ_KEY_ALIAS") ?: "dashboardz"
                keyPassword = signingPassword
            }
        }
    }

    buildTypes {
        release {
            if (signingPassword != null) signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }
    kotlin { jvmToolchain(17) }
    buildFeatures { compose = true; buildConfig = true }
}

dependencies {
    coreLibraryDesugaring(libs.desugar.jdk.libs)

    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.service)
    implementation(libs.coroutines.android)

    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.zxing.embedded)

    testImplementation(libs.junit)
    testImplementation(libs.okhttp.mockwebserver)
    testImplementation(libs.coroutines.test)
}
