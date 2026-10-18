// The build this page was assembled into — the one number a bug report needs, and
// the only place the renderer reads it from (the About pane, ui/js/settings.js).
//
// It is a STAMP, not code. scripts/build-android-apk.sh rewrites this same file
// inside android/app/src/main/assets/ui/ with the very version it hands gradle as
// -PAPP_VERSION, so an installed APK names the release it was built from — the
// WebView has no other way to learn it (the Kotlin shell knows the versionName, but
// the page has no channel to ask it, and adding one would buy nothing a stamped
// file does not already say).
//
// In the source tree it is kept EQUAL to VERSION by tests/about-version-test.js;
// the desktop deb reads ui/package.json, which the release commit keeps equal to
// VERSION too. So all three — VERSION, ui/package.json, this — are one number.
window.CLUTCH_VERSION = "0.1.54";
