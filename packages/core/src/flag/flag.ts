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

const copy = env("NOVACLAW_EXPERIMENTAL_DISABLE_COPY_ON_SELECT")
const fff = env("NOVACLAW_DISABLE_FFF")

function enabledByExperimental(key: string) {
  return env(key) === undefined ? truthy("NOVACLAW_EXPERIMENTAL") : truthy(key)
}

export const Flag = {
  OTEL_EXPORTER_OTLP_ENDPOINT: process.env["OTEL_EXPORTER_OTLP_ENDPOINT"],
  OTEL_EXPORTER_OTLP_HEADERS: process.env["OTEL_EXPORTER_OTLP_HEADERS"],

  NOVACLAW_AUTO_HEAP_SNAPSHOT: truthy("NOVACLAW_AUTO_HEAP_SNAPSHOT"),
  NOVACLAW_GIT_BASH_PATH: env("NOVACLAW_GIT_BASH_PATH"),
  NOVACLAW_CONFIG: env("NOVACLAW_CONFIG"),
  NOVACLAW_CONFIG_CONTENT: env("NOVACLAW_CONFIG_CONTENT"),
  NOVACLAW_DISABLE_AUTOUPDATE: truthy("NOVACLAW_DISABLE_AUTOUPDATE"),
  NOVACLAW_ALWAYS_NOTIFY_UPDATE: truthy("NOVACLAW_ALWAYS_NOTIFY_UPDATE"),
  NOVACLAW_DISABLE_PRUNE: truthy("NOVACLAW_DISABLE_PRUNE"),
  NOVACLAW_DISABLE_TERMINAL_TITLE: truthy("NOVACLAW_DISABLE_TERMINAL_TITLE"),
  NOVACLAW_SHOW_TTFD: truthy("NOVACLAW_SHOW_TTFD"),
  NOVACLAW_DISABLE_AUTOCOMPACT: truthy("NOVACLAW_DISABLE_AUTOCOMPACT"),
  NOVACLAW_DISABLE_MODELS_FETCH: truthy("NOVACLAW_DISABLE_MODELS_FETCH"),
  // Opt-IN: npm-install `@novaclaw/plugin` into each `.novaclaw` config dir so user
  // plugin/tool files can VALUE-import it. Default OFF: the package is not published
  // to npm (post-rename), so the fetch is a guaranteed 404 at every boot — and a
  // local-first product should make no registry fetches at startup (OFF-B layer 8).
  // Type-only imports need no install (bun erases them). Re-enable by default once
  // the package is published or bundled as a local tarball.
  NOVACLAW_INSTALL_PLUGIN_TYPES: truthy("NOVACLAW_INSTALL_PLUGIN_TYPES"),
  NOVACLAW_DISABLE_MOUSE: truthy("NOVACLAW_DISABLE_MOUSE"),
  NOVACLAW_FAKE_VCS: env("NOVACLAW_FAKE_VCS"),
  NOVACLAW_SERVER_PASSWORD: env("NOVACLAW_SERVER_PASSWORD"),
  NOVACLAW_SERVER_USERNAME: env("NOVACLAW_SERVER_USERNAME"),
  NOVACLAW_DISABLE_FFF: fff === undefined ? process.platform === "win32" : truthy("NOVACLAW_DISABLE_FFF"),

  // Experimental
  NOVACLAW_EXPERIMENTAL_FILEWATCHER: boolFlag("NOVACLAW_EXPERIMENTAL_FILEWATCHER"),
  NOVACLAW_EXPERIMENTAL_DISABLE_FILEWATCHER: boolFlag("NOVACLAW_EXPERIMENTAL_DISABLE_FILEWATCHER"),
  NOVACLAW_EXPERIMENTAL_DISABLE_COPY_ON_SELECT:
    copy === undefined ? process.platform === "win32" : truthy("NOVACLAW_EXPERIMENTAL_DISABLE_COPY_ON_SELECT"),
  NOVACLAW_MODELS_URL: env("NOVACLAW_MODELS_URL"),
  NOVACLAW_MODELS_PATH: env("NOVACLAW_MODELS_PATH"),
  NOVACLAW_DB: env("NOVACLAW_DB"),

  NOVACLAW_WORKSPACE_ID: env("NOVACLAW_WORKSPACE_ID"),
  NOVACLAW_EXPERIMENTAL_WORKSPACES: enabledByExperimental("NOVACLAW_EXPERIMENTAL_WORKSPACES"),

  // Evaluated at access time (not module load) because tests, the CLI, and
  // external tooling set these env vars at runtime.
  get NOVACLAW_DISABLE_PROJECT_CONFIG() {
    return truthy("NOVACLAW_DISABLE_PROJECT_CONFIG")
  },
  get NOVACLAW_EXPERIMENTAL_REFERENCES() {
    return enabledByExperimental("NOVACLAW_EXPERIMENTAL_REFERENCES")
  },
  get NOVACLAW_TUI_CONFIG() {
    return env("NOVACLAW_TUI_CONFIG")
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
  get NOVACLAW_PLUGIN_META_FILE() {
    return env("NOVACLAW_PLUGIN_META_FILE")
  },
  get NOVACLAW_CLIENT() {
    return env("NOVACLAW_CLIENT") ?? "cli"
  },
}
