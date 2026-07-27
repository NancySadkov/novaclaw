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
// the GLOBAL CONFIG DIR's jsonc (+ NOVACLAW_CONFIG_CONTENT) and imports each subsystem into its
// SQLite store — each seed idempotent (isEmpty-gated), so this is a cheap no-op on every boot
// after the first. Shared by the server's startup layer AND the V1 config service's first read,
// so a fresh install imports its config on ANY entry point (serve, run, debug config, providers)
// — jsonc files are read here and by the explicit Import button ONLY, never for runtime
// resolution. Best-effort by contract: callers decide error handling (the server ignores
// failures; a seed failure must never block startup).
//
// ⚠️ It deliberately does NOT read the launch directory (2026-07-27). It used to, and that was an
// opencode-legacy pattern with a real defect: seeding is isEmpty-gated and one-time, so WHICHEVER
// PROCESS BOOTED FIRST silently defined instance-wide settings forever — a `novaclaw` run in some
// random folder could permanently define the instance's providers. Config is instance-level, so it
// comes from the instance's config dir. A per-PROJECT config, if it ever returns, must be a real
// location-scoped store consulted at resolution time, never a first-boot import from cwd.
// Negative-controlled by `config-seed-ignores-launch-directory.test.ts`.
export const seedAll = (globalConfigDir: string, home: string) =>
  Effect.gen(function* () {
    yield* CatalogSeed.seedFromDirectory(globalConfigDir).pipe(Effect.ignore)
    yield* AgentConfigSeed.seedFromDirectory(globalConfigDir).pipe(Effect.ignore)
    yield* CommandConfigSeed.seedFromDirectory(globalConfigDir).pipe(Effect.ignore)
    yield* SkillConfigSeed.seedFromDirectory(globalConfigDir, home).pipe(Effect.ignore)
    yield* ReferenceConfigSeed.seedFromDirectory(globalConfigDir, home).pipe(Effect.ignore)
    yield* PluginConfigSeed.seedFromDirectory(globalConfigDir).pipe(Effect.ignore)
    yield* SettingsConfigSeed.seedFromDirectory(globalConfigDir).pipe(Effect.ignore)
  })
