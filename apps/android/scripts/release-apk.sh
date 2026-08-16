#!/usr/bin/env bash
# Build a signed release APK into apps/android/dist/.
#
# The keystore defaults to ~/.android/dashboardz-release.p12 (override with DASHBOARDZ_KEYSTORE).
# Its password comes from the macOS Keychain item "dashboardz-android-signing" and reaches Gradle
# only through the environment, never a file or the command line. Gradle runs with --no-daemon so
# the password doesn't stay behind in a long-lived background process.
#
# The script refuses to finish unless the APK is signed by the release certificate below: an APK
# signed by any other key can never update an installed Dashboardz, so publishing one by mistake
# would strand everyone who installs it.
set -euo pipefail

cd "$(dirname "$0")/.."

# SHA-256 of the Dashboardz release signing certificate (CN=Dashboardz, O=SCz Tech LLC).
EXPECTED_CERT_SHA256="${DASHBOARDZ_CERT_SHA256:-7b19d68050ed84326994490cd33d8cc222030b2bdf11cec0cd58c15181aa9a00}"

KEYSTORE="${DASHBOARDZ_KEYSTORE:-$HOME/.android/dashboardz-release.p12}"
ALIAS="${DASHBOARDZ_KEY_ALIAS:-dashboardz}"
[ -f "$KEYSTORE" ] || { echo "keystore not found: $KEYSTORE" >&2; exit 1; }

if [ -z "${DASHBOARDZ_SIGNING_PASSWORD:-}" ]; then
  DASHBOARDZ_SIGNING_PASSWORD="$(security find-generic-password -s dashboardz-android-signing -w)" \
    || { echo "Keychain item dashboardz-android-signing not found" >&2; exit 1; }
fi
export DASHBOARDZ_SIGNING_PASSWORD DASHBOARDZ_KEYSTORE="$KEYSTORE" DASHBOARDZ_KEY_ALIAS="$ALIAS"

export ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
if [ -z "${JAVA_HOME:-}" ] && [ -d "/Applications/Android Studio.app/Contents/jbr/Contents/Home" ]; then
  export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
fi

./gradlew --no-daemon --quiet clean :app:assembleRelease
unset DASHBOARDZ_SIGNING_PASSWORD

APK=app/build/outputs/apk/release/app-release.apk
[ -f "$APK" ] || { echo "signed APK missing (got an unsigned build?)" >&2; exit 1; }

BUILD_TOOLS="$(ls -d "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)"
APKSIGNER="$BUILD_TOOLS/apksigner"
AAPT="$BUILD_TOOLS/aapt"

if ! VERIFY="$("$APKSIGNER" verify --print-certs "$APK" 2>&1)"; then
  echo "apksigner verify failed:" >&2
  echo "$VERIFY" >&2
  exit 1
fi
CERT="$(echo "$VERIFY" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p')"
if [ "$CERT" != "$EXPECTED_CERT_SHA256" ]; then
  echo "APK is signed by the wrong certificate:" >&2
  echo "  got      $CERT" >&2
  echo "  expected $EXPECTED_CERT_SHA256" >&2
  exit 1
fi

BADGING="$("$AAPT" dump badging "$APK")"
if echo "$BADGING" | grep -q "application-debuggable"; then
  echo "release APK is debuggable; refusing to publish it" >&2
  exit 1
fi
VERSION="$(echo "$BADGING" | sed -n "s/^package: .* versionName='\([^']*\)'.*/\1/p")"
[ -n "$VERSION" ] || { echo "could not read versionName from the APK" >&2; exit 1; }

mkdir -p dist
OUT="dist/dashboardz-$VERSION.apk"
cp "$APK" "$OUT"
(cd dist && shasum -a 256 "$(basename "$OUT")" > "$(basename "$OUT").sha256")

echo "signed:      $OUT"
echo "certificate: $CERT"
cat "$OUT.sha256"
