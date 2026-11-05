// The phone's foreground-service policy, as a checked fact rather than a
// comment: D6 says the service that keeps a turn alive declares `specialUse`
// (no dataSync 6h/24h budget), D7 says no boot autostart, and the pre-34
// branch is a platform branch that must stay visibly a branch.
// Run: node tests/android-fgs.test.js
const fs = require("fs");
const path = require("path");
const { check, summary } = require("./harness.js");

const ROOT = path.join(__dirname, "..");
const MANIFEST = fs.readFileSync(path.join(ROOT, "android/app/src/main/AndroidManifest.xml"), "utf8");
const SERVICE = fs.readFileSync(
  path.join(ROOT, "android/app/src/main/java/io/clutch/mobile/TunnelService.kt"),
  "utf8"
);
const GRADLE = fs.readFileSync(path.join(ROOT, "android/app/build.gradle"), "utf8");

// The <service> element that names TunnelService, with its children.
function serviceElement(text) {
  const at = text.indexOf('android:name=".TunnelService"');
  if (at < 0) return "";
  const open = text.lastIndexOf("<service", at);
  const close = text.indexOf("</service>", at);
  const selfClosed = text.indexOf(">", at);
  if (open < 0) return "";
  // self-closing or with children: either way, the element's own text
  if (close < 0 || (selfClosed >= 0 && selfClosed < close && text[selfClosed - 1] === "/")) {
    return text.slice(open, selfClosed + 1);
  }
  return text.slice(open, close + "</service>".length);
}

function permissionNames(text) {
  return [...text.matchAll(/<uses-permission\s+android:name="([^"]+)"/g)].map((m) => m[1]);
}

function main() {
  const service = serviceElement(MANIFEST);
  const permissions = permissionNames(MANIFEST);

  // ---- 1. the declared type is specialUse, and the platform is told why ----
  {
    check(service.length > 0, "the manifest declares the TunnelService element");
    check(
      /android:foregroundServiceType="[^"]*specialUse[^"]*"/.test(service),
      "the service declares specialUse (D6: a turn in flight, not a file sync)"
    );
    check(
      /android:foregroundServiceType="[^"]*dataSync[^"]*"/.test(service),
      "dataSync stays in the mask for the pre-34 branch"
    );
    const subtype = /<property\s+android:name="android\.app\.PROPERTY_SPECIAL_USE_FGS_SUBTYPE"\s+android:value="([^"]+)"/.exec(
      service
    );
    check(Boolean(subtype), "the specialUse property names the subtype the platform reviews");
    check(
      Boolean(subtype) && subtype[1].trim().length > 0 && subtype[1].includes("turn"),
      "and the subtype says what is being kept alive"
    );
    check(/android:exported="false"/.test(service), "the service is not exported");
  }

  // ---- 2. the permissions the type needs ----
  {
    check(permissions.includes("android.permission.FOREGROUND_SERVICE"), "FOREGROUND_SERVICE is requested");
    check(
      permissions.includes("android.permission.FOREGROUND_SERVICE_SPECIAL_USE"),
      "FOREGROUND_SERVICE_SPECIAL_USE is requested (API 34 refuses the start without it)"
    );
    check(
      permissions.includes("android.permission.FOREGROUND_SERVICE_DATA_SYNC"),
      "and the dataSync permission stays for the pre-34 branch"
    );
  }

  // ---- 3. the API-34 branch states the type it declared ----
  {
    const at = SERVICE.indexOf("private fun startForegroundCompat()");
    const end = SERVICE.indexOf("override fun onDestroy()", at);
    check(at >= 0 && end > at, "TunnelService has one startForegroundCompat");
    const body = at >= 0 && end > at ? SERVICE.slice(at, end) : "";
    const special = body.indexOf("FOREGROUND_SERVICE_TYPE_SPECIAL_USE");
    const branch34 = body.indexOf("SDK_INT >= 34");
    const dataSync = body.indexOf("FOREGROUND_SERVICE_TYPE_DATA_SYNC");
    const branch29 = body.indexOf("SDK_INT >= 29");
    check(branch34 >= 0, "specialUse is chosen on API 34 and above");
    check(special > branch34, "and the type passed to startForeground is SPECIAL_USE");
    check(branch29 > special, "below 34 the call is a separate platform branch");
    check(dataSync > branch29, "which passes the dataSync type the manifest has always declared");
    check(body.indexOf("startForeground(NOTIFICATION_ID, notification)") > dataSync, "and pre-29 keeps the two-argument call");
    check(!/dataSync/i.test(body.slice(0, branch34)), "no dataSync call sits above the API-34 branch (it would win on 34+)");
  }

  // ---- 4. the type exists at this SDK level ----
  {
    const target = /targetSdk\s+(\d+)/.exec(GRADLE);
    const compile = /compileSdk\s+(\d+)/.exec(GRADLE);
    check(Boolean(target) && Number(target[1]) >= 34, "targetSdk is 34 or newer, where specialUse exists");
    check(Boolean(compile) && Number(compile[1]) >= 34, "compileSdk knows ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE");
  }

  // ---- 5. D7: no boot autostart ----
  {
    check(
      !permissions.includes("android.permission.RECEIVE_BOOT_COMPLETED"),
      "the app does not ask to hear BOOT_COMPLETED"
    );
    check(!/BOOT_COMPLETED/.test(MANIFEST), "and nothing in the manifest listens for it");
    check(!/BOOT_COMPLETED/.test(SERVICE), "nor does the service");
    check(/return START_STICKY/.test(SERVICE), "the sticky restart is the only 'come back' the app claims (D7)");
  }

  summary("android-fgs: the foreground service is specialUse, not dataSync");
}

main();
