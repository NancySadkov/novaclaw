# NovaClaw V2 Effect Plugin API

The Effect plugin API grants plugins these in-process capabilities:

- `transform` contributes to a stateful domain — agents, the catalog, commands, integrations, references, skills — and is replayed whenever that domain rebuilds.
- `reload` reruns every transform for one domain, for when the data a transform captured has changed.
- `register` contributes a model-facing tool (`ctx.tool.register`).
- `subscribe` observes the instance's events (`ctx.event.subscribe`).
- `add` / `remove` load and unload another plugin (`ctx.plugin`).

Configuration supplied for the plugin is `ctx.options`.

> This list used to read "two in-process capabilities: `hook` and `reload`". That was wrong in
> both halves — there is no `hook` member on any domain (the replayable one is `transform`), and
> it silently omitted `tool` and `plugin`. Keep it enumerated against `context.ts`.

The public server client will be exposed separately. It is intentionally not part of `PluginContext` yet.

## Defining A Plugin

```ts
import { define } from "@novaclaw-ai/plugin/v2/effect"
import { Effect } from "effect"

export const Plugin = define({
  id: "example",
  effect: Effect.fn(function* (ctx) {
    yield* ctx.catalog.transform((catalog) => {
      catalog.provider.update("example", (provider) => {
        provider.name = "Example"
      })
    })
  }),
})
```

Plugin setup registers hooks imperatively. It does not return a hook object.

Configuration supplied for the plugin is available as `ctx.options`.

Registrations are owned by the plugin scope. Closing the scope removes them automatically; a registration may also be removed early through `dispose`.

## Transform Hooks

Transform hooks contribute to stateful domains:

```ts
yield *
  ctx.agent.transform((agent) => {
    agent.update("reviewer", (item) => {
      item.description = "Reviews code for regressions"
      item.mode = "subagent"
    })
  })
```

NovaClaw rebuilds the domain when a transform is registered or disposed. A rebuild starts from fresh domain state and runs every active transform in registration order.

Available transform hooks are namespaced by domain:

```ts
ctx.agent.transform
ctx.catalog.transform
ctx.command.transform
ctx.integration.transform
ctx.reference.transform
ctx.skill.transform
```

## Reloading A Domain

When data captured by a transform changes, reload the affected domain:

```ts
let data = yield * loadCatalog()

yield *
  ctx.catalog.transform((catalog) => {
    applyCatalog(data, catalog)
  })

data = yield * loadCatalog()
yield * ctx.catalog.reload()
```

Reload belongs to the domain, not an individual registration. `ctx.catalog.reload()` reruns every active catalog transform and publishes the rebuilt catalog.

Available reload operations are:

```ts
ctx.agent.reload()
ctx.catalog.reload()
ctx.command.reload()
ctx.integration.reload()
ctx.reference.reload()
ctx.skill.reload()
```

## Observing Events

`ctx.event.subscribe` hands the host a callback and gets back a `Registration`:

```ts
yield * ctx.event.subscribe("catalog.updated", (event) => Effect.logInfo("the catalog changed", { id: event.id }))
```

The registration is owned by the plugin scope exactly like `ctx.tool.register` — unloading the
plugin ends the subscription, and `registration.dispose` ends it early.

**The host owns the fork, the isolation and the buffering; you own the callback.** That is
deliberate, and it is why this is a callback rather than a `Stream`:

- A handler that fails, throws or dies is logged and the subscription **survives** — the next
  event is still delivered.
- One plugin's bad handler never starves another plugin's subscription.
- Delivery is buffered per subscription and **drops** — with a warning naming the type and the
  capacity — once a handler falls far enough behind. A slow plugin cannot grow the instance's
  memory without bound.

Handing out a raw `Stream` would push all three onto every plugin author, and we get it wrong
ourselves when we try (our own internal models-dev plugin forked a stream with no `catchCause`,
so one defect would have left it deaf for the rest of the process).

### What you receive, precisely

- **Events published at your location.** A plugin is loaded per location; another location's
  traffic never reaches you.
- **Plus events with no location at all.** Those are genuinely instance-global — `location` is
  only stamped when a `Location` is in the publisher's scope, so anything published by a global
  service (`models-dev.refreshed`, catalog refreshes, installation events) carries none. A global
  event is nobody else's data, so you get it.

Nothing else. In particular this is _not_ a firehose of every session in every directory.

### What the types buy you

`type` is checked against the generated SDK `Event` union — the same contract a client of
`/event` sees — so a typo is a compile error and the payload you receive is the public wire shape
`{ id, type, properties }`, never the kernel's internal payload.

⚠️ Be honest about the limit: **most** members of that union declare
`properties: { [key: string]: unknown }`, because their internal schema is an open record. So you
get _type names and a checked discriminant_, not deep field-level type safety. Where a payload is
narrow (`session.created`, `integration.connection.updated`, …) the fields are real; everywhere
else, narrow `properties` yourself.

One type in the union, `server.instance.disposed`, is emitted by the instance supervisor outside
the kernel event bus and is therefore never delivered here. Subscribing to it logs a warning
rather than failing — but it will not fire.
