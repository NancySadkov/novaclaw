import { Brand, Context, Effect, Layer } from "effect"
import { Capability } from "./capability"

type AnyNode = Node<unknown, unknown, any, any>
type RuntimeLayer = Layer.Layer<never, unknown, unknown>
type NodeList<Item extends AnyNode = AnyNode> = readonly [] | readonly [Item, ...Item[]]
export type Output<Item> = [Item] extends [never] ? never : Item extends Node<infer A, unknown, any, any> ? A : never
export type Error<Item> = [Item] extends [never] ? never : Item extends Node<unknown, infer E, any, any> ? E : never
export type Requirements<Item> = [Item] extends [never]
  ? never
  : Item extends Node<unknown, unknown, any, infer R>
    ? R
    : never
type NodeTag<Item> = [Item] extends [never]
  ? undefined
  : Item extends Node<unknown, unknown, infer T, any>
    ? T
    : never
type Missing<Required, Dependencies extends NodeList> = Exclude<Required, Output<Dependencies[number]>>
type CheckDependencies<Implementation extends Layer.Any, Dependencies extends NodeList> = [
  Missing<Layer.Services<Implementation>, Dependencies>,
] extends [never]
  ? unknown
  : { readonly "Missing dependencies": Missing<Layer.Services<Implementation>, Dependencies> }
declare const $OutputType: unique symbol
declare const $ErrorType: unique symbol
declare const $RequirementsType: unique symbol

export type Tag<Name extends string = string> = Name & Brand.Brand<"LayerNode.Tag">

const makeTag = Brand.nominal<Tag>()

export interface Node<A, E = never, T extends Tag | undefined = undefined, R = never> {
  readonly kind: "layer" | "unbound" | "group" | "capability"
  readonly name: string
  readonly service?: Context.Service.Any
  readonly implementation?: Layer.Any
  readonly dependencies: readonly AnyNode[]
  readonly tag?: T
  readonly [$OutputType]?: () => A
  readonly [$ErrorType]?: () => E
  readonly [$RequirementsType]?: () => R
}

export interface CapabilityNode<A, E = never, T extends Tag | undefined = undefined, R = never>
  extends Node<Capability.Capability<A>, never, T, R> {
  readonly kind: "capability"
  readonly inner: Node<unknown, E, T, R>
  readonly innerService: Context.Service.Any
  readonly service: Context.Service<Capability.Capability<A>, Capability.Capability<A>>
  readonly capabilityName: string
  readonly timeout: import("effect").Duration.Input
  readonly repair?: readonly string[]
}

type NodeIdentity =
  | { readonly service: Context.Service.Any; readonly name?: never }
  | { readonly name: string; readonly service?: never }
type DistributiveOmit<A, K extends PropertyKey> = A extends unknown ? Omit<A, K> : never

export type TagConfig = Readonly<Record<string, readonly string[]>>
type TagNames<Config extends TagConfig> = keyof Config & string
type NodeInTags<Names extends string> = Node<unknown, unknown, Tag<Names> | undefined, any>
type CheckTags<Items extends NodeList, Names extends string> = [Exclude<Items[number], NodeInTags<Names>>] extends [
  never,
]
  ? unknown
  : { readonly "Invalid tag dependencies": Exclude<Items[number], NodeInTags<Names>> }

export interface Tags<Config extends TagConfig> {
  readonly values: { readonly [Name in TagNames<Config>]: Tag<Name> }
  readonly make: <Name extends TagNames<Config>>(
    name: Name,
  ) => <const Implementation extends Layer.Any, const Items extends NodeList>(
    input: DistributiveOmit<MakeInput<Implementation, Items, Tag<Name>>, "tag"> &
      CheckTags<Items, Name | Extract<Config[Name][number], string>>,
  ) => Node<
    Layer.Success<Implementation>,
    Layer.Error<Implementation> | Error<Items[number]>,
    Tag<Name>,
    Requirements<Items[number]>
  >
}

export function tags<const Config extends { readonly [Name in keyof Config]: readonly (keyof Config & string)[] }>(
  config: Config,
): Tags<Config> {
  const names = Object.keys(config) as TagNames<Config>[]
  const values = Object.fromEntries(names.map((name) => [name, makeTag(name)])) as Tags<Config>["values"]
  return {
    values,
    make: ((name: TagNames<Config>) => (input: DistributiveOmit<MakeInput<Layer.Any, NodeList, Tag>, "tag">) =>
      make({ ...input, tag: values[name] })) as Tags<Config>["make"],
  }
}

// Nodes ---------------------------------------------------------------------

