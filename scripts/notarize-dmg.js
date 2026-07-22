/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const CODESIGN = '/usr/bin/codesign'
const XCRUN = '/usr/bin/xcrun'

function requireEnvironment() {
  if (process.env.TIMBRE_RELEASE !== '1') {
    throw new Error('[notarize-dmg] TIMBRE_RELEASE=1 is required')
  }
  if (!/^Developer ID Application:/.test(process.env.MINTR_SIGN_IDENTITY || '')) {
    throw new Error(
      '[notarize-dmg] MINTR_SIGN_IDENTITY must begin with "Developer ID Application:"'
    )
  }

  const required = ['APPLE_ID', 'TEAM_ID', 'APP_PASSWORD']
  const missing = required.filter((name) => !process.env[name])
  if (missing.length > 0) {
    throw new Error(`[notarize-dmg] missing production credentials: ${missing.join(', ')}`)
  }
}

function submitAndWait(dmgPath) {
  const output = execFileSync(
    XCRUN,
    [
      'notarytool',
      'submit',
      dmgPath,
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
    throw new Error('[notarize-dmg] notarytool returned invalid JSON')
  }
  if (result.status !== 'Accepted') {
    const submission = result.id ? ` (submission ${result.id})` : ''
    throw new Error(
      `[notarize-dmg] Apple did not accept the DMG: ${result.status || 'missing status'}${submission}`
    )
  }
}

function main() {
  requireEnvironment()

  const dmgArgument = process.argv[2]
  if (!dmgArgument) {
    throw new Error('usage: node scripts/notarize-dmg.js <dmg-path>')
  }
  const dmgPath = path.resolve(dmgArgument)
  if (path.extname(dmgPath).toLowerCase() !== '.dmg' || !fs.existsSync(dmgPath)) {
    throw new Error(`[notarize-dmg] DMG is missing: ${dmgPath}`)
  }

  execFileSync(
    CODESIGN,
    ['--force', '--sign', process.env.MINTR_SIGN_IDENTITY, '--timestamp', dmgPath],
    { stdio: 'inherit' }
  )
  execFileSync(CODESIGN, ['--verify', '--strict', '--verbose=4', dmgPath], {
    stdio: 'inherit'
  })
  submitAndWait(dmgPath)
  execFileSync(XCRUN, ['stapler', 'staple', dmgPath], { stdio: 'inherit' })
  execFileSync(XCRUN, ['stapler', 'validate', dmgPath], { stdio: 'inherit' })
  execFileSync(CODESIGN, ['--verify', '--strict', '--verbose=4', dmgPath], {
    stdio: 'inherit'
  })
  console.log(`[notarize-dmg] accepted, stapled, and validated ${dmgPath}`)
}

if (require.main === module) main()
