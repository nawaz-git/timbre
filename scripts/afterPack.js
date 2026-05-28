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
 *   5. Re-sign with ad-hoc identity so codesign verification still
 *      passes after the rewrite. The original ad-hoc signature is
 *      invalidated by any byte-level change inside the bundle, and the
 *      hardened runtime refuses to load an app whose code signature
 *      doesn't match its current contents.
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
const NEW_DISPLAY_NAME = 'Mintr Engine'

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
 * Re-sign a bundle ad-hoc. The `--force --deep --sign -` triple is the
 * canonical macOS recipe for re-signing an ad-hoc app whose contents
 * have changed post-build. `--deep` recurses into any nested code
 * (frameworks, embedded helper binaries) and re-signs them too.
 */
function adhocResign(bundlePath) {
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

  // Step 4: re-sign ad-hoc. The original signature is invalidated by
  // both the binary rename and the plist edits. Without re-signing,
  // macOS would refuse to launch the helper (-67062 / errSecCSInfoPlistFailed
  // or similar). We preserve any existing entitlements via the flag.
  console.log('[afterPack] re-signing renamed helper ad-hoc')
  adhocResign(newAppPath)

  console.log(`[afterPack] rebrand complete: ${newAppPath}`)
  console.log(`            bundle id: ${NEW_BUNDLE_ID}`)
  console.log(`            display name: ${NEW_DISPLAY_NAME}`)
  console.log(`            executable: ${path.join(newAppPath, 'Contents/MacOS', NEW_EXEC_NAME)}`)
}
