import { readFileSync } from 'fs'
import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const pkg = JSON.parse(readFileSync(resolve(__dirname, 'package.json'), 'utf-8')) as {
  version: string
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    // The renderer runs sandboxed (webPreferences.sandbox = true in
    // src/main/index.ts), and a sandboxed preload's require() can ONLY resolve
    // 'electron' — it cannot pull external npm modules from node_modules at
    // runtime. externalizeDepsPlugin() leaves every dependency as a bare
    // require(), so the default config shipped `require("@electron-toolkit/preload")`
    // in out/preload/index.js. Under the sandbox that throws
    // "module not found: @electron-toolkit/preload", the preload never runs,
    // window.api/window.electron stay undefined, the renderer crashes, and the
    // window renders black. Excluding it makes Vite BUNDLE it into the preload
    // (it has no transitive npm deps and its own require('electron') stays
    // sandbox-legal). 'electron' itself stays external — it's built in.
    plugins: [externalizeDepsPlugin({ exclude: ['@electron-toolkit/preload'] })]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    define: {
      APP_VERSION_PLACEHOLDER: JSON.stringify(pkg.version)
    },
    plugins: [react()]
  }
})