type MakeInput<
  Implementation extends Layer.Any,
  Items extends NodeList,
  T extends Tag | undefined = undefined,
> = NodeIdentity & {
  readonly layer: Implementation
  readonly deps: Items & CheckDependencies<Implementation, NoInfer<Items>>
  readonly tag?: T
}

export function make<
  const Implementation extends Layer.Any,
  const Items extends NodeList,
  const T extends Tag | undefined = undefined,
>(
  input: MakeInput<Implementation, Items, T>,
): Node<
  Layer.Success<Implementation>,
  Layer.Error<Implementation> | Error<Items[number]>,
  T,
  Requirements<Items[number]>
> {
  return {
    kind: "layer",
    name: input.service !== undefined ? input.service.key : input.name,
    service: input.service,
    implementation: input.layer,
    dependencies: input.deps,
    tag: input.tag,
  }
}

/** Declare a service that must be supplied by the layer which compiles this graph. */
export function external<S extends Context.Service.Any, const T extends Tag | undefined = undefined>(
  service: S,
  tag?: T,
): Node<Context.Service.Identifier<S>, never, T, Context.Service.Identifier<S>> {
  return {
    kind: "layer",
    name: service.key,
    service,
    implementation: Layer.effect(service, Effect.service(service)),
    dependencies: [],
    tag,
  }
}

export function unbound<R, Shape, const T extends Tag>(service: Context.Key<R, Shape>, tag: T): Node<R, never, T> {
  return {
    kind: "unbound",
    name: service.key,
    service,
    dependencies: [],
    tag,
  }
}

export function group<const Items extends readonly AnyNode[]>(
  dependencies: Items,
): Node<Output<Items[number]>, Error<Items[number]>, NodeTag<Items[number]>, Requirements<Items[number]>> {
  return { kind: "group", name: "group", dependencies }
}

/** Wrap one service node in a first-use, failure-as-data capability. */
export function capability<S extends Context.Service.Any, E, T extends Tag | undefined, R>(
  inner: Node<Context.Service.Identifier<S>, E, T, R>,
  options: {
    readonly name: string
    readonly service: S
    readonly timeout?: import("effect").Duration.Input
    readonly repair?: readonly string[]
  },
): CapabilityNode<Context.Service.Shape<S>, E, T, R> {
  if (inner.kind !== "layer" || inner.service === undefined || inner.implementation === undefined) {
    throw new Error(`Capability ${options.name} must wrap one service layer`)
  }
  if (inner.service.key !== options.service.key) {
    throw new Error(`Capability ${options.name} service does not match ${inner.name}`)
  }
  const service = Context.Service<Capability.Capability<Context.Service.Shape<S>>>(
    `@novaclaw/capability/${options.name}`,
  )
  return {
    kind: "capability",
    name: service.key,
    service,
    implementation: capabilityLayer({
      capabilityName: options.name,
      capabilityService: service,
      innerService: options.service,
      innerLayer: inner.implementation,
      timeout: options.timeout ?? "30 seconds",
      repair: options.repair,
    }),
    dependencies: [inner],
    inner,
    innerService: options.service,
    capabilityName: options.name,
    tag: inner.tag,
    timeout: options.timeout ?? "30 seconds",
    ...(options.repair === undefined ? {} : { repair: options.repair }),
  }
}

const capabilityLayer = (input: {
  readonly capabilityName: string
  readonly capabilityService: Context.Service.Any
  readonly innerService: Context.Service.Any
  readonly innerLayer: Layer.Any
  readonly timeout: import("effect").Duration.Input
  readonly repair?: readonly string[]
}): Layer.Any =>
  Layer.effect(
    input.capabilityService,
    Effect.gen(function* () {
      const environment = yield* Effect.context<unknown>()
      const parentScope = yield* Effect.scope
      return yield* Capability.make({
        name: input.capabilityName,
        service: input.innerService,
        layer: input.innerLayer as Layer.Layer<unknown, unknown, unknown>,
        environment,
        parentScope,
        timeout: input.timeout,
        ...(input.repair === undefined ? {} : { repair: input.repair }),
      })
    }),
  )

export type Replacement = readonly [source: AnyNode, replacement: AnyNode | Layer.Any]
export type Replacements = readonly Replacement[]

type CheckReplacementErrors<SourceError, ReplacementError> = [Exclude<ReplacementError, SourceError>] extends [never]
  ? unknown
  : { readonly "New replacement errors": Exclude<ReplacementError, SourceError> }

