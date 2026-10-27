plugins {
    id("com.android.application")
}

android {
    namespace = "at.makerspace.core.terminal"
    compileSdk = 36

    defaultConfig {
        applicationId = "at.makerspace.core.terminal"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1.0.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        debug {
            buildConfigField("boolean", "ENABLE_NFC_SIMULATOR", "true")
        }
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            buildConfigField("boolean", "ENABLE_NFC_SIMULATOR", "false")
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.17.1")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test:rules:1.7.0")
}
