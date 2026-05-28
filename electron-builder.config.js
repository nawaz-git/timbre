// Mintr — v0.7.0
//
// JS config (converted from electron-builder.yml) so `mac.identity` can be
// read from the environment at config-eval time. Set MINTR_SIGN_IDENTITY to a
// stable signing identity (see dev/scripts/setup-signing.sh) to break the TCC
// re-grant loop; leave it unset for the default ad-hoc build (CI / other devs).
//
// electron-builder auto-detects `electron-builder.config.js`, so the
// `dist:mac` / `build:mac` scripts (which call `electron-builder --mac`) pick
// this up automatically — no `--config` flag needed.

// When MINTR_SIGN_IDENTITY is set, electron-builder signs Mintr.app with that
// identity; otherwise null → ad-hoc signing (the previous behaviour).
const signIdentity = process.env.MINTR_SIGN_IDENTITY || null

// Hardened runtime + a self-signed identity + the engine's JIT /
// unsigned-executable-memory entitlements = launch failure. Only enable
// hardened runtime for a real Developer ID identity (which implies
// notarization). Self-signed dev tier → false. ad-hoc (null) → false.
const hardenedRuntime =
  typeof signIdentity === 'string' && signIdentity.startsWith('Developer ID')

/**
 * @type {import('electron-builder').Configuration}
 */
module.exports = {
  // NOTE: `appId` deliberately stays at `ai.nawaz.meeting-transcriber` even
  // though the product brand is now "Mintr". Reusing the bundle ID keeps the
  // macOS TCC (microphone / screen-recording / Documents) permissions that
  // existing users have already granted to past builds. Renaming the bundle
  // ID is a breaking change — re-grant required — so we defer it until a
  // dedicated upgrade path is in place.
  appId: 'ai.nawaz.meeting-transcriber',
  productName: 'Mintr',
  directories: {
    buildResources: 'build'
  },
  files: [
    '!**/.vscode/*',
    '!src/*',
    '!electron.vite.config.{js,ts,mjs,cjs}',
    '!{.eslintcache,eslint.config.mjs,.prettierignore,.prettierrc.yaml,dev-app-update.yml,CHANGELOG.md,README.md}',
    '!{.env,.env.*,.npmrc,pnpm-lock.yaml}',
    '!{tsconfig.json,tsconfig.node.json,tsconfig.web.json}'
  ],
  asarUnpack: ['resources/**'],

  // Bundle Swift artefacts from the sibling repo:
  //   - mt-batch CLI: file-import transcription pipeline (always required)
  //   - MeetingTranscriber.app: live recording engine with Google Meet detection
  // Both paths must exist at `dist:mac` time. Missing paths are a warning at
  // build time and a runtime "engine not bundled" message in the UI.
  extraResources: [
    {
      from: '../meeting-transcriber/tools/mt-batch/.build/release/mt-batch',
      to: 'bin/mt-batch',
      filter: ['**/*']
    },
    {
      from: '../meeting-transcriber/.build/release/MeetingTranscriber.app',
      to: 'MeetingTranscriber.app',
      filter: ['**/*']
    }
  ],

  mac: {
    category: 'public.app-category.productivity',
    // `electron-builder` auto-detects `build/icon.icns` but we declare it
    // explicitly so the production icon (mint leaf + sound wave) wires up
    // regardless of buildResources discovery order.
    icon: 'build/icon.icns',
    target: [
      {
        target: 'dmg',
        arch: ['arm64']
      }
    ],
    // Read from MINTR_SIGN_IDENTITY (see top of file). null → ad-hoc.
    identity: signIdentity,
    // false for ad-hoc + self-signed (dev tier); true only for Developer ID.
    hardenedRuntime: hardenedRuntime,
    gatekeeperAssess: false,
    notarize: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    extendInfo: {
      NSMicrophoneUsageDescription:
        'Mintr needs microphone access to record and transcribe meetings on-device.',
      NSScreenCaptureUsageDescription:
        'Mintr needs screen capture access to capture system audio from meetings on-device.',
      NSDocumentsFolderUsageDescription:
        'Mintr reads and writes transcripts in your Documents folder.',
      // AppleScript / Automation — required for the Chrome tab probe.
      // Without this string the OS shows a generic "Mintr wants to control
      // Google Chrome" prompt; with it the user sees the justification.
      NSAppleEventsUsageDescription:
        'Mintr reads the URL of your active Chrome / Brave / Edge / Arc tab so it can detect when you join a Google Meet and start capturing automatically. The page contents are never read.',
      // LSUIElement controls whether the app shows up in the Dock + ⌘-Tab.
      // We keep it false (the default) so users CAN bring the main window
      // back via the Dock — the tray is additive, not a replacement.
      LSUIElement: false
    }
  },

  dmg: {
    artifactName: '${productName}-${version}-${arch}.${ext}'
  },

  npmRebuild: false,

  // v0.19+ — rebadge the bundled MeetingTranscriber helper to MintrEngine
  // (new bundle id, new display name, new file path). See scripts/afterPack.js
  // for the why + how. This is what finally severs the helper from Mintr's
  // TCC scope and gives it its own fresh permission grants.
  afterPack: 'scripts/afterPack.js'
}
