export * as LazyBuiltin from "./lazy-builtin"

import { ToolDefinition, ToolFailure } from "@novaclaw/llm"
import { Cause, Context, Effect, Exit, Layer, Scope, Semaphore } from "effect"
import { Tool } from "./tool"
import { ToolRegistry } from "./registry"
import { Tools } from "./tools"

/** The generated registration declares the implementation's real dependencies. Their existing
 * services are captured here, so demand loading cannot create another database, permission
 * evaluator or session store. Only the tool layer is built, into a child of this location scope. */
export function layer<Module extends { readonly layer: Layer.Any }>(options: {
  readonly definition: ToolDefinition
  readonly sideEffect: Tool.SideEffectClass
  readonly load: () => Promise<Module>
  readonly available?: Effect.Effect<boolean, never, Layer.Services<Module["layer"]>>
}): Layer.Layer<never, never, Tools.Service | Layer.Services<Module["layer"]>> {
  return Layer.effectDiscard(
    Effect.gen(function* () {
      const tools = yield* Tools.Service
      const environment = yield* Effect.context<Layer.Services<Module["layer"]>>()
      const parent = yield* Scope.Scope
      const lock = yield* Semaphore.make(1)
      let loaded: Tool.AnyTool | undefined
      let failures = 0
      let lastFailure: ToolFailure | undefined
      const load = Effect.suspend(() => {
        const requestedAfter = failures
        return lock.withPermit(
          Effect.gen(function* () {
            if (loaded) return loaded
            // Calls already waiting on a failed attempt share that failure. Only a later call retries;
            // otherwise a burst of callers repeats the same failed import once per waiting model call.
            if (requestedAfter !== failures && lastFailure) return yield* Effect.fail(lastFailure)
            const child = yield* Scope.fork(parent)
            const construct = Effect.gen(function* () {
              const module = yield* Effect.tryPromise(options.load)
              let captured: Tool.AnyTool | undefined
              const capture = Tools.Service.of({
                register: (registrations) =>
                  Effect.gen(function* () {
                    const entries = Object.entries(registrations)
                    if (entries.length !== 1 || entries[0]![0] !== options.definition.name)
                      return yield* Effect.die(new Error("Lazy built-in registered an unexpected name"))
                    const [name, tool] = entries[0]!
                    yield* Tool.validateRegistration(name, tool)
                    if (
                      JSON.stringify(Tool.definition(name, tool)) !== JSON.stringify(options.definition) ||
                      Tool.sideEffect(tool) !== options.sideEffect ||
                      Tool.permission(tool, name) !== name
                    )
                      return yield* Effect.die(
                        new Error("Lazy built-in metadata is stale; regenerate the built-in manifest"),
                      )
                    captured = tool
                  }),
              })
              // This cast only erases the module's heterogeneous service union at the Layer API boundary;
              // the generated makeLocationNode call checks that union against its declared dependencies.
              yield* Layer.buildWithScope(
                Layer.fresh(
                  module.layer as Layer.Layer<unknown, unknown, Layer.Services<Module["layer"]> | Tools.Service>,
                ),
                child,
              ).pipe(Effect.provide(Context.add(environment, Tools.Service, capture)))
              if (!captured) return yield* Effect.die(new Error("Lazy built-in did not register its implementation"))
              return captured
            })
            const result = yield* Effect.exit(construct.pipe(Effect.timeout("10 seconds")))
            if (Exit.isFailure(result)) {
              yield* Scope.close(child, result).pipe(Effect.ignore)
              lastFailure = new ToolFailure({
                message: `${options.definition.name} is unavailable: ${Cause.pretty(result.cause).split(/\r?\n/, 1)[0]}. You can retry this tool.`,
              })
              failures++
              return yield* Effect.fail(lastFailure)
            }
            loaded = result.value
            return loaded
          }),
        )
      })
      let tool = Tool.lazy({ ...options, load })
      if (options.available)
        tool = ToolRegistry.withAvailability(tool, options.available.pipe(Effect.provide(environment)))
      yield* tools.register({ [options.definition.name]: tool }).pipe(Effect.orDie)
    }),
  )
}