type CheckReplacement<Item> = Item extends readonly [Node<infer A, infer E, infer T, any>, infer Replacement]
  ? Replacement extends Node<NoInfer<A>, infer E2, T, any>
    ? CheckReplacementErrors<E, NoInfer<E2>>
    : Replacement extends Layer.Layer<NoInfer<A>, infer E2, never>
      ? CheckReplacementErrors<E, NoInfer<E2>>
      : { readonly "Invalid replacement": Replacement }
  : { readonly "Invalid replacement": Item }

type CheckReplacements<Items extends Replacements> = {
  readonly [K in keyof Items]: CheckReplacement<Items[K]>
}

type ValidReplacements<Items extends Replacements> = Items & CheckReplacements<Items>

function replacementNode(source: AnyNode, replacement: AnyNode | Layer.Any) {
  const replacementNode = isNode(replacement)
    ? replacement
    : make({
        ...nodeMakeIdentity(source),
        layer: replacement as Layer.Layer<unknown, unknown>,
        deps: [],
        tag: source.tag,
      })
  if (source.name !== replacementNode.name) {
    throw new Error(`Cannot replace ${source.name} with ${replacementNode.name}`)
  }
  if (source.tag !== replacementNode.tag) {
    throw new Error(`Cannot replace ${source.name} across tags`)
  }
  return replacementNode
}

function nodeMakeIdentity(node: AnyNode): NodeIdentity {
  if (node.service !== undefined) return { service: node.service }
  return { name: node.name }
}

function isNode(input: Layer.Any | AnyNode): input is AnyNode {
  return "kind" in input && "dependencies" in input
}

// Tree -----------------------------------------------------------------------

type Visit<Result> = (node: AnyNode, context: VisitContext<Result>) => Result

type VisitContext<Result> = {
  readonly cache: Map<AnyNode, Result>
  readonly visit: (node: AnyNode) => Result
}

function walk<Result>(
  root: AnyNode,
  visit: Visit<Result>,
  options: {
    readonly cache?: Map<AnyNode, Result>
    readonly resolve?: (node: AnyNode) => AnyNode
    readonly detectCycles?: boolean
  } = {},
) {
  const cache = options.cache ?? new Map<AnyNode, Result>()
  const visiting = new Set<AnyNode>()
  const stack: AnyNode[] = []

  const recur = (node: AnyNode): Result => {
    const target = options.resolve?.(node) ?? node
    const cached = cache.get(target)
    if (cached !== undefined || cache.has(target)) return cached!

    if (options.detectCycles !== false && visiting.has(target)) {
      const start = stack.indexOf(target)
      throw new Error(
        `Cycle detected in layer tree: ${[...stack.slice(start), target].map((item) => item.name).join(" -> ")}`,
      )
    }

    visiting.add(target)
    stack.push(target)
    try {
      const result = visit(target, { cache, visit: recur })
      if (!cache.has(target)) cache.set(target, result)
      return result
    } finally {
      stack.pop()
      visiting.delete(target)
    }
  }

  return recur(root)
}

// Splits `root` into the part that stays per-caller (`node`) and the `tag`-marked part that is meant
// to be shared (`hoisted`).
//
// BOTH halves come back with `replacements` applied throughout, so the result is self-contained:
// `compile(result.node)` and `compile(result.hoisted)` need no further arguments. That is the whole
// contract, and it is load-bearing — a replacement honoured in one half and not the other means the
// replaced service exists TWICE in one process (a test's mock `Database` plus a real second SQLite
// connection, say), which is a graph silently disagreeing with itself.
//
// ⚠️ The two halves need two different mechanisms, which is what made this easy to get wrong.
//   · The per-caller half is rewritten by `walk` above, which resolves through `replacementMap`.
//   · A hoisted node is NOT visited by that walk — it is lifted out whole and only its own identity
//     is resolved — so its dependency array has to be rewritten separately, by
//     `rewriteReplacementDependencies` below. Until 2026-07-29 that step did not exist and the
//     dependency arrays were kept verbatim: measured on the real location graph, replacing
//     `Database` left 16 of the 35 hoisted globals (every config store, `Event`, `Credential`,
//     `SessionStore`, `bash-jobs-recovery`, `WebSearch`, …) pointing at the original node.
// ⚠️ What must NOT be done is rewriting the hoisted deps with `context.visit`: that collapses a
// hoisted node's own hoisted deps to `group([])`, leaving `compile`'s non-topological `provideMerge`
// fold to supply them — which it can only do for nodes that happen to come earlier in the fold.
// `rewriteReplacementDependencies` substitutes replacements and changes nothing else.
// Pinned by `test/effect/layer-node/layer-node.test.ts` and, on the real graph,
// `test/location-services-hoist-replacements.test.ts`.
export function hoist<A, E, T extends Tag, R, const Items extends Replacements = readonly []>(
  root: Node<A, E, any, R>,
  tag: T,
  replacements?: ValidReplacements<Items>,
): {
  readonly node: Node<A, E, undefined, R>
  readonly hoisted: Node<unknown, E, undefined, R>
} {
  const hoisted = new Map<string, AnyNode>()
  const replacementMap = replacementMapFrom(replacements)

  const node = walk<AnyNode>(
    root,
    (node, context) => {
      if (node.kind === "group") {
        return { ...node, dependencies: node.dependencies.map(context.visit) }
      }
      if (node.tag === tag) {
        const existing = hoisted.get(node.name)
        if (existing && existing !== node) {
          throw new Error(`Tag ${tag} has conflicting implementations for ${node.name}`)
        }
        hoisted.set(node.name, node)
        return group([])
      }
      if (node.kind === "unbound") {
        return node
      }
      return { ...node, dependencies: node.dependencies.map(context.visit) }
    },
    { resolve: (node) => replacementMap.get(node.name) ?? node },
  )

  // One cache across all hoisted roots, so a subtree shared by two of them is rewritten into ONE
  // node object rather than two structurally-equal clones (`compile` keys its own cache by object).
  const rewriteCache = new Map<AnyNode, AnyNode>()
  const hoistedNodes = Array.from(hoisted.values(), (item) =>
    rewriteReplacementDependencies(item, replacementMap, rewriteCache),
  )

  return {
    // Conservatively retain external requirements on both independently compilable halves. A
    // replacement may close one half at runtime, but erasing the requirement here would let a caller
    // compile the other half without supplying the shared service.
    node: node as Node<A, E, undefined, R>,
    hoisted: group(hoistedNodes) as Node<unknown, E, undefined, R>,
  }
}

