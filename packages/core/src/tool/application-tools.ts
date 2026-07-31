export * as ApplicationTools from "./application-tools"

import { Context, Effect, Layer, Scope } from "effect"
import { State } from "../state"
import { Tool } from "./tool"
import { makeGlobalNode } from "../effect/app-node"

type Data = {
  readonly entries: Map<string, Entry>
}

type Draft = {
  readonly set: (name: string, entry: Entry) => void
}

export interface Entry {
  readonly identity: object
  readonly tool: Tool.AnyTool
}

export interface Interface {
  readonly register: (
    tools: Readonly<Record<string, Tool.AnyTool>>,
  ) => Effect.Effect<void, Tool.RegistrationError, Scope.Scope>
  readonly entries: () => ReadonlyMap<string, Entry>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/ApplicationTools") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = State.create<Data, Draft>({
      initial: () => ({ entries: new Map() }),
      draft: (draft) => ({
        set: (name, tool) => {
          draft.entries.set(name, tool)
        },
      }),
    })

    return Service.of({
      register: Effect.fn("ApplicationTools.register")(function* (tools) {
        const entries = Object.entries(tools)
        if (entries.length === 0) return
        // `validateRegistration`, not `validateName` — this is the SECOND seam holding a registration
        // key and its tool together (`ToolRegistry.register` is the first), and ruling 6's lesson is
        // that a duplicated decision drifts. It has no shipping caller today, which is exactly why it
        // would have drifted unnoticed: a self-declared permission is a guard-shaped no-op, and this
        // seam would have kept accepting one after the registry stopped.
        yield* Effect.forEach(entries, ([name, tool]) => Tool.validateRegistration(name, tool), { discard: true })
        const registrations = entries.map(([name, tool]) => [name, { identity: {}, tool }] as const)
        yield* state.transform((draft) => {
          for (const [name, entry] of registrations) draft.set(name, entry)
        })
      }),
      entries: () => state.get().entries,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
