import { Config } from "effect"

function env(name: string): string | undefined {
  return process.env[name]
}

// An Effect Config source for a NOVACLAW_* boolean flag (default false).
function boolFlag(name: string) {
  return Config.boolean(name).pipe(Config.withDefault(false))
}

export function truthy(key: string) {
  const value = env(key)?.toLowerCase()
  return value === "true" || value === "1"
}

/** Opt-OUT capability flag: ON unless explicitly disabled (`0`/`false`/`off`). For a capability whose
 *  env var exists as an ESCAPE HATCH for constrained hosts rather than as the way to turn a feature on
 *  — where `truthy`'s default-false polarity would silently keep the feature dark for every user who
 *  never heard of the variable. */
export function truthyUnlessDisabled(key: string) {
  const value = env(key)?.toLowerCase()
  return !(value === "false" || value === "0" || value === "off")
}

const fff = env("NOVACLAW_DISABLE_FFF")

function enabledByExperimental(key: string) {
  return env(key) === undefined ? truthy("NOVACLAW_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  NOVACLAW_AUTO_HEAP_SNAPSHOT: truthy("NOVACLAW_AUTO_HEAP_SNAPSHOT"),
  NOVACLAW_GIT_BASH_PATH: env("NOVACLAW_GIT_BASH_PATH"),
  get NOVACLAW_W64DEVKIT_PATH() {
    return env("NOVACLAW_W64DEVKIT_PATH")
  },
  /** The embedded ImageMagick's root — where `magick` lives (`shell.ts` → `imagemagickRoot`). */
  get NOVACLAW_IMAGEMAGICK_PATH() {
    return env("NOVACLAW_IMAGEMAGICK_PATH")
  },
  NOVACLAW_CONFIG_CONTENT: env("NOVACLAW_CONFIG_CONTENT"),
  NOVACLAW_DISABLE_PRUNE: truthy("NOVACLAW_DISABLE_PRUNE"),
  NOVACLAW_DISABLE_AUTOCOMPACT: truthy("NOVACLAW_DISABLE_AUTOCOMPACT"),
  NOVACLAW_DISABLE_MODELS_FETCH: truthy("NOVACLAW_DISABLE_MODELS_FETCH"),
  // The Ladybug graph-memory engine (WASM, in-process — no sidecar; §2.0 pivot). Instance/deployment-
  // level, so it rides an env flag like NOVACLAW_DB, not location config. ON enables it; the launcher
  // sets it in real deployments so memory just works, while the test suite leaves it off (no engine
  // boot). Never a hard dependency — off/unavailable → the instance still boots.
  // Opt-OUT, not opt-in. This is the CAPABILITY gate ("can the engine open at all"), documented in
  // kb-graph/memory-setting.ts as an escape hatch for a constrained host or airgap — but it was
  // `truthy`, i.e. default FALSE, and NOTHING in the tree sets it (verified 2026-07-20: not the
  // desktop app, not the launchers, not the packaged build). So the entire KB-G graph-memory tier —
  // every phase P0-P8 — was dark for every real user, while the plan's §5 owner directive is
  // "default-on out-of-the-box". The USER's switch is `memory.enabled` (default ON, a privacy
  // control); this one only exists so a constrained host can say no.
  NOVACLAW_KB_MEMORY: truthyUnlessDisabled("NOVACLAW_KB_MEMORY"),
  NOVACLAW_KB_MEMORY_DIM: env("NOVACLAW_KB_MEMORY_DIM"),
  // The automatic session/agent world model has its own capability switch and dimension. It
  // defaults on independently so a deliberate KB capability outage does not also erase the
  // runner's horizon; the shared user privacy stance still gates what a session writes or reads.
  NOVACLAW_WORLD_MEMORY: truthyUnlessDisabled("NOVACLAW_WORLD_MEMORY"),
  NOVACLAW_WORLD_MEMORY_DIM: env("NOVACLAW_WORLD_MEMORY_DIM"),
  /** Reasoning budget for document absorption. A KNOB so the value can be MEASURED, not guessed. */
  NOVACLAW_KB_ABSORB_BUDGET: env("NOVACLAW_KB_ABSORB_BUDGET"),
  /** Reasoning budget for the compaction summary. A KNOB for the same reason: 2,048 is a first
   *  value and the sweep that would defend it has not been run. */
  NOVACLAW_COMPACTION_BUDGET: env("NOVACLAW_COMPACTION_BUDGET"),
  // Opt-IN: npm-install `@novaclaw/plugin` into each `.novaclaw` config dir so user
  // plugin files can VALUE-import it. Default OFF: the package is not published
  // to npm (post-rename), so the fetch is a guaranteed 404 at every boot — and a
  // local-first product should make no registry fetches at startup (OFF-B layer 8).
  // Type-only imports need no install (bun erases them). Re-enable by default once
  // the package is published or bundled as a local tarball.
  NOVACLAW_INSTALL_PLUGIN_TYPES: truthy("NOVACLAW_INSTALL_PLUGIN_TYPES"),
  /**
   * Do not open a browser when the web server starts.
   *
   * 🔴 `novaclaw web` opens the UI on boot, which is right for a person starting their instance and
   * wrong for everything else: a scripted run, a smoke test, or an agent restarting the server to
   * check something. Measured the hard way on 2026-08-22 — a session that restarted the dev server
   * repeatedly put a stack of tabs in the owner's browser, one per run.
   */
  NOVACLAW_NO_OPEN: truthy("NOVACLAW_NO_OPEN"),
  NOVACLAW_SERVER_PASSWORD: env("NOVACLAW_SERVER_PASSWORD"),
  NOVACLAW_SERVER_USERNAME: env("NOVACLAW_SERVER_USERNAME"),
  NOVACLAW_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("NOVACLAW_DISABLE_FFF"),

  // Experimental
  NOVACLAW_EXPERIMENTAL_FILEWATCHER: boolFlag("NOVACLAW_EXPERIMENTAL_FILEWATCHER"),
  NOVACLAW_EXPERIMENTAL_DISABLE_FILEWATCHER: boolFlag("NOVACLAW_EXPERIMENTAL_DISABLE_FILEWATCHER"),
  NOVACLAW_MODELS_URL: env("NOVACLAW_MODELS_URL"),
  NOVACLAW_MODELS_PATH: env("NOVACLAW_MODELS_PATH"),
  NOVACLAW_DB: env("NOVACLAW_DB"),

  NOVACLAW_WORKSPACE_ID: env("NOVACLAW_WORKSPACE_ID"),
  // NOVACLAW_EXPERIMENTAL_WORKSPACES is deliberately NOT here. The workspaces gate is
  // `RuntimeFlags.experimentalWorkspaces` (`packages/novaclaw/src/effect/runtime-flags.ts`), read at
  // `control-plane/workspace.ts:459`. A `Flag` entry for it existed too and had ZERO production
  // readers, so three server tests set `Flag.NOVACLAW_EXPERIMENTAL_WORKSPACES = true` and changed
  // nothing — the env var `test/preload.ts` exports is what actually turned the feature on. Two
  // registries for one variable is how a switch ends up connected to neither light.

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get NOVACLAW_DISABLE_PROJECT_CONFIG() {
    return truthy("NOVACLAW_DISABLE_PROJECT_CONFIG")
  },
  get NOVACLAW_CONFIG_DIR() {
    return env("NOVACLAW_CONFIG_DIR")
  },
  get NOVACLAW_PURE() {
    return truthy("NOVACLAW_PURE")
  },
  // FS-3: force the app-private virtual filesystem (phones/sandboxes with no browsable host FS).
  get NOVACLAW_VIRTUAL_FS() {
    return truthy("NOVACLAW_VIRTUAL_FS")
  },
  get NOVACLAW_PERMISSION() {
    return env("NOVACLAW_PERMISSION")
  },
  get NOVACLAW_CLIENT() {
    return env("NOVACLAW_CLIENT") ?? "cli"
  },
}
