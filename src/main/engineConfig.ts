/**
 * Electron → engine bridge writer.
 *
 * The bundled Swift engine runs headless (its menu-bar UI is hidden), so its
 * native Settings are unreachable. The screen-capture-scope setting therefore
 * lives in Timbre's Settings UI and is propagated to the engine through a small
 * JSON file in the shared IPC dir. The engine reads it FRESH at the start of
 * each meeting (see `EngineConfig.read()` on the Swift side), which sidesteps
 * UserDefaults cross-process caching.
 *
 * The payload carries `screenCaptureScope` and the `disableAppAudioTap` kill
 * switch, plus the diarization-quality knobs Timbre owns: the processing tier,
 * the ASR language (so the engine no longer forces German), a
 * remote-speaker-count hint, and the path to the unified global speakers DB.
 * `recordScreenVideo` is deliberately NOT included: the engine keeps its own
 * AppSettings/UserDefaults gate for video on/off, untouched by this bridge. The
 * microphone is always recorded alongside the meeting audio, so there is no mic
 * field. Fields Timbre has no control for (engine override, LLM repair) are
 * omitted — the engine defaults them when the key is absent.
 *
 * Written atomically (tmp + rename via `writeJsonAtomic`) so the engine never
 * reads a half-written file. Best-effort: a failure here must never break a
 * settings save or app launch.
 */
import { join } from 'path'
import { ENGINE_IPC_DIR, writeJsonAtomic } from './chromeProbe'
import { buildEngineConfigPayload } from './engineConfigPayload'
import { globalSpeakersDBPath, readSettings } from './settings'

const ENGINE_CONFIG_FILE = join(ENGINE_IPC_DIR, 'engine_config.json')

/**
 * Read the current Settings and atomically write `engine_config.json`. Called
 * once at startup (so the file exists with defaults before any meeting) and
 * after every `settings:set` (so a scope/mode/language change takes effect on
 * the next meeting). Never throws — wraps its own errors.
 */
export async function writeEngineConfig(): Promise<void> {
  try {
    const settings = await readSettings()
    await writeJsonAtomic(ENGINE_CONFIG_FILE, {
      ...buildEngineConfigPayload(settings, globalSpeakersDBPath()),
      updatedAt: Date.now()
    })
  } catch (err) {
    console.warn('[engineConfig] writeEngineConfig failed', err)
  }
}
