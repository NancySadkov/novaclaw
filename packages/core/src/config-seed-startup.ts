export * as ConfigSeedStartup from "./config-seed-startup"

import path from "path"
import { Effect } from "effect"
import { Log } from "@novaclaw/schema/log"
import { AgentConfigStore } from "./agent-config-store"
import { CatalogStore } from "./catalog-store"
import { CommandConfigStore } from "./command-config-store"
import { Flag } from "./flag/flag"
import { FSUtil } from "./fs-util"
import { ReferenceConfigStore } from "./reference-config-store"
import { SettingsConfigStore } from "./settings-config-store"
import { SkillConfigStore } from "./skill-config-store"
import { AgentConfigSeed } from "./agent-config-seed"
import { CatalogSeed } from "./catalog-seed"
import { CommandConfigSeed } from "./command-config-seed"
import { ReferenceConfigSeed } from "./reference-config-seed"
import { SettingsConfigMigrate } from "./settings-config-migrate"
import { SettingsConfigSeed } from "./settings-config-seed"
import { SkillConfigSeed } from "./skill-config-seed"

/**
 * The filenames every seed reads, and the one env source that stands in for a file.
 *
 * ⚠️ **A sixth copy of a list that five seeds already each declare privately, and that is a real
 * coupling rather than untidiness:** if any seed's list diverges from this one, the report below
 * describes a file nothing reads, or stays silent about one that was ignored. `config-seed-names.ts`
 * would be the fix and it is not this slice’s — filed rather than done, because collapsing five
 * private lists also moves the guard that counts them. What holds meanwhile is
 * `config-seed-names.test.ts`, which asserts every such list carries `novaclaw.jsonc` and none
 * carries the PROJECT filename — so the lists cannot drift apart on the name that matters most.
 */
const NAMES = ["config.json", "novaclaw.jsonc"]

/**
 * 🔴 **Say when an authored config file was READ AND DISCARDED, because "applies exactly once" is a
 * rule the user has no way to know.**
 *
 * Every seed below is `isEmpty`-gated, so a config file applies on the boot where its store is empty
 * and is inert on every boot after — silently. A user who edits `novaclaw.jsonc` on a live instance
 * gets no signal whatsoever: two of the six seeds read the file, decode it successfully and then drop
 * it on the floor (`if (!providersSeeded) { … }` with no else), and the other four return before
 * looking at it. That is principle 12's c64 line exactly — a value that decides the outcome and is
 * nowhere on screen.
 *
 * ⚠️ **The gate itself is CORRECT and is not what changes here.** `doc/config.md` is explicit that a
 * jsonc file is an import/export wire and never a runtime source, so a file that re-applied on every
 * boot would silently overwrite whatever the user had since changed in the UI — the same defect
 * pointing the other way. The rule stays; the silence goes.
 *
 * Reported at THIS level rather than in each seed, because six gates that each remember to report are
 * six chances to forget — and the codebase already shows what that costs: this is one pass, it knows
 * the config dir, and it is the only caller. One site, one event.
 */
/**
 * Which stores already hold rows. Sampled BEFORE the seeds run, and that ordering is the whole
 * correctness of the report.
 *
 * 🔴 The first version asked AFTER, reasoning that a first boot would report nothing because its
 * stores "were empty when it mattered". They were — and by the time it asked, the seed had filled
 * them, so a genuine first-boot import reported itself as ignored. Exactly inverted, and invisible
 * to the positive test: the event fired, named the right file, and named plausible stores. Only the
 * negative control that demanded SILENCE on a first pass could tell the two apart.
 */
const populatedStores = Effect.gen(function* () {
  const populated: string[] = []
  if (!(yield* (yield* CatalogStore.Service).isEmpty())) populated.push("catalog")
  if (!(yield* (yield* AgentConfigStore.Service).isEmpty())) populated.push("agent")
  if (!(yield* (yield* CommandConfigStore.Service).isEmpty())) populated.push("command")
  if (!(yield* (yield* SkillConfigStore.Service).isEmpty())) populated.push("skill")
  if (!(yield* (yield* ReferenceConfigStore.Service).isEmpty())) populated.push("reference")
  if (!(yield* (yield* SettingsConfigStore.Service).isEmpty())) populated.push("settings")
  return populated
}).pipe(Effect.orElseSucceed(() => [] as string[]))

const reportIgnoredSources = (globalConfigDir: string, alreadyPopulated: readonly string[]) =>
  Effect.gen(function* () {
    if (alreadyPopulated.length === 0) return
    const fs = yield* FSUtil.Service
    const sources: string[] = []
    for (const name of NAMES) {
      const candidate = path.join(globalConfigDir, name)
      if (yield* fs.exists(candidate)) sources.push(candidate)
    }
    if (Flag.NOVACLAW_CONFIG_CONTENT) sources.push("NOVACLAW_CONFIG_CONTENT")
    // Nothing authored means nothing was discarded. This is the common case on a normal boot, and it
    // is what keeps the event from firing on every start of every instance forever.
    if (sources.length === 0) return

    yield* Log.event("config.seed.ignored", {
      "config.path": sources.join(", "),
      "config.stores": alreadyPopulated,
    })
  })

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
// Pre-detachment pattern with a real defect: seeding is isEmpty-gated and one-time, so WHICHEVER
// PROCESS BOOTED FIRST silently defined instance-wide settings forever — a `novaclaw` run in some
// random folder could permanently define the instance's providers. Config is instance-level, so it
// comes from the instance's config dir. A per-PROJECT config, if it ever returns, must be a real
// location-scoped store consulted at resolution time, never a first-boot import from cwd.
// Negative-controlled by `config-seed-ignores-launch-directory.test.ts`.
export const seedAll = (globalConfigDir: string, home: string) =>
  Effect.gen(function* () {
    // Sampled first: after the seeds, a store the seed just filled is indistinguishable from one
    // that refused the file.
    const alreadyPopulated = yield* populatedStores
    yield* CatalogSeed.seedFromDirectory(globalConfigDir).pipe(Effect.ignore)
    yield* AgentConfigSeed.seedFromDirectory(globalConfigDir).pipe(Effect.ignore)
    yield* CommandConfigSeed.seedFromDirectory(globalConfigDir).pipe(Effect.ignore)
    yield* SkillConfigSeed.seedFromDirectory(globalConfigDir, home).pipe(Effect.ignore)
    yield* ReferenceConfigSeed.seedFromDirectory(globalConfigDir, home).pipe(Effect.ignore)
    // (There is no plugin seed. Ruling 5 / step 17 deleted the `plugins[]` key and its store; a
    // user's own `{plugin,plugins}/*.ts` files are filesystem-walked by `config/plugin/external.ts`
    // at load time and were never imported here.)
    yield* SettingsConfigSeed.seedFromDirectory(globalConfigDir).pipe(Effect.ignore)
    // …and THEN the data repairs over whatever is already stored. Ordered last on purpose: the
    // seeds above are isEmpty-gated first-boot IMPORTS, so a value that just arrived from a
    // hand-authored jsonc must still pass through the same migrations an existing row does — a
    // user restoring an exported config carries the same stale `quality.commands.check` an
    // upgrading instance does. Runs on every boot (idempotent by contract), not just the first.
    yield* SettingsConfigMigrate.migrateAll().pipe(Effect.ignore)
    // Best-effort by this module's contract: a report must never be the thing that faults startup.
    yield* reportIgnoredSources(globalConfigDir, alreadyPopulated).pipe(Effect.ignore)
  })
