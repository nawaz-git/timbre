/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */

const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')

const CODESIGN = '/usr/bin/codesign'
const DITTO = '/usr/bin/ditto'
const XCRUN = '/usr/bin/xcrun'

function requireNotaryCredentials() {
  const required = ['APPLE_ID', 'TEAM_ID', 'APP_PASSWORD']
  const missing = required.filter((name) => !process.env[name])
  if (missing.length > 0) {
    throw new Error(`[notarize] missing production credentials: ${missing.join(', ')}`)
  }
}

function submitAndWait(artifactPath) {
  const output = execFileSync(
    XCRUN,
    [
      'notarytool',
      'submit',
      artifactPath,
      '--apple-id',
      process.env.APPLE_ID,
      '--team-id',
      process.env.TEAM_ID,
      '--password',
      process.env.APP_PASSWORD,
      '--wait',
      '--output-format',
      'json'
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  )

  let result
  try {
    result = JSON.parse(output)
  } catch {
    throw new Error('[notarize] notarytool returned invalid JSON')
  }
  if (result.status !== 'Accepted') {
    const submission = result.id ? ` (submission ${result.id})` : ''
    throw new Error(
      `[notarize] Apple did not accept the app: ${result.status || 'missing status'}${submission}`
    )
  }
}

exports.default = async function notarize(context) {
  if (process.env.TIMBRE_RELEASE !== '1') return
  if (context.electronPlatformName !== 'darwin') return

  requireNotaryCredentials()

  const productName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${productName}.app`)
  if (!fs.existsSync(appPath)) {
    throw new Error(`[notarize] packaged app is missing: ${appPath}`)
  }

  execFileSync(CODESIGN, ['--verify', '--deep', '--strict', '--verbose=4', appPath], {
    stdio: 'inherit'
  })

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'timbre-notarize-app-'))
  const archivePath = path.join(temporaryDirectory, `${productName}.zip`)
  try {
    execFileSync(DITTO, ['-c', '-k', '--keepParent', appPath, archivePath], {
      stdio: 'inherit'
    })
    submitAndWait(archivePath)
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true })
  }

  execFileSync(XCRUN, ['stapler', 'staple', appPath], { stdio: 'inherit' })
  execFileSync(XCRUN, ['stapler', 'validate', appPath], { stdio: 'inherit' })
  execFileSync(CODESIGN, ['--verify', '--deep', '--strict', '--verbose=4', appPath], {
    stdio: 'inherit'
  })
  console.log(`[notarize] accepted, stapled, and validated ${appPath}`)
}