export function compile<A, E, R, const Items extends Replacements = readonly []>(
  root: Node<A, E, any, R>,
  replacements?: ValidReplacements<Items>,
): Layer.Layer<A, E, R> {
  const replacementMap = replacementMapFrom(replacements)
  // Per-invocation, so two `compile` calls over the same nodes produce different WRAPPER objects.
  // That is not the same as two instances: a node with `deps: []` is returned as its module-level
  // layer object unchanged (below), and Effect memoizes by the inner reference, not by the
  // `Layer.provide` wrapper (AGENTS.md → Known pitfalls, item −1). Sharing across `compile` calls is
  // therefore a property of the MEMO MAP the results are built with, never of this cache — see the
  // measurement in `location-services.ts`.
  const cache = new Map<AnyNode, RuntimeLayer>()
  // A bound capability registry can reach the same declaration through a replacement-rewritten
  // clone while another root reaches the original node. Key the wrapper by BOTH service and resolved
  // inner node so those two paths share one latch, without collapsing genuinely different branch
  // implementations of the same service.
  const capabilityCache = new Map<string, Map<AnyNode, RuntimeLayer>>()
  const compileNode = (node: AnyNode) =>
    walk<RuntimeLayer>(
      node,
      (node, context) => {
        if (node.kind === "unbound") throw new Error(`Unbound layer node: ${node.name}`)
        if (node.kind === "capability") {
          const capabilityNode = node as CapabilityNode<unknown, unknown, Tag | undefined>
          const rawInner = capabilityNode.dependencies[0]!
          const inner = replacementMap.get(rawInner.name) ?? rawInner
          if (inner.kind !== "layer" || inner.service === undefined) {
            throw new Error(`Capability ${capabilityNode.name} must resolve to one service layer`)
          }
          const cachedCapability = capabilityCache.get(capabilityNode.service.key)?.get(inner)
          if (cachedCapability !== undefined) return cachedCapability
          const dependencies = inner.dependencies.flatMap(flatten).map(context.visit)
          const implementation = inner.implementation! as RuntimeLayer
          // Preserve the module-level wrapper object on the ordinary path: the shared MemoMap keys on
          // layer identity, so recreating this wrapper per location would create one capability latch
          // per location. A rewritten dependency (replacement or boot instrumentation) deliberately
          // gets a new wrapper around that rewritten inner layer.
          const wrapper = (
            inner === rawInner && rawInner === capabilityNode.inner
              ? capabilityNode.implementation!
              : capabilityLayer({
                  capabilityName: capabilityNode.capabilityName,
                  capabilityService: capabilityNode.service,
                  innerService: capabilityNode.innerService,
                  innerLayer: implementation,
                  timeout: capabilityNode.timeout,
                  repair: capabilityNode.repair,
                })
          ) as RuntimeLayer
          const compiled =
            dependencies.length === 0
              ? wrapper
              : wrapper.pipe(Layer.provide(dependencies as [RuntimeLayer, ...RuntimeLayer[]]))
          const byInner = capabilityCache.get(capabilityNode.service.key) ?? new Map<AnyNode, RuntimeLayer>()
          byInner.set(inner, compiled)
          capabilityCache.set(capabilityNode.service.key, byInner)
          return compiled
        }
        const dependencies = node.dependencies.flatMap(flatten).map(context.visit)
        const implementation = node.implementation! as RuntimeLayer
        return dependencies.length === 0
          ? implementation
          : implementation.pipe(Layer.provide(dependencies as [RuntimeLayer, ...RuntimeLayer[]]))
      },
      { cache, resolve: (node) => replacementMap.get(node.name) ?? node },
    )
  const layers = flatten(root).map((node) => compileNode(node))
  const layer = layers.reduce<RuntimeLayer>((result, layer) => layer.pipe(Layer.provideMerge(result)), Layer.empty)
  return layer as Layer.Layer<A, E, R>
}

