/**
 * electron-builder afterPack hook (v0.19+).
 *
 * Rebrands the bundled Swift helper from "MeetingTranscriber" to
 * "Mintr Engine" — file paths, executable name, and (critically) the
 * CFBundleIdentifier. The bundle id change forces macOS to treat the
 * helper as a completely independent app from Mintr (different TCC
 * principal, no parent-process attribution), which is what finally
 * fixes the v0.12 → v0.18 PermissionHealthCheck failure chain.
 *
 * Why this is a build-time mutation rather than a source rename in the
 * sibling Swift project: that project is its own codebase and we don't
 * want to fork its identity. We rebadge purely the artifacts copied
 * into Mintr.app via electron-builder's extraResources clause, leaving
 * the upstream MeetingTranscriber project unchanged.
 *
 * Steps:
 *   1. Locate the copied helper at <appOutDir>/Mintr.app/Contents/
 *      Resources/MeetingTranscriber.app
 *   2. Rename the inner binary: Contents/MacOS/MeetingTranscriber
 *      → Contents/MacOS/MintrEngine
 *   3. Patch Info.plist:
 *        CFBundleIdentifier   = ai.nawaz.mintr-engine
 *        CFBundleName         = Mintr Engine
 *        CFBundleDisplayName  = Mintr Engine
 *        CFBundleExecutable   = MintrEngine
 *   4. Rename the .app bundle directory:
 *      MeetingTranscriber.app → MintrEngine.app
 *   5. Re-sign so codesign verification still passes after the rewrite.
 *      The original signature is invalidated by any byte-level change
 *      inside the bundle, and the hardened runtime refuses to load an app
 *      whose code signature doesn't match its current contents.
 *      When MINTR_SIGN_IDENTITY is set (see dev/scripts/setup-signing.sh)
 *      we re-sign with that STABLE identity so the cdhash-independent
 *      Designated Requirement stays constant across rebuilds and TCC grants
 *      persist; otherwise we fall back to ad-hoc (`--sign -`).
 *
 * If any step throws we DO NOT swallow the error — let electron-builder
 * fail the whole build so we don't ship a half-rebranded DMG.
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const OLD_APP_NAME = 'MeetingTranscriber.app'
const OLD_EXEC_NAME = 'MeetingTranscriber'
const NEW_APP_NAME = 'MintrEngine.app'
const NEW_EXEC_NAME = 'MintrEngine'
const NEW_BUNDLE_ID = 'ai.nawaz.mintr-engine'
const NEW_DISPLAY_NAME = 'Timbre Engine'

/**
 * Patch a binary plist (Info.plist) via PlistBuddy — preserves the
 * binary-encoded format the bundle ships with (changing to text would
 * break LaunchServices' fast bundle-id index on some macOS versions).
 */
function plistSet(plistPath, key, value) {
  execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plistPath], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

/**
 * Re-sign the renamed engine bundle. When MINTR_SIGN_IDENTITY is set we use
 * that stable identity (the TCC re-grant-loop fix); otherwise we fall back to
 * ad-hoc (`--sign -`), preserving the previous build behaviour for CI / other
 * devs who haven't run dev/scripts/setup-signing.sh.
 *
 * For the stable self-signed identity we drop `--deep` (the engine bundle has
 * no nested code today, and `--deep` can fight electron-builder's own signing
 * of the outer Mintr.app) and drop `--options runtime` (hardened runtime is
 * off for the self-signed dev tier — see electron-builder.config.js). The
 * ad-hoc path keeps the original `--force --deep --sign -` recipe verbatim.
 * Both keep `--preserve-metadata=entitlements` so the engine's audio
 * entitlements survive the re-sign.
 */
