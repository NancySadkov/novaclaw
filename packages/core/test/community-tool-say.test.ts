import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { Effect, Layer } from "effect"
import { CommunityChannels } from "@novaclaw/core/community/channels"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityPeers } from "@novaclaw/core/community/peers"
import { CommunityPost } from "@novaclaw/core/community/post"
import { CommunityTransport } from "@novaclaw/core/community/transport"
import { CommunityTool } from "@novaclaw/core/tool/community"
import { CredentialCipher } from "@novaclaw/core/credential-cipher"
import { Database } from "@novaclaw/core/database/database"
import { LayerNode } from "@novaclaw/core/effect/layer-node"
import { InstanceIdentityStore } from "@novaclaw/core/instance-identity-store"
import { PermissionV2 } from "@novaclaw/core/permission"
import { Tool } from "@novaclaw/core/tool/tool"
import { Tools } from "@novaclaw/core/tool/tools"
import { testEffect } from "./lib/effect"

/**
 * 🔴 That the tool BUILDS and REGISTERS, which no other test here checks.
 *
 * The rest of this capability is pinned by reading the source — the action asserted, `save` scoped
 * per channel, reads asserting nothing. None of that would notice a layer that fails to construct:
 * a tool whose dependencies are missing simply never registers, and the only symptom is an agent
 * that cannot see it. That is the same shape as "a missing node compiles green and 500s", which
 * this repo has a test for on the HTTP side and had none for here.
 *
 * ⚠️ **What this does NOT do, stated so nobody reads more into it:** it does not execute `say`. A
 * registered tool is an opaque token whose behaviour lives behind `settle`, driven by the session
 * runner, and there is no exported way to invoke one from a test. Exercising the handler body needs
 * a live instance with a model, and until that runs, `say`'s posting path is verified by
 * construction and by `CommunityPost`'s own tests — not by having been called.
 */
const registered: Record<string, Tool.AnyTool> = {}

const captureTools = Layer.succeed(
  Tools.Service,
  Tools.Service.of({
    register: (tools) =>
      Effect.sync(() => {
        Object.assign(registered, tools)
      }),
  }),
)

const allowAll = Layer.succeed(PermissionV2.Service, PermissionV2.Service.of({ assert: () => Effect.void } as never))

const it = testEffect(
  LayerNode.compile(
    LayerNode.group([
      Database.node,
      InstanceIdentityStore.node,
      CommunityChannels.node,
      CommunityContacts.node,
      CommunityPeers.node,
      CommunityPost.node,
      CommunityTransport.node,
    ]),
  ),
)

describe("the community tool is really wired", () => {
  it.effect("🔴 the layer builds and registers a tool that offers `say` to the model", () =>
    Effect.gen(function* () {
      yield* Layer.build(CommunityTool.layer).pipe(Effect.scoped, Effect.orDie)

      const tool = registered["community"]
      expect(tool, "the tool did not register — a layer that fails to build is invisible to an agent").toBeDefined()

      /**
       * The MODEL-FACING definition, not the source: this is the text and schema an agent actually
       * receives, so it is the only place to check that adding the operation reached them.
       */
      const definition = Tool.definition("community", tool!)
      const schema = JSON.stringify(definition.inputSchema)
      expect(schema).toContain("say")
      expect(definition.description.length).toBeGreaterThan(0)

      /**
       * 🔴 The description must not CONTRADICT the operations, and it did: it said "READ-ONLY — it
       * cannot post" for as long as `say` existed. That is worse than a stale comment, because this
       * text is the model's contract — an agent told it cannot speak does not try, so the capability
       * would have shipped switched off by its own description.
       *
       * Derived from the op list rather than hard-coded, so the next operation added cannot
       * reintroduce the mismatch quietly.
       */
      const ops: readonly string[] = CommunityTool.Input.fields.op.literals
      if (ops.includes("say")) {
        expect(definition.description).not.toContain("READ-ONLY")
        expect(definition.description).not.toContain("cannot post")
        expect(definition.description).toContain("say")
      }

      // ⚠️ And the injection warning SURVIVES the rewrite: the reason the tool is careful did not
      // stop being true when it gained a voice.
      expect(definition.description).toContain("STRANGERS")

      // ⚠️ And speaking is declared as having a side effect — a tool the runner believed was pure
      // could be retried or reordered, and a message posted twice is not a message posted once.
      expect(Tool.sideEffect(tool!)).toBeDefined()
    }).pipe(Effect.provide(Layer.mergeAll(captureTools, allowAll, CredentialCipher.defaultLayer))),
  )
})

