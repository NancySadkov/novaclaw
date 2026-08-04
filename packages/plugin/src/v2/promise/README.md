# NovaClaw V2 Promise Plugin API

The Promise plugin API is the async/await equivalent of `@novaclaw-ai/plugin/v2/effect`. It grants plugins the same in-process capabilities:

- `transform` contributes to a stateful domain — agents, the catalog, commands, integrations, references, skills — and is replayed whenever that domain rebuilds.
- `reload` reruns every transform for one domain, for when the data a transform captured has changed.
- `register` contributes a model-facing tool (`ctx.tool.register`).
- `subscribe` observes the instance's events (`ctx.event.subscribe`).
- `add` / `remove` load and unload another plugin (`ctx.plugin`).

Configuration supplied for the plugin is `ctx.options`.

> This list used to read "the same two in-process capabilities: `hook` and `reload`". That was
> wrong in both halves — there is no `hook` member on any domain (the replayable one is
> `transform`), and it silently omitted `tool` and `plugin`. Keep it enumerated against
> `context.ts`.

The only difference from the Effect API is the async boundary: callbacks, registration, `reload`, and `Registration.dispose` use Promises instead of Effects.

## Defining A Plugin

```ts
import { define } from "@novaclaw-ai/plugin/v2/promise"

export const Plugin = define({
  id: "example",
  setup: async (ctx) => {
    await ctx.catalog.transform((catalog) => {
      catalog.provider.update("example", (provider) => {
        provider.name = "Example"
      })
    })
  },
})
```

Plugin setup registers hooks imperatively. It does not return a hook object.

Configuration supplied for the plugin is available as `ctx.options`.

A registration may be removed early through `dispose`:

```ts
const registration = await ctx.catalog.transform(applyCatalog)
await registration.dispose()
```

## Transform Hooks

Transform hooks contribute to stateful domains. The draft editor is synchronous; the callback may be `async` when it needs to await other work:

```ts
await ctx.agent.transform((agent) => {
  agent.update("reviewer", (item) => {
    item.description = "Reviews code for regressions"
    item.mode = "subagent"
  })
})
```

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
let data = await loadCatalog()

await ctx.catalog.transform((catalog) => {
  applyCatalog(data, catalog)
})

data = await loadCatalog()
await ctx.catalog.reload()
```

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
const registration = await ctx.event.subscribe("catalog.updated", async (event) => {
  console.log("the catalog changed", event.id)
})

// later, if you want it gone before the plugin unloads
await registration.dispose()
```

The handler is **awaited**, so it must return a promise — write `async (event) => {}` even when
the body is synchronous.

**The host owns the fork, the isolation and the buffering; you own the callback.** That is
deliberate, and it is why this is a callback rather than a stream you drive yourself:

- A handler that rejects or throws is logged and the subscription **survives** — the next event
  is still delivered.
- One plugin's bad handler never starves another plugin's subscription.
- Delivery is buffered per subscription and **drops** — with a warning naming the type and the
  capacity — once a handler falls far enough behind. A slow plugin cannot grow the instance's
  memory without bound.

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
