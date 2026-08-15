import { describe, expect } from "bun:test"
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
