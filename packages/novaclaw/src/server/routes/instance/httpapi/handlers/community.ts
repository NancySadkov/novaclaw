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
