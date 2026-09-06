export * as ConfigExternalPlugin from "./external"

import type { Plugin as EffectPlugin } from "@novaclaw/plugin/v2/effect"
import type { Plugin as PromisePlugin } from "@novaclaw/plugin/v2/promise"
import { Log } from "@novaclaw/schema/log"
import { Effect, Schema } from "effect"
import { pathToFileURL } from "url"
import { Flag } from "../../flag/flag"
import { FSUtil } from "../../fs-util"
import { Global } from "../../global"
import { ConfigPluginGlob } from "./glob"
import { define } from "../../plugin/internal"
import { CAPABILITIES } from "../../plugin/internal"
import { PluginPromise } from "../../plugin/promise"

const PluginModule = Schema.Struct({
  default: Schema.Union([
    Schema.Struct({
      id: Schema.String,
      // ⚠️ Declared here or it is DROPPED. Effect Schema keeps only what a struct names, so a
      // plugin's `capabilities` would decode away silently and the host would report every plugin
      // as declaring nothing — a field lost on the way IN, which reads exactly like a field nobody
      // set.
      capabilities: Schema.optional(Schema.Array(Schema.String)),
      effect: Schema.declare<EffectPlugin["effect"]>(
        (input): input is EffectPlugin["effect"] => typeof input === "function",
      ),
    }),
    Schema.Struct({
      id: Schema.String,
      capabilities: Schema.optional(Schema.Array(Schema.String)),
      setup: Schema.declare<PromisePlugin["setup"]>(
        (input): input is PromisePlugin["setup"] => typeof input === "function",
      ),
    }),
  ]),
})

/**
 * The one pattern an external plugin may be found under, relative to the INSTANCE config dir.
 *
 * Re-exported rather than declared: it lives in the leaf `./glob.ts` so the CLI can print the same
 * directory without importing this file's graph. See that module's header.
 */
export const PLUGIN_GLOB = ConfigPluginGlob.PATTERN

