export * as CommunityPost from "./post"

import { Context, Effect, Layer } from "effect"
import { CommunityChannels } from "./channels"
import { CommunityMessage } from "./message"
import { CommunityTransport } from "./transport"
import { CommunityWork } from "./work"
import { makeGlobalNode } from "../effect/app-node"
import { InstanceIdentityStore } from "../instance-identity-store"

/**
 * Community P4 — saying something (`notes/spec/community-p2p.md`).
 *
 * The counterpart to `CommunityChannels.record`: that is how a stranger's words come IN, this is how
 * ours go OUT. Sits above identity, the log and the transport because it needs all three, and none
 * of them may depend on it — `transport` already depends on `channels`, so folding this into either
 * would make a cycle.
 *
 * ⚠️ Known edge: the dedup id hashes the signed bytes, and `at` is millisecond-resolution — so the
 * SAME words posted twice inside one millisecond read as a duplicate and the second is dropped.
 * Invisible to a human typing; real the day something posts programmatically in a loop, where the
 * fix is a nonce in the signed bytes rather than finer clock resolution.
 *
 * 🔴 The order is deliberate: sign, STORE, then try to send. Storing first means a user's own words
 * survive a transport that is missing, offline or broken — they are in their own log either way, and
 * the only thing a failed send costs is an audience. The reverse order loses the message whenever
 * the network is the thing that failed, which is exactly when a person is least able to retype it.
 */

export interface Posted {
  readonly message: CommunityMessage.Proven
  /** Stored in our own log — always true on success, because that happens before any send. */
  readonly stored: boolean
  /**
   * Did a transport accept it for delivery?
   *
   * ⚠️ NOT "was it read". Nobody can promise delivery in a network with no server, so this says only
   * that something took it. False means it lives locally and has no audience yet.
   */
  readonly delivered: boolean
}

export interface Interface {
  readonly post: (channel: string, body: string) => Effect.Effect<Posted>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/CommunityPost") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const channels = yield* CommunityChannels.Service
    const transport = yield* CommunityTransport.Service
    // Resolved HERE and provided to `sign` below, so the identity requirement stays inside this
    // layer instead of leaking into `Interface` — a caller should not have to carry the key store
    // in order to say something.
    const identity = yield* InstanceIdentityStore.Service

    return Service.of({
      post: Effect.fn("CommunityPost.post")(function* (channel: string, body: string) {
        const signed = yield* CommunityMessage.sign({ channel, body }).pipe(
          Effect.provideService(InstanceIdentityStore.Service, identity),
        )
        /**
         * ⚠️ Our OWN messages pay the work too. It would be easy to exempt them — we know we are
         * not flooding — but then `record` could not require proof of everything it stores, and a
         * door with an exception is a door. ~50 ms inside a send action nobody notices.
         */
        const message = CommunityWork.prove(signed)
        if (message === undefined) return { message: { ...signed, nonce: 0 }, stored: false, delivered: false }

        /**
         * Our own message goes through the SAME ingress door as everyone else's.
         *
         * It would be shorter to insert the row directly, and that shortcut is how the rules drift:
         * the day retention, dedup or channel-matching changes, a private path would keep the old
         * behaviour for exactly the messages the user cares most about. It also means a post to a
         * channel we have not joined is refused here rather than creating a log nobody subscribes to.
         */
        const recorded = yield* channels.record(channel, message)
        const stored = "stored" in recorded

        // Publish even when storing was refused? No — a message we would not keep is not one to
        // broadcast, and the refusal reasons (not subscribed, duplicate) all mean "do not send".
        const delivered = stored ? yield* transport.publish(message) : false
        return { message, stored, delivered } satisfies Posted
      }),
    })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [InstanceIdentityStore.node, CommunityChannels.node, CommunityTransport.node],
})