function resignEngine(bundlePath) {
  const identity = process.env.MINTR_SIGN_IDENTITY
  if (identity) {
    console.log(`[afterPack] re-signing renamed helper with identity "${identity}"`)
    execFileSync(
      '/usr/bin/codesign',
      ['--force', '--sign', identity, '--preserve-metadata=entitlements', bundlePath],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    return
  }
  console.log('[afterPack] re-signing renamed helper ad-hoc')
  execFileSync(
    '/usr/bin/codesign',
    ['--force', '--deep', '--sign', '-', '--preserve-metadata=entitlements', bundlePath],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
}

exports.default = async function afterPack(context) {
  // Only rebadge on darwin packages — the engine helper is macOS-only.
  if (context.electronPlatformName !== 'darwin') return

  const { appOutDir, packager } = context
  const productName = packager.appInfo.productFilename // "Mintr"
  const resourcesDir = path.join(appOutDir, `${productName}.app`, 'Contents', 'Resources')

  const oldAppPath = path.join(resourcesDir, OLD_APP_NAME)
  const newAppPath = path.join(resourcesDir, NEW_APP_NAME)

  if (!fs.existsSync(oldAppPath)) {
    // Nothing to do — either the extraResources didn't land the helper,
    // or this is a follow-up build where the rename already happened.
    // The second case is fine (idempotent), the first is a build-config
    // problem the user will notice via the missing helper at runtime.
    if (fs.existsSync(newAppPath)) {
      console.log(`[afterPack] helper already renamed at ${newAppPath} — skipping`)
      return
    }
    console.warn(
      `[afterPack] expected bundled helper at ${oldAppPath} not found; skipping rebrand`
    )
    return
  }

  console.log(`[afterPack] rebranding ${oldAppPath} → MintrEngine.app`)

  // Step 1: rename the inner executable. Must happen BEFORE renaming
  // the outer .app folder, because we reference paths inside the old
  // folder name first.
  const oldExec = path.join(oldAppPath, 'Contents', 'MacOS', OLD_EXEC_NAME)
  const newExec = path.join(oldAppPath, 'Contents', 'MacOS', NEW_EXEC_NAME)
  if (fs.existsSync(oldExec)) {
    fs.renameSync(oldExec, newExec)
  } else if (!fs.existsSync(newExec)) {
    throw new Error(`[afterPack] inner executable missing: ${oldExec}`)
  }

  // Step 2: patch the Info.plist. Order matters only insofar as later
  // keys may reference earlier ones — none do, so we apply all four
  // in any order.
  const plistPath = path.join(oldAppPath, 'Contents', 'Info.plist')
  plistSet(plistPath, 'CFBundleIdentifier', NEW_BUNDLE_ID)
  // PlistBuddy handles spaces by treating the rest of the line as the
  // value, so quoting isn't needed but doesn't hurt either.
  plistSet(plistPath, 'CFBundleName', NEW_DISPLAY_NAME)
  // CFBundleDisplayName may not exist as a top-level key in the source
  // plist; use `Add` then `Set` with try/catch for robustness.
  try {
    execFileSync(
      '/usr/libexec/PlistBuddy',
      ['-c', `Add :CFBundleDisplayName string ${NEW_DISPLAY_NAME}`, plistPath],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
  } catch {
    // Key already exists — Set instead.
    plistSet(plistPath, 'CFBundleDisplayName', NEW_DISPLAY_NAME)
  }
  plistSet(plistPath, 'CFBundleExecutable', NEW_EXEC_NAME)

  // Step 3: rename the outer .app folder. This is the user-visible
  // name in Finder and the path that Mintr's backend.ts spawns.
  fs.renameSync(oldAppPath, newAppPath)

  // Step 4: re-sign the helper. The original signature is invalidated by
  // both the binary rename and the plist edits. Without re-signing, macOS
  // would refuse to launch the helper. Uses MINTR_SIGN_IDENTITY when set,
  // else ad-hoc; preserves existing entitlements either way.
  resignEngine(newAppPath)

  console.log(`[afterPack] rebrand complete: ${newAppPath}`)
  console.log(`            bundle id: ${NEW_BUNDLE_ID}`)
  console.log(`            display name: ${NEW_DISPLAY_NAME}`)

  // Step 5: sign the OUTER Mintr.app with the stable identity too.
  //
  // electron-builder won't do this — it rejects self-signed identities and
  // we've set `identity: null` in electron-builder.js. So we sign the outer
  // app ourselves, HERE, because afterPack runs after the app is fully
  // packed (asar + helpers + the just-rebranded MintrEngine all in place)
  // but before the DMG is built. Signing top-level (no --deep — the inner
  // MintrEngine + Electron framework keep their own signatures) is enough
  // for TCC: the principal is the main executable's Designated Requirement,
  // which becomes stable across rebuilds under MINTR_SIGN_IDENTITY → Mintr's
  // OWN grants (Screen Recording probe, Chrome Automation) also persist.
  // Skipped when MINTR_SIGN_IDENTITY is unset (ad-hoc build keeps Electron's
  // default ad-hoc signature).
  const identity = process.env.MINTR_SIGN_IDENTITY
  if (identity) {
    const outerApp = path.join(appOutDir, `${productName}.app`)
    console.log(`[afterPack] signing outer ${productName}.app with "${identity}"`)
    execFileSync(
      '/usr/bin/codesign',
      ['--force', '--sign', identity, outerApp],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    console.log(`[afterPack] outer app signed: ${outerApp}`)
  }
  console.log(`            executable: ${path.join(newAppPath, 'Contents/MacOS', NEW_EXEC_NAME)}`)
}
