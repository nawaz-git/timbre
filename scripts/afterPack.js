/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */

/**
 * electron-builder afterPack hook (v0.19+).
 *
 * Two jobs, in order:
 *
 *   A. REBRAND the bundled Swift helper from "MeetingTranscriber" to
 *      "Timbre Engine" — file paths, executable name, and (critically) the
 *      CFBundleIdentifier (ai.nawaz.mintr-engine). The bundle id change forces
 *      macOS to treat the helper as a completely independent app from Mintr
 *      (different TCC principal, no parent-process attribution), which is what
 *      finally fixes the v0.12 → v0.18 PermissionHealthCheck failure chain.
 *
 *   B. SIGN THE ENTIRE BUNDLE INSIDE-OUT. electron-builder is configured with
 *      `identity: null` (it refuses self-signed identities — see
 *      electron-builder.js), so ALL code signing is delegated here. The bundle
 *      ships with Electron's nested helper .apps, frameworks and dylibs still
 *      ad-hoc / linker-signed (flags=0x20002, "Sealed Resources=none"). If we
 *      only re-sign the engine + the OUTER Timbre.app (as this script used to),
 *      the outer --force re-seal writes a proper v2 resource-sealed
 *      CodeDirectory that RAISES the verification bar, and then
 *      `codesign --verify --deep --strict` walks into the first ad-hoc helper
 *      and fails:
 *          "code has no resources but signature indicates they must be present
 *           In subcomponent: …/Timbre Helper (GPU).app"
 *      An INVALID deep signature + the com.apple.quarantine xattr a downloaded
 *      DMG carries = the macOS "Timbre is damaged and can't be opened" dialog.
 *
 *      The fix is to sign EVERY nested signable component, DEEPEST-FIRST, so
 *      that when the outer bundle is finally sealed it hashes children that are
 *      each already validly signed. Order is load-bearing: `codesign --force`
 *      on a parent seals a hash of each child's CURRENT signature into the
 *      parent CodeDirectory, so any child re-signed AFTER its parent silently
 *      invalidates that parent. Signing order (leaves → root):
 *
 *        L0  loose Mach-O leaves (not inside a .app of their own):
 *              Electron Framework …/Helpers/chrome_crashpad_handler
 *              Squirrel        …/Resources/ShipIt
 *              Resources/bin/mt-batch   (the bundled Swift CLI)
 *            plus the dylibs bundled inside Electron Framework's Libraries/.
 *        L1  the *.framework bundles — sign the REAL versioned dir
 *            (Versions/A), never the top-level <Name>.framework symlink nor
 *            Versions/Current. Electron Framework is signed AFTER its dylibs.
 *        L2  the four nested Electron helper .apps (the step this script used
 *            to omit entirely) — signed with the SAME entitlements file
 *            (entitlementsInherit == build/entitlements.mac.plist).
 *        L3  the rebranded MintrEngine.app — kept on
 *            --preserve-metadata=entitlements so its upstream audio / JIT /
 *            automation entitlements survive (do NOT re-declare at dev tier).
 *        L4  the OUTER Timbre.app, LAST, WITH --entitlements
 *            build/entitlements.mac.plist, and NEVER with --deep.
 *
 * Why a build-time mutation rather than a source rename in the sibling Swift
 * project: that project is its own codebase and we don't want to fork its
 * identity. We rebadge purely the artifacts copied into Timbre.app via
 * electron-builder's extraResources clause, leaving upstream MeetingTranscriber
 * unchanged.
 *
 * Signing tiers:
 *   - DEV (default): self-signed "Mintr Dev Signing" (MINTR_SIGN_IDENTITY),
 *     hardenedRuntime OFF. NO `--options runtime`, NO `--timestamp`: a
 *     self-signed cert has no trusted TSA chain, and hardened runtime + the
 *     engine's allow-jit / allow-unsigned-executable-memory entitlements would
 *     kill the app at launch ("code signature invalid").
 *   - PRODUCTION (`TIMBRE_RELEASE=1`): requires a "Developer ID Application:"
 *     identity and adds `--options runtime` and `--timestamp` at EVERY level.
 *     There is no production fallback.
 *   - AD-HOC fallback (MINTR_SIGN_IDENTITY unset, e.g. CI smoke builds): every
 *     component is still signed inside-out with `--sign -` so the bundle still
 *     deep-verifies. (TCC grants won't persist for ad-hoc — see the warning.)
 *
 * If any step throws we DO NOT swallow the error — let electron-builder fail
 * the whole build so we never ship a half-signed / half-rebranded DMG.
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

const CODESIGN = '/usr/bin/codesign'
const PLISTBUDDY = '/usr/libexec/PlistBuddy'

/**
 * Resolve the entitlements plist used for the outer app AND the helpers
 * (electron-builder.js sets BOTH `entitlements` and `entitlementsInherit` to
 * the same file). We look in the project root first (the cwd electron-builder
 * runs from), then fall back to a couple of common locations so the script is
 * robust to where it's invoked. Throws if it can't be found — signing the
 * outer app without entitlements is exactly the bug we're fixing, so a missing
 * file must fail loudly rather than silently sign without it.
 */