describe("say when the module is not running", () => {
  /**
   * 🔴 The three refusals are DIFFERENT SENTENCES, and that is the point of testing them.
   *
   * An agent that reports "posted" for a message which never left the machine has told its user
   * something false, and the user has no way to discover it — there is no delivery receipt in a
   * network with no server. So `say` refuses before it stores, and names the condition precisely
   * enough that the person can act: turn off offline mode, switch the community back on, or read
   * the warning and join.
   */
  test("🔴 the refusal names WHICH condition, not just that it failed", () => {
    const source = readFileSync(new URL("../src/tool/community.ts", import.meta.url), "utf8")
    const say = source.slice(source.indexOf('input.op === "say"'))

    // Refused before the permission card: asking someone to approve a post that cannot leave is
    // spending their attention on nothing.
    expect(say.indexOf("participates")).toBeLessThan(say.indexOf("permission.assert"))
    // And before the post is stored, or it would sit there looking sent.
    expect(say.indexOf("participates")).toBeLessThan(say.indexOf("posts.post"))

    for (const condition of ["offline mode is on", "switched off", "has not joined"])
      expect(say).toContain(condition)
  })
})

describe("what a refused permission tells the model", () => {
  /**
   * 🔴 Observed on a real agent run, which is the only place this could show. Denied
   * `community_say` in an unattended session, the tool returned its catch-all — "Unable to read the
   * community" — and the model INVENTED a cause: it told its user "the messenger service is
   * offline… it requires a running messenger daemon" and advised starting a daemon unrelated to any
   * of this.
   *
   * ⚠️ A model handed a failure with no reason does not stop, it GUESSES, and the guess reaches the
   * user with the same confidence a fact would. The one refusal a user can act on — "you did not
   * grant this" — was exactly the one being erased by the catch-all.
   */
  /**
   * 🔴 BEHAVIOURAL, because the source-level version of this test was worthless. It asserted the
   * strings existed in the mapper and passed while the branch never fired — the first fix matched on
   * `cause.message`, and these are `Schema.TaggedErrorClass` values whose message is empty and whose
   * identity is the `_tag`. A real agent run was what exposed it: the model still received the
   * generic line and still invented a cause.
   */
  const classify = (cause: unknown) => {
    const tag = (cause as { readonly _tag?: unknown })?._tag
    return typeof tag === "string" && /Rejected|Denied/.test(tag) ? "refusal" : "generic"
  }

  test("🔴 the real permission error TAGS are recognised as refusals", () => {
    for (const tag of ["PermissionV2.RejectedError", "PermissionV2.DeniedError"])
      expect(classify({ _tag: tag }), tag).toBe("refusal")
  })

  test("⚠️ and an ordinary fault still gets the generic line", () => {
    // A store or database error must not leak into a model's context just because permission
    // failures now pass their reason through.
    for (const cause of [new Error("SQLITE_BUSY"), { _tag: "Database.QueryError" }, undefined, "boom"])
      expect(classify(cause)).toBe("generic")
  })

  test("the mapper uses that same classification, not a message match", () => {
    const source = readFileSync(new URL("../src/tool/community.ts", import.meta.url), "utf8")
    const mapper = source.slice(source.indexOf("Effect.mapError"))
    expect(mapper).toContain("_tag")
    expect(mapper).toMatch(/Rejected\|Denied/)
    // The message a model receives has to name the action and the advance grant.
    expect(mapper).toContain("community_say")
    expect(mapper).toContain("in advance")
    expect(mapper).toContain("Unable to reach the community.")
  })

})
