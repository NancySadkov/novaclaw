export * as CommunityTransport from "./transport"

import { Context, Effect, Layer } from "effect"
import { CommunityChannels } from "./channels"
import { CommunityMessage } from "./message"
import { makeGlobalNode } from "../effect/app-node"
import { Offline } from "../offline"

/**
 * Community P2 — the seam a transport plugs into (`todo/community-p2p.md`).
 *
 * 🔴 This exists so ONE unmeasurable number stops blocking six phases. Choosing between iroh and
 * libp2p rests on cross-NAT success, which cannot be measured from a single machine — but that
 * choice is an implementation detail BEHIND this interface, not a prerequisite for it. The instance
 * asks for "publish this signed message" and "tell me what you can reach"; whatever satisfies that,
 * as a sidecar process in the llama.cpp pattern, is swappable without touching anything above.
 *
 * ⚠️ Incoming messages MUST arrive through `CommunityChannels.record`, never straight into the
 * table. That function is the one ingress door where signature, channel, block and duplicate rules
 * live; a transport that wrote rows itself would be a second door with none of them.
 */

export type State =
  /** No transport is installed. The community is local-only, and the UI says so plainly. */
  | { readonly kind: "off"; readonly reason: "none" | "airgap" }
  | { readonly kind: "connecting" }
  | { readonly kind: "online"; readonly peers: number }

export interface Interface {
  readonly state: () => Effect.Effect<State>
  /**
   * Send a signed message to a channel's subscribers.
   *
   * Returns false when nothing could carry it. NOT an error: "there is no network yet" is the
   * ordinary state of a fresh install, and a failing effect would turn it into a red screen.
   */
  readonly publish: (message: CommunityMessage.Signed) => Effect.Effect<boolean>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CommunityTransport") {}

/**
 * The transport that does nothing — and the ONLY implementation until P0 picks one.
 *
 * 🔴 It also enforces the airgap rule, which is why the offline check lives here rather than in a
 * future sidecar: *"telemetry is scrubbed of user content and forced off in offline/airgap mode"*
 * applies with more force to a peer-to-peer network. A community feature is egress the user chose,
 * so airgap has to be able to withdraw that choice — and if the gate lived only in the real
 * transport, the airgap promise would be true exactly until someone wrote a second one.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const offline = yield* Offline.Service

    const state = Effect.fn("CommunityTransport.state")(function* () {
      // `policy` is a live getter over the process-wide ref, so this follows a Settings change
      // without a restart. Capturing `policy.enabled` at construction would produce a gate that
      // reports itself as on while being off — the exact failure that made it a getter.
      return offline.policy.enabled
        ? ({ kind: "off", reason: "airgap" } as const)
        : ({ kind: "off", reason: "none" } as const)
    })

    return Service.of({
      state,
      publish: Effect.fn("CommunityTransport.publish")(function* (_message: CommunityMessage.Signed) {
        // Nothing to publish through. The caller stores its own copy either way, so a user's message
        // is never lost — it simply has no audience until a transport lands.
        return false
      }),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Offline.node, CommunityChannels.node] })