// The ONE remaining door in-process third-party code comes through, and it is deliberately the
// narrowest door in the tree: `{plugin,plugins}/*.{ts,js}` under the INSTANCE CONFIG DIRECTORY —
// `Global.Service.config`, i.e. `<instance-home>/config` or whatever `NOVACLAW_CONFIG_DIR` names.
// One directory, per instance, on the user's own machine.
//
// ⚠️ **It reads `Global.Service`, NOT `Config.entries()`, and that is the whole security property.**
// `Config.entries()` returns the config dir PLUS every `.novaclaw` directory the walk-up
// (`config.ts`: `fs.up({ targets: [".novaclaw"], start: location.directory, stop: location.root })`)
// finds between the session's working folder and its VCS root. Globbing that set — which is what
// this loader did until 2026-08-19 — made `<project>/.novaclaw/plugin/x.ts` load at user privilege
// on the next session opened in that folder, so `git clone` of a hostile repo was arbitrary
// in-process code execution, and so was a file an AGENT wrote into the project it was pointed at
// (AGENTS.md principle 11 calls that the product working). Module scope runs on `import()`, before
// any NovaClaw API is consulted, so nothing downstream could have gated it. Measured end to end
// against the real `Config.layer` and a real glob, with a no-`.novaclaw` control.
// **A project `.novaclaw` still contributes CONFIG — agents, commands, skills, `novaclaw.json` — it
// just never contributes CODE.** Pinned by `test/config/plugin.test.ts`'s
// "never loads a plugin from a project directory".
//
// ⚠️ **THE OTHER HALF OF RULING 5 IS ENFORCED NOW, and it is enforced somewhere else.** The ruling
// let this glob survive on a stated condition — *"user code at user privilege, **unreachable by an
// agent**, a registry or a peer"* — and until 2026-09-02 nothing checked the emphasised clause. Under
// `yolo`, or from a session whose working folder IS the config dir, or with any
// `external_directory_write` allow a user or a repairing agent had written, one redirect put a file
// here and the next boot ran it. `PermissionV2` now refuses every agent-originated write into these
// directories in a pre-emptive arm no mode, ruleset or saved row can soften (`permission.ts` → §THE
// PLUGIN DOOR), and it derives WHICH directories from `ConfigPluginGlob.PATTERN` rather than naming
// them again — so widening the glob widens the guard in the same edit, and narrowing it cannot leave
// the guard pointing at a folder nobody loads from.
//
// ⚠️ There is no second source, and that absence is also the property. Ruling 5
// (`notes/reports/decisions-v0.2.0.md` §5, dependency step 17) deleted the arm that took a package
// NAME from config, fetched it with `npm.add` and `import()`ed the result — remote code at this
// process's privilege — and the `plugins[]` key and `PluginConfigStore` that fed it went with it.
// The out-of-process extension seam is MCP.
//
// `--pure` / `NOVACLAW_PURE` ("run without external plugins") is enforced HERE, at the one place
// third-party code enters the process. It used to gate the V1 loader; when that arm was deleted the
// flag would have become a lie (it is advertised in every CLI --help), so it moved with the
// capability it names. Internal plugins are unaffected — they are first-party, not external.
// Read through `Flag` (process.env at call time) rather than `RuntimeFlags`: `--pure` is mirrored
// into the environment by the CLI middleware precisely so every child process inherits it, and core
// has no dependency on the novaclaw package's flag service.
export const Plugin = define({
  id: "config-plugin",
  capabilities: ["fsUtil", "global"],
  effect: Effect.fn(function* (ctx) {
    if (Flag.NOVACLAW_PURE) {
      yield* Log.event("plugin.external.skipped", {})
      return
    }
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    yield* Effect.gen(function* () {
      const discovered = yield* fs
        .glob(PLUGIN_GLOB, {
          cwd: global.config,
          absolute: true,
          include: "file",
          dot: true,
          symlink: true,
        })
        .pipe(Effect.orElseSucceed(() => []))
      discovered.sort()

      for (const file of discovered) {
        yield* Effect.gen(function* () {
          // A glob hit is always an absolute path (`absolute: true`), so the entrypoint is a plain
          // file URL. There is no name-resolution step left to get wrong.
          const entrypoint = pathToFileURL(file).href

          // `tryPromise`, not `promise`: an entrypoint that throws on import is an ORDINARY failure of
          // third-party code, not a defect in ours. Typed here so the tap below reports it as a plugin
          // fault rather than an anonymous die.
          const mod = yield* Effect.tryPromise(() => import(entrypoint))
          const value = (yield* Schema.decodeUnknownEffect(PluginModule)(mod)).default
          const plugin = "effect" in value ? value : PluginPromise.fromPromise(value)
          /**
           * 🔴 **Disclosure, not enforcement, and the log says which.** A third-party plugin's
           * `capabilities` is a CLAIM: `import()` above already ran its module scope, so nothing
           * here restrains it (principle 13). What this buys is an answer to *what did this thing
           * say it wanted* that does not require reading the plugin's source — recorded at the one
           * point third-party code enters the process.
           *
           * ⚠️ Absent and empty are reported DIFFERENTLY. `undefined` means the plugin declared
           * nothing, `[]` means it declared needing nothing, and folding them together would turn a
           * missing answer into a confident one — the shape ruling 2 forbids.
           *
           * ⚠️ Names the host does not know are reported rather than dropped. A plugin asking for
           * `"netwrok"` has told the user nothing, and a typo silently swallowed is a declaration
           * that reads as complete.
           */
          const declared = value.capabilities
          const unknown = declared?.filter((name) => !(CAPABILITIES as readonly string[]).includes(name)) ?? []
          yield* Log.event("plugin.external.loaded", {
            "plugin.package": file,
            "plugin.id": plugin.id,
            "plugin.capabilities": declared === undefined ? "<undeclared>" : declared.join(",") || "<none>",
            // Always present, never spread-conditionally: an attribute that appears only sometimes
            // reads as missing data on the run where it is absent, and the registry types it as
            // required anyway.
            "plugin.capabilities.unknown": unknown.join(",") || "<none>",
          })
          yield* ctx.plugin.add({
            id: plugin.id,
            // The same value the log line above reports, carried into the host so the disclosure
            // surface shows what THIS plugin claimed rather than a blank for every external one.
            // `undefined` survives as undefined: "declared nothing" is not "declared an empty set".
            capabilities: declared,
            // `options` stays in the host shape because the plugin API declares it; with the config
            // key gone there is nothing left that could carry a value, so it is always empty.
            effect: (host) => plugin.effect({ ...host, options: {} }),
          })
        }).pipe(
          // ⚠️ One broken plugin must never take the others down — but it must never vanish either.
          // Before the V1 arm was deleted, a failed load surfaced through it; this loader swallowed
          // everything with `ignoreCause`, so a user's broken plugin failed INVISIBLY. Ruling 2: a
          // fault is never described falsely, and "silently absent" is the falsest description there
          // is. `tapCause` sees defects too, so an import that throws is reported like any other
          // fault. A warn log is the right surface: this loader is instance-wide, not per-session,
          // and core has no session-event bridge to publish to.
          Effect.tapCause((cause) =>
            Log.event("plugin.external.load.failed", {
              "plugin.package": file,
              "plugin.cause": Log.fault(cause),
            }),
          ),
          Effect.ignoreCause,
        )
      }
    // External discovery is part of initial boot. Returning only after glob/import/setup settles is
    // what gives Plugin.ready its promised meaning: the first turn cannot snapshot a catalogue before
    // an installed plugin has had a chance to register its tools or agents. Each file still has its
    // own fault boundary above, so one broken plugin is reported and does not block the rest.
    })
  }),
})
