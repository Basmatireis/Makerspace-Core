FROM gradle:9.6.0-jdk17

USER root
ARG ANDROID_COMMAND_LINE_TOOLS=15859902
ARG ANDROID_COMMAND_LINE_TOOLS_SHA256=4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583
ENV ANDROID_HOME=/opt/android-sdk \
    ANDROID_SDK_ROOT=/opt/android-sdk \
    PATH=/opt/android-sdk/cmdline-tools/latest/bin:/opt/android-sdk/platform-tools:${PATH}

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl unzip \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /opt/android-sdk/cmdline-tools \
    && curl --fail --location --retry 3 \
      "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_COMMAND_LINE_TOOLS}_latest.zip" \
      --output /tmp/android-command-line-tools.zip \
    && echo "${ANDROID_COMMAND_LINE_TOOLS_SHA256}  /tmp/android-command-line-tools.zip" | sha256sum --check - \
    && unzip -q /tmp/android-command-line-tools.zip -d /opt/android-sdk/cmdline-tools \
    && mv /opt/android-sdk/cmdline-tools/cmdline-tools /opt/android-sdk/cmdline-tools/latest \
    && rm /tmp/android-command-line-tools.zip \
    && yes | sdkmanager --licenses >/dev/null \
    && sdkmanager "platform-tools" "platforms;android-36" "build-tools;36.0.0" \
    && chown -R gradle:gradle /opt/android-sdk

USER gradle
WORKDIR /workspace
COPY --chown=gradle:gradle . .
RUN --mount=type=cache,target=/home/gradle/.gradle,uid=1000,gid=1000 \
    ./gradlew --no-daemon --build-cache testDebugUnitTest assembleDebug assembleRelease
