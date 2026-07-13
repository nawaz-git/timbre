#!/usr/bin/env node
// Build guard: the renderer runs sandboxed (webPreferences.sandbox = true in
// src/main/index.ts). A sandboxed preload's require() can ONLY resolve
// 'electron' — any other bare module specifier throws "module not found" at
// runtime, the preload never runs, window.api stays undefined, and the window
// renders black (regression shipped in v0.40.0).
//
// electron-vite's externalizeDepsPlugin() leaves dependencies as bare
// require() calls, so a stray external dep silently reintroduces the black
// screen — and it only surfaces in the PACKAGED sandboxed app, which dev mode
// and CI never execute. This guard fails the build the moment out/preload
// contains a require() the sandbox can't resolve, so the bug can't ship twice.
//
// Runs as part of `npm run build` (and therefore `dist:mac`).
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const preloadPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'out',
  'preload',
  'index.js'
)

let source
try {
  source = readFileSync(preloadPath, 'utf-8')
} catch {
  console.error(`[check-preload-bundling] FAIL: built preload not found at ${preloadPath}`)
  console.error('[check-preload-bundling] Run the electron-vite build before this check.')
  process.exit(1)
}

// The ONLY require() a sandboxed preload may keep is require('electron').
// Collect every bare (non-relative, non-absolute) specifier and flag the rest.
const requireRe = /require\(\s*['"]([^'"]+)['"]\s*\)/g
const offenders = new Set()
for (const [, spec] of source.matchAll(requireRe)) {
  if (spec === 'electron') continue
  if (spec.startsWith('.') || spec.startsWith('/')) continue
  offenders.add(spec)
}

if (offenders.size > 0) {
  console.error('[check-preload-bundling] FAIL: sandboxed preload keeps external require() calls:')
  for (const spec of offenders) console.error(`    require("${spec}")`)
  console.error('')
  console.error('A sandboxed preload can only require("electron"). Bundle these deps into')
  console.error("the preload by adding them to externalizeDepsPlugin({ exclude: [...] }) in")
  console.error('electron.vite.config.ts (preload section). Otherwise the packaged app renders')
  console.error('a black window (window.api undefined).')
  process.exit(1)
}

console.log('[check-preload-bundling] OK: out/preload/index.js only requires("electron").')
