/**
 * THE channel resolver — one implementation, every build site.
 *
 * `NOVACLAW_CHANNEL` is the ONLY input. Nothing else may be consulted, and in particular NOT git:
 * `packages/script/src/index.ts` used to fall back to `git branch --show-current`, which was wrong
 * twice over. It **throws in the published source zip** (there is no `.git` there, and novaclaw.app
 * ships one), and when it did resolve it **baked a branch name into shipped binaries** — the channel
 * becomes the `NOVACLAW_CHANNEL` build-time define, which becomes `InstallationChannel`
 * (`packages/core/src/installation/version.ts`), which picks the instance data directory and the DB
 * filename. So a build made on branch `dev` and one made on branch `feature/x` silently used
 * DIFFERENT DATABASES.
 *
 * (The version is a GENERATED constant and the channel is a DEFINE. That asymmetry is deliberate and
 * documented in AGENTS.md → *Version — ONE source*: one commit ships as dev, beta or prod, so
 * "local" is the honest answer for an unbuilt tree. Do not "fix" it by generating the channel.)
 *
 * ─── the semantics, identical at every call site ───────────────────────────────────────────────
 *   unset / empty     -> "dev"    `build-desktop.bat` sets nothing and expects a dev build;
 *                                 `build-desktop-release.bat` sets NOVACLAW_CHANNEL=prod.
 *   "latest"          -> "prod"   electron-builder's publish vocabulary names the prod feed
 *                                 "latest" (see electron-builder.config.ts), and
 *                                 electron.vite.config.ts already normalised it this way.
 *   "dev"|"beta"|"prod" -> itself
 *   anything else     -> THROW
 *
 * **Why a throw and not a silent fallback to "dev".** Three of the four old resolvers fell back to
 * "dev" and the fourth passed the raw string straight through into the define — i.e. a typo either
 * produced a wrongly-labelled artifact or a wrong DB filename, and neither said anything. AGENTS.md
 * → *Known pitfalls #0* records this project shipping the literal STRING `"undefined"` as an env
 * value; a fallback swallows exactly that, a throw names it. Build tooling is the right layer to be
 * loud at, because every consumer downstream of the define (the app id, the data dir, the DB file)
 * can only guess.
 *
 * ⚠️ **Keep this module dependency-free and side-effect-free.** It is imported from Node as well as
 * from Bun — jiti loads `electron-builder.config.ts` (app-builder-lib `util/config/load.js`) and
 * vite/esbuild bundles `electron.vite.config.ts` — so it may not touch `Bun`, `$`, or anything a
 * Node loader cannot see. `process.env` is the one thing both runtimes agree on.
 */
export type Channel = "dev" | "beta" | "prod"

/** The valid set, in the order the product ships them. */
export const CHANNELS: readonly Channel[] = ["dev", "beta", "prod"]

/**
 * Resolve the build channel. `raw` defaults to the env var and is read at CALL time, never frozen at
 * module import (AGENTS.md → Known pitfalls #0(a)).
 *
 * @throws if `raw` is a non-empty string that is not a channel or the "latest" alias.
 */
/**
 * Whether a channel was EXPLICITLY configured, as opposed to defaulting to dev.
 *
 * Exists so no other module has to read `NOVACLAW_CHANNEL` itself just to ask that question — which is
 * how the second copy of a resolver always starts. The distinction is real: unset-means-dev is the
 * right answer when producing a build and the wrong one when INSPECTING an artifact off disk, where
 * the honest fallback is what the file itself says (see scripts/smoke-artifact.ts).
 */
export function channelConfigured(): boolean {
  const raw = process.env["NOVACLAW_CHANNEL"]
  return raw !== undefined && raw !== ""
}

export function resolveChannel(raw: string | undefined = process.env["NOVACLAW_CHANNEL"]): Channel {
  if (raw === undefined || raw === "") return "dev"
  if (raw === "latest") return "prod"
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  throw new Error(
    `NOVACLAW_CHANNEL=${JSON.stringify(raw)} is not a channel. Use one of ${CHANNELS.join(", ")} ` +
      `(or "latest", an alias for prod), or leave it unset for dev. The channel picks the app id, the ` +
      `instance data directory and the database filename, so it is never guessed.`,
  )
}
