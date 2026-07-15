export * as ConfigSeedStartup from "./config-seed-startup"

import { Effect } from "effect"
import { AgentConfigSeed } from "./agent-config-seed"
import { CatalogSeed } from "./catalog-seed"
import { CommandConfigSeed } from "./command-config-seed"
import { PluginConfigSeed } from "./plugin-config-seed"
import { ReferenceConfigSeed } from "./reference-config-seed"
import { SettingsConfigSeed } from "./settings-config-seed"
import { SkillConfigSeed } from "./skill-config-seed"

// Config→SQLite step 9: the ONE first-boot import pass over every per-subsystem store. Reads
// the global config dir + the launch directory's jsonc (+ NOVACLAW_CONFIG_CONTENT) and imports
// each subsystem into its SQLite store — each seed idempotent (isEmpty-gated), so this is a
// cheap no-op on every boot after the first. Shared by the server's startup layer AND the V1
// config service's first read, so a fresh install imports its config on ANY entry point (serve,
// run, debug config, providers) — jsonc files are read here and by the explicit Import button
// ONLY, never for runtime resolution. Best-effort by contract: callers decide error handling
// (the server ignores failures; a seed failure must never block startup).
export const seedAll = (globalConfigDir: string, directory: string, home: string) =>
  Effect.gen(function* () {
    yield* CatalogSeed.seedFromDirectory(globalConfigDir, directory).pipe(Effect.ignore)
    yield* AgentConfigSeed.seedFromDirectory(globalConfigDir, directory).pipe(Effect.ignore)
    yield* CommandConfigSeed.seedFromDirectory(globalConfigDir, directory).pipe(Effect.ignore)
    yield* SkillConfigSeed.seedFromDirectory(globalConfigDir, directory, home).pipe(Effect.ignore)
    yield* ReferenceConfigSeed.seedFromDirectory(globalConfigDir, directory, home).pipe(Effect.ignore)
    yield* PluginConfigSeed.seedFromDirectory(globalConfigDir, directory).pipe(Effect.ignore)
    yield* SettingsConfigSeed.seedFromDirectory(globalConfigDir, directory).pipe(Effect.ignore)
  })