function replacementMapFrom(replacements?: Replacements) {
  return (
    replacements?.reduce((map, [source, replacement]) => {
      const normalized = rewriteReplacementDependencies(replacementNode(source, replacement), map)
      const current = new Map([[source.name, normalized]])
      for (const [name, node] of map) map.set(name, rewriteReplacementDependencies(node, current))
      map.set(source.name, normalized)
      return map
    }, new Map<string, AnyNode>()) ?? new Map<string, AnyNode>()
  )
}

// Substitutes `replacements` throughout `root`'s dependency subtree, by NAME, leaving the root's own
// identity alone (callers resolve that themselves) and changing nothing else about the shape. A node
// whose subtree is unaffected is returned as the SAME object, so this is free for the common case.
// `cache` may be shared across sibling roots to keep a shared subtree a single object.
function rewriteReplacementDependencies(
  root: AnyNode,
  replacements: ReadonlyMap<string, AnyNode>,
  cache: Map<AnyNode, AnyNode> = new Map<AnyNode, AnyNode>(),
) {
  if (replacements.size === 0) return root
  const visiting = new Set<AnyNode>()
  const stack: AnyNode[] = []

  const recur = (node: AnyNode, isRoot = false): AnyNode => {
    const target = isRoot ? node : (replacements.get(node.name) ?? node)
    const cached = cache.get(target)
    if (cached !== undefined || cache.has(target)) return cached!
    if (visiting.has(target)) {
      const start = stack.indexOf(target)
      throw new Error(
        `Cycle detected in layer tree: ${[...stack.slice(start), target].map((item) => item.name).join(" -> ")}`,
      )
    }

    visiting.add(target)
    stack.push(target)
    try {
      const dependencies = target.dependencies.map((dependency) => recur(dependency))
      const result = dependencies.every((dependency, index) => dependency === target.dependencies[index])
        ? target
        : { ...target, dependencies }
      cache.set(target, result)
      return result
    } finally {
      stack.pop()
      visiting.delete(target)
    }
  }

  return recur(root, true)
}

export function hasUnbound(root: Node<unknown, unknown, any, any>, source: AnyNode): boolean {
  if (source.kind !== "unbound") throw new Error(`Cannot check non-unbound layer node: ${source.name}`)
  return walk<boolean>(root, (node, context) => {
    if (node === source) return true
    return node.dependencies.some(context.visit)
  })
}

/** Capability declarations reachable in this graph, after replacements, without building them. */
export function capabilities(
  root: Node<unknown, unknown, any, any>,
  replacements?: Replacements,
): ReadonlyArray<CapabilityNode<unknown, unknown, any>> {
  const replacementMap = replacementMapFrom(replacements)
  const found = new Map<string, CapabilityNode<unknown, unknown, any>>()
  walk<void>(
    root,
    (node, context) => {
      if (node.kind === "capability") {
        const capability = node as CapabilityNode<unknown, unknown, any>
        const existing = found.get(capability.capabilityName)
        if (existing !== undefined && existing.service.key !== capability.service.key) {
          throw new Error(`Conflicting capability declaration: ${capability.capabilityName}`)
        }
        found.set(capability.capabilityName, capability)
      }
      for (const dependency of node.dependencies) context.visit(dependency)
    },
    { resolve: (node) => replacementMap.get(node.name) ?? node },
  )
  return [...found.values()].toSorted((a, b) => a.capabilityName.localeCompare(b.capabilityName))
}

function flatten(node: AnyNode): readonly AnyNode[] {
  return node.kind === "group" ? node.dependencies.flatMap(flatten) : [node]
}

export * as LayerNode from "./layer-node"
