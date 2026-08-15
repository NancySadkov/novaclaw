import { CommunityChannels } from "@novaclaw/core/community/channels"
import { CommunityContacts } from "@novaclaw/core/community/contacts"
import { CommunityPost } from "@novaclaw/core/community/post"
import { CommunityTransport } from "@novaclaw/core/community/transport"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { InvalidRequestError } from "../errors"

/**
 * Community P3/P4 — the forum's HTTP surface (`todo/community-p2p.md`).
 *
 * Thin on purpose. Every rule about what may be stored lives in the stores — one ingress door, so a
 * second caller cannot arrive later with its own idea of what counts as a valid contact or message.
 */
export const communityHandlers = HttpApiBuilder.group(InstanceHttpApi, "community", (handlers) =>
  Effect.gen(function* () {
    const contacts = yield* CommunityContacts.Service
    const channels = yield* CommunityChannels.Service
    const transport = yield* CommunityTransport.Service
    const posts = yield* CommunityPost.Service

    return handlers
      .handle(
        "contactList",
        Effect.fn("CommunityHttpApi.contactList")(function* () {
          return yield* contacts.list()
        }),
      )
      .handle(
        "contactAdd",
        Effect.fn("CommunityHttpApi.contactAdd")(function* (ctx) {
          // The store owns the "is this actually a public key" rule; the handler only translates
          // its refusal into an HTTP one rather than re-deciding it here.
          return yield* contacts
            .add({
              networkID: ctx.payload.networkID,
              ...(ctx.payload.petname === undefined ? {} : { petname: ctx.payload.petname }),
              ...(ctx.payload.routes === undefined ? {} : { routes: ctx.payload.routes }),
            })
            .pipe(
              Effect.catchTag("CommunityContacts.ContactError", (error) =>
                Effect.fail(new InvalidRequestError({ message: error.message })),
              ),
            )
        }),
      )
      .handle(
        "contactForget",
        Effect.fn("CommunityHttpApi.contactForget")(function* (ctx) {
          return yield* contacts.forget(ctx.params.networkID)
        }),
      )
      .handle(
        "contactBlock",
        Effect.fn("CommunityHttpApi.contactBlock")(function* (ctx) {
          return yield* contacts.setBlocked(ctx.params.networkID, ctx.payload.blocked)
        }),
      )
      .handle(
        "transportState",
        Effect.fn("CommunityHttpApi.transportState")(function* () {
          return yield* transport.state()
        }),
      )
      .handle(
        "channelList",
        Effect.fn("CommunityHttpApi.channelList")(function* () {
          return yield* channels.channels()
        }),
      )
      .handle(
        "channelJoin",
        Effect.fn("CommunityHttpApi.channelJoin")(function* (ctx) {
          yield* channels.join(ctx.payload.name)
          return yield* channels.channels()
        }),
      )
      .handle(
        "channelArchived",
        Effect.fn("CommunityHttpApi.channelArchived")(function* () {
          return yield* channels.archived()
        }),
      )
      .handle(
        "channelLeave",
        Effect.fn("CommunityHttpApi.channelLeave")(function* (ctx) {
          // ⚠️ The store deliberately keeps the history. Leaving is a subscription change, not a
          // deletion, and rejoining must not present an empty room the user knows had messages.
          return yield* channels.leave(ctx.params.name)
        }),
      )
      .handle(
        "channelMute",
        Effect.fn("CommunityHttpApi.channelMute")(function* (ctx) {
          return yield* channels.setMuted(ctx.params.name, ctx.payload.muted)
        }),
      )
      .handle(
        "channelPost",
        Effect.fn("CommunityHttpApi.channelPost")(function* (ctx) {
          const result = yield* posts.post(ctx.params.name, ctx.payload.body)
          return { id: result.message.signature, stored: result.stored, delivered: result.delivered }
        }),
      )
      .handle(
        "channelHistory",
        Effect.fn("CommunityHttpApi.channelHistory")(function* (ctx) {
          return yield* channels.history(ctx.params.name)
        }),
      )
  }),
)

/**
 * Community P2 — the peer ingress handler.
 *
 * 🔴 Everything it does is hand the payload to `CommunityChannels.deliver` and answer the same way
 * regardless. `deliver` is the ONE door where work, signature, subscription, block, size and
 * duplicate rules live; a handler that pre-screened here would be a second door with a subset of
 * them, and the subset is what gets forgotten.
 */
export const communityPeerHandlers = HttpApiBuilder.group(InstanceHttpApi, "communityPeer", (handlers) =>
  Effect.gen(function* () {
    const channels = yield* CommunityChannels.Service

    return handlers.handle(
      "communityInbound",
      Effect.fn("CommunityHttpApi.communityInbound")(function* (ctx) {
        // The verdict is deliberately dropped rather than returned — see `PeerAck`. It is not lost:
        // a stored message appears in the channel, and a rejected one is the door doing its job.
        yield* channels.deliver(ctx.payload.topic, ctx.payload.message)
        return { received: true } as const
      }),
    )
  }),
)