function resolveEntitlements(context) {
  const candidates = [
    path.resolve(process.cwd(), 'build', 'entitlements.mac.plist'),
    // projectDir is set by electron-builder's packager when available.
    context &&
      context.packager &&
      context.packager.info &&
      context.packager.info.projectDir &&
      path.resolve(context.packager.info.projectDir, 'build', 'entitlements.mac.plist'),
    path.resolve(__dirname, '..', 'build', 'entitlements.mac.plist')
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  throw new Error(
    `[afterPack] entitlements file not found. Looked in:\n  - ${candidates.join('\n  - ')}`
  )
}

/**
 * Production is deliberately selected by one exact value. Other values,
 * including "true", remain in the unhardened development lane.
 */
function isProductionRelease() {
  return process.env.TIMBRE_RELEASE === '1'
}

function requireProductionIdentity(identity) {
  if (!/^Developer ID Application:/.test(identity || '')) {
    throw new Error(
      '[afterPack] TIMBRE_RELEASE=1 requires MINTR_SIGN_IDENTITY beginning with "Developer ID Application:"'
    )
  }
}

function requireProductionResources(oldAppPath, newAppPath, mtBatchPath) {
  const missing = []
  if (!fs.existsSync(oldAppPath) && !fs.existsSync(newAppPath)) {
    missing.push(`${oldAppPath} (or ${newAppPath})`)
  }
  if (!fs.existsSync(mtBatchPath)) missing.push(mtBatchPath)
  if (missing.length > 0) {
    throw new Error(`[afterPack] production resources are missing:\n  - ${missing.join('\n  - ')}`)
  }
}

/**
 * Build the codesign argv for one component.
 *
 *   signSpec   the `--sign` value: a real identity name, or '-' for ad-hoc.
 *   targetPath the component to sign.
 *   opts.entitlements        absolute path to an --entitlements plist (apps).
 *   opts.preserveEntitlements true → --preserve-metadata=entitlements (engine).
 *   opts.hardened            true → add --options runtime + --timestamp.
 *
 * We NEVER pass --deep: --deep re-signs children with the PARENT's args
 * (wrong/no entitlements for helpers, would clobber the engine's preserved
 * entitlements) and Apple deprecates it for signing. Each component is signed
 * explicitly instead.
 */
function codesignArgs(signSpec, targetPath, opts = {}) {
  const args = ['--force', '--sign', signSpec]
  if (opts.hardened) {
    // Hardened runtime + a secure timestamp — Developer-ID / notarization tier
    // only. Harmless flags are intentionally omitted at the self-signed tier.
    args.push('--options', 'runtime', '--timestamp')
  }
  if (opts.preserveEntitlements) {
    // Reuse whatever entitlements are already embedded (engine: keep upstream
    // MeetingTranscriber's audio/JIT/automation set without re-declaring).
    args.push('--preserve-metadata=entitlements')
  } else if (opts.entitlements) {
    args.push('--entitlements', opts.entitlements)
  }
  args.push(targetPath)
  return args
}

/**
 * Sign a single component. Uses execFileSync (argv array, NO shell) so paths
 * containing spaces and parentheses — "Timbre Helper (GPU).app" — are passed
 * verbatim with no quoting/escaping concerns. Errors propagate (no try/catch).
 */
function sign(signSpec, targetPath, opts, label) {
  console.log(`[afterPack]   sign ${label || ''}${label ? ' — ' : ''}${targetPath}`)
  execFileSync(CODESIGN, codesignArgs(signSpec, targetPath, opts), {
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

/**
 * Patch a binary plist (Info.plist) via PlistBuddy — preserves the
 * binary-encoded format the bundle ships with (changing to text would break
 * LaunchServices' fast bundle-id index on some macOS versions).
 */
function plistSet(plistPath, key, value) {
  execFileSync(PLISTBUDDY, ['-c', `Set :${key} ${value}`, plistPath], {
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

/**
 * Re-sign the renamed engine bundle. The original signature is invalidated by
 * both the binary rename and the plist edits, so this MUST run after the
 * rebrand. We keep --preserve-metadata=entitlements so the engine's audio /
 * mic / automation / JIT entitlements survive (it's the one bundle that uses
 * its own upstream entitlements, NOT build/entitlements.mac.plist).
 *
 * We drop --deep (the engine is a single-executable bundle with no nested
 * signables — verified) and, at the self-signed dev tier, --options runtime
 * (hardened runtime is off — see electron-builder.js). The ad-hoc fallback
 * (MINTR_SIGN_IDENTITY unset) signs with `--sign -`, same preserve flag.
 */
function resignEngine(bundlePath, signSpec, hardened, isAdhoc) {
  if (isAdhoc) {
    // No stable identity → ad-hoc. Intentional for CI smoke builds, but a LOCAL
    // install of an ad-hoc bundle gets a fresh cdhash with no stable Designated
    // Requirement, so it inherits NONE of the user's existing TCC grants
    // (Screen Recording, Microphone, Automation) — the app then looks
    // completely broken (no meeting detection, no audio, no screen video), all
    // silently. Warn loudly so it's never mistaken for a code bug. For a
    // permission-stable build run dev/scripts/setup-signing.sh once, then
    // `MINTR_SIGN_IDENTITY="Mintr Dev Signing" npm run dist:mac`.
    console.warn(
      '\n' +
        '╔════════════════════════════════════════════════════════════════════╗\n' +
        '║  [afterPack] ⚠  AD-HOC SIGNING — MINTR_SIGN_IDENTITY is not set.     ║\n' +
        '║  Every component is still signed inside-out (so the bundle still     ║\n' +
        '║  deep-verifies), but with a fresh cdhash that inherits NO TCC grants ║\n' +
        '║  (Screen Recording / Microphone / Automation). A local install will  ║\n' +
        '║  appear totally broken. For a permission-stable build, export        ║\n' +
        '║  MINTR_SIGN_IDENTITY="Mintr Dev Signing" (see dev/scripts/           ║\n' +
        '║  setup-signing.sh). Ad-hoc is fine ONLY for CI smoke builds.         ║\n' +
        '╚════════════════════════════════════════════════════════════════════╝\n'
    )
  } else {
    console.log(`[afterPack] re-signing renamed helper with identity "${signSpec}"`)
  }
  sign(signSpec, bundlePath, { preserveEntitlements: true, hardened }, 'engine')
}

/**
 * Enumerate the loose Mach-O executables that live OUTSIDE any .app bundle of
 * their own and therefore must be signed individually as leaves. These are not
 * traversed by `codesign --verify --deep --strict` on the outer .app (it only
 * walks bundles), so if they're left ad-hoc the app can pass deep-strict yet
 * still be REJECTED by notarytool. We sign them regardless of tier.
 *
 * Dynamically resolved (paths checked for existence) so the list survives
 * Electron / Squirrel version bumps; missing entries are skipped.
 */
function looseMachOLeaves(appPath) {
  const leaves = []

  // a) Electron Framework's bundled GPU/EGL/ffmpeg/etc dylibs (NOT the
  //    vk_swiftshader_icd.json resource alongside them). These must be signed
  //    BEFORE the Electron Framework versioned dir that seals them.
  const electronLibs = path.join(
    appPath,
    'Contents/Frameworks/Electron Framework.framework/Versions/A/Libraries'
  )
  if (fs.existsSync(electronLibs)) {
    for (const entry of fs.readdirSync(electronLibs)) {
      if (entry.endsWith('.dylib')) leaves.push(path.join(electronLibs, entry))
    }
  }

  // b) The crashpad handler bundled inside Electron Framework's Helpers/.
  const crashpad = path.join(
    appPath,
    'Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler'
  )
  if (fs.existsSync(crashpad)) leaves.push(crashpad)

  // c) Squirrel's ShipIt autoupdate helper.
  const shipIt = path.join(
    appPath,
    'Contents/Frameworks/Squirrel.framework/Versions/A/Resources/ShipIt'
  )
  if (fs.existsSync(shipIt)) leaves.push(shipIt)

  // d) The bundled Swift CLI under Resources/bin.
  const mtBatch = path.join(appPath, 'Contents/Resources/bin/mt-batch')
  if (fs.existsSync(mtBatch)) leaves.push(mtBatch)

  return leaves
}

/**
 * Enumerate the *.framework bundles in Contents/Frameworks, returning the REAL
 * versioned path to sign (Versions/A) — never the top-level <Name>.framework
 * symlink nor Versions/Current. Electron Framework is sorted LAST so it's
 * signed after its internal dylibs (which we sign as leaves first).
 *
 * Dynamic (reads the directory) so new/renamed frameworks are picked up.
 */
function frameworkVersionedPaths(appPath) {
  const frameworksDir = path.join(appPath, 'Contents/Frameworks')
  if (!fs.existsSync(frameworksDir)) return []

  const result = []
  for (const entry of fs.readdirSync(frameworksDir)) {
    if (!entry.endsWith('.framework')) continue
    const versionsDir = path.join(frameworksDir, entry, 'Versions')
    if (!fs.existsSync(versionsDir)) continue
    // Pick the concrete version directory (real dir, not the "Current"
    // symlink). Almost always "A"; resolve generically to be safe.
    const versions = fs
      .readdirSync(versionsDir)
      .filter((v) => {
        if (v === 'Current') return false
        const full = path.join(versionsDir, v)
        return fs.lstatSync(full).isDirectory() && !fs.lstatSync(full).isSymbolicLink()
      })
      .sort()
    if (versions.length === 0) continue
    // Prefer "A" if present, else the last sorted real version.
    const chosen = versions.includes('A') ? 'A' : versions[versions.length - 1]
    result.push(path.join(versionsDir, chosen))
  }

  // Sort Electron Framework last (it links the dylibs we sign as leaves; its
  // seal must come after them). Everything else order-independent.
  result.sort((a, b) => {
    const aElectron = a.includes('Electron Framework.framework') ? 1 : 0
    const bElectron = b.includes('Electron Framework.framework') ? 1 : 0
    return aElectron - bElectron
  })
  return result
}

/**
 * Enumerate the nested Electron helper .app bundles in Contents/Frameworks
 * (the four "Timbre Helper*.app"). Dynamic so a future Electron version that
 * adds/renames a helper is still covered. Each has no nested signables of its
 * own (verified) so signing the .app directly is sufficient.
 */
function helperApps(appPath) {
  const frameworksDir = path.join(appPath, 'Contents/Frameworks')
  if (!fs.existsSync(frameworksDir)) return []
  return fs
    .readdirSync(frameworksDir)
    .filter((entry) => entry.endsWith('.app'))
    .map((entry) => path.join(frameworksDir, entry))
}

exports.default = async function afterPack(context) {
  // Only rebadge + sign on darwin packages — the engine helper is macOS-only
  // and codesign is a macOS tool.
  if (context.electronPlatformName !== 'darwin') return

  const { appOutDir, packager } = context
  const productName = packager.appInfo.productFilename // "Timbre"
  const outerApp = path.join(appOutDir, `${productName}.app`)
  const resourcesDir = path.join(outerApp, 'Contents', 'Resources')

  const oldAppPath = path.join(resourcesDir, OLD_APP_NAME)
  const newAppPath = path.join(resourcesDir, NEW_APP_NAME)
  const mtBatchPath = path.join(resourcesDir, 'bin', 'mt-batch')

  // ───────────────────────────────────────────────────────────────────────
  // Signing tier resolution.
  //   TIMBRE_RELEASE=1 → Developer ID production tier, no fallback.
  //   any other value → self-signed identity or ad-hoc development tier.
  // ───────────────────────────────────────────────────────────────────────
  const identity = process.env.MINTR_SIGN_IDENTITY
  const isProduction = isProductionRelease()
  if (isProduction) {
    requireProductionIdentity(identity)
    requireProductionResources(oldAppPath, newAppPath, mtBatchPath)
  }
  const isAdhoc = !identity
  const signSpec = identity || '-'
  const hardened = isProduction
  const entitlements = resolveEntitlements(context)

  console.log(
    `[afterPack] signing tier: ${
      isProduction
        ? `production identity "${identity}"`
        : isAdhoc
          ? 'ad-hoc development'
          : `development identity "${identity}"`
    } | hardenedRuntime=${hardened ? 'ON' : 'OFF'}`
  )
  console.log(`[afterPack] entitlements: ${entitlements}`)

  // ───────────────────────────────────────────────────────────────────────
  // PART A — REBRAND the bundled engine (MeetingTranscriber → MintrEngine).
  // ───────────────────────────────────────────────────────────────────────
  if (!fs.existsSync(oldAppPath)) {
    // Either extraResources didn't land the helper, or this is a follow-up
    // build where the rename already happened (idempotent — fine). If neither
    // the old nor new bundle exists it's a build-config problem; we still fall
    // through to sign whatever IS in the bundle so the outer app deep-verifies.
    if (fs.existsSync(newAppPath)) {
      console.log(`[afterPack] helper already renamed at ${newAppPath} — skipping rebrand`)
    } else {
      console.warn(
        `[afterPack] expected bundled helper at ${oldAppPath} not found; skipping rebrand`
      )
    }
  } else {
    console.log(`[afterPack] rebranding ${oldAppPath} → MintrEngine.app`)

    // A.1: rename the inner executable. Must happen BEFORE renaming the outer
    // .app folder, because we reference paths inside the old folder name first.
    const oldExec = path.join(oldAppPath, 'Contents', 'MacOS', OLD_EXEC_NAME)
    const newExec = path.join(oldAppPath, 'Contents', 'MacOS', NEW_EXEC_NAME)
    if (fs.existsSync(oldExec)) {
      fs.renameSync(oldExec, newExec)
    } else if (!fs.existsSync(newExec)) {
      throw new Error(`[afterPack] inner executable missing: ${oldExec}`)
    }

    // A.2: patch the Info.plist. None of these keys reference each other, so
    // any order is fine.
    const plistPath = path.join(oldAppPath, 'Contents', 'Info.plist')
    plistSet(plistPath, 'CFBundleIdentifier', NEW_BUNDLE_ID)
    plistSet(plistPath, 'CFBundleName', NEW_DISPLAY_NAME)
    // CFBundleDisplayName may not exist as a top-level key — Add, else Set.
    try {
      execFileSync(
        PLISTBUDDY,
        ['-c', `Add :CFBundleDisplayName string ${NEW_DISPLAY_NAME}`, plistPath],
        { stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch {
      plistSet(plistPath, 'CFBundleDisplayName', NEW_DISPLAY_NAME)
    }
    plistSet(plistPath, 'CFBundleExecutable', NEW_EXEC_NAME)

    // A.3: rename the outer .app folder. This is the user-visible name in
    // Finder and the path Mintr's backend.ts spawns. Guard the partial-re-run
    // case where a stale MintrEngine.app already sits beside a freshly-extracted
    // MeetingTranscriber.app — fs.renameSync onto a non-empty dir throws
    // ENOTEMPTY, so clear the stale target first to keep the rebrand deterministic.
    if (fs.existsSync(newAppPath)) {
      fs.rmSync(newAppPath, { recursive: true, force: true })
    }
    fs.renameSync(oldAppPath, newAppPath)

    console.log(`[afterPack] rebrand complete: ${newAppPath}`)
    console.log(`            bundle id: ${NEW_BUNDLE_ID}`)
    console.log(`            display name: ${NEW_DISPLAY_NAME}`)
  }

  if (isProduction) {
    const engineExecutable = path.join(newAppPath, 'Contents', 'MacOS', NEW_EXEC_NAME)
    if (!fs.existsSync(engineExecutable)) {
      throw new Error(`[afterPack] production engine executable is missing: ${engineExecutable}`)
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // PART B — SIGN INSIDE-OUT (deepest leaves → outer app, NEVER --deep).
  //
  // Order is load-bearing: `codesign --force` on a parent seals a hash of each
  // child's CURRENT signature into the parent CodeDirectory. Sign any child
  // AFTER its parent and the parent's sealed child-hash no longer matches →
  // `--verify --deep --strict` fails again. So we go strictly leaves → root.
  // ───────────────────────────────────────────────────────────────────────

  // L0 — loose Mach-O leaves (dylibs in Electron Framework, crashpad handler,
  // ShipIt, mt-batch). Plain Mach-O → no entitlements, no inherit. These must
  // precede their containing framework (L1).
  console.log('[afterPack] L0: signing loose Mach-O leaves')
  for (const leaf of looseMachOLeaves(outerApp)) {
    sign(signSpec, leaf, { hardened }, 'leaf')
  }

  // L1 — frameworks (sign the versioned dir, not the symlink). No entitlements.
  // Electron Framework is sorted last so it's sealed after its dylibs (L0).
  console.log('[afterPack] L1: signing frameworks (Versions/A)')
  for (const fw of frameworkVersionedPaths(outerApp)) {
    sign(signSpec, fw, { hardened }, 'framework')
  }

  // L2 — the four nested Electron helper .apps (THE STEP THIS SCRIPT USED TO
  // OMIT). Apply the SAME entitlements file electron-builder uses for
  // entitlementsInherit (build/entitlements.mac.plist). They link the Electron
  // Framework so they MUST come after L0–L1.
  console.log('[afterPack] L2: signing nested helper .apps (entitlements inherit)')
  for (const helper of helperApps(outerApp)) {
    sign(signSpec, helper, { entitlements, hardened }, 'helper')
  }

  // L3 — the rebranded engine. Kept on --preserve-metadata=entitlements so its
  // upstream audio/JIT/automation entitlements survive; it's a single-exec
  // bundle with no nested signables. Must be valid BEFORE the outer seal.
  // (If the engine wasn't bundled in this build, skip — nothing to sign.)
  if (fs.existsSync(newAppPath)) {
    console.log('[afterPack] L3: signing engine (preserve entitlements)')
    resignEngine(newAppPath, signSpec, hardened, isAdhoc)
  } else {
    console.warn('[afterPack] L3: MintrEngine.app not present — skipping engine signing')
  }

  // L4 — the OUTER app, LAST, WITH the full entitlements file (this is what
  // electron-builder would have done via `entitlements:`). It must be the FINAL
  // signature because the outer seal hashes every already-signed nested
  // component; re-signing any child afterwards would invalidate it. NO --deep.
  // Identifier stays ai.nawaz.meeting-transcriber (inherited from Info.plist —
  // we never pass -i). For ad-hoc builds the warning above already fired.
  console.log(`[afterPack] L4: signing outer ${productName}.app (entitlements, LAST)`)
  sign(signSpec, outerApp, { entitlements, hardened }, 'outer')

  console.log('[afterPack] signing complete (inside-out).')
  console.log(`            outer app:  ${outerApp}`)
  console.log(`            engine app: ${newAppPath}`)
  console.log(`            executable: ${path.join(newAppPath, 'Contents/MacOS', NEW_EXEC_NAME)}`)
  console.log(
    '[afterPack] verify with: codesign --verify --deep --strict --verbose=4 ' + `'${outerApp}'`
  )
}
