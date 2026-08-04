import { Brand, Context, Layer } from "effect"

type AnyNode = Node<unknown, unknown, any>
type RuntimeLayer = Layer.Layer<never, unknown, unknown>
type NodeList<Item extends AnyNode = AnyNode> = readonly [] | readonly [Item, ...Item[]]
export type Output<Item> = [Item] extends [never] ? never : Item extends Node<infer A, unknown, any> ? A : never
export type Error<Item> = [Item] extends [never] ? never : Item extends Node<unknown, infer E, any> ? E : never
type NodeTag<Item> = [Item] extends [never] ? undefined : Item extends Node<unknown, unknown, infer T> ? T : never
type Missing<Required, Dependencies extends NodeList> = Exclude<Required, Output<Dependencies[number]>>
type CheckDependencies<Implementation extends Layer.Any, Dependencies extends NodeList> = [
  Missing<Layer.Services<Implementation>, Dependencies>,
] extends [never]
  ? unknown
  : { readonly "Missing dependencies": Missing<Layer.Services<Implementation>, Dependencies> }
declare const $OutputType: unique symbol
declare const $ErrorType: unique symbol

export type Tag<Name extends string = string> = Name & Brand.Brand<"LayerNode.Tag">

const makeTag = Brand.nominal<Tag>()

export interface Node<A, E = never, T extends Tag | undefined = undefined> {
  readonly kind: "layer" | "unbound" | "group"
  readonly name: string
  readonly service?: Context.Service.Any
  readonly implementation?: Layer.Any
  readonly dependencies: readonly AnyNode[]
  readonly tag?: T
  readonly [$OutputType]?: () => A
  readonly [$ErrorType]?: () => E
}

type NodeIdentity =
  | { readonly service: Context.Service.Any; readonly name?: never }
  | { readonly name: string; readonly service?: never }
type DistributiveOmit<A, K extends PropertyKey> = A extends unknown ? Omit<A, K> : never

export type TagConfig = Readonly<Record<string, readonly string[]>>
type TagNames<Config extends TagConfig> = keyof Config & string
type NodeInTags<Names extends string> = Node<unknown, unknown, Tag<Names> | undefined>
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
  ) => Node<Layer.Success<Implementation>, Layer.Error<Implementation> | Error<Items[number]>, Tag<Name>>
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
): Node<Layer.Success<Implementation>, Layer.Error<Implementation> | Error<Items[number]>, T> {
  return {
    kind: "layer",
    name: input.service !== undefined ? input.service.key : input.name,
    service: input.service,
    implementation: input.layer,
    dependencies: input.deps,
    tag: input.tag,
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
): Node<Output<Items[number]>, Error<Items[number]>, NodeTag<Items[number]>> {
  return { kind: "group", name: "group", dependencies }
}

export type Replacement = readonly [source: AnyNode, replacement: AnyNode | Layer.Any]
export type Replacements = readonly Replacement[]

type CheckReplacementErrors<SourceError, ReplacementError> = [Exclude<ReplacementError, SourceError>] extends [never]
  ? unknown
  : { readonly "New replacement errors": Exclude<ReplacementError, SourceError> }

type CheckReplacement<Item> = Item extends readonly [Node<infer A, infer E, infer T>, infer Replacement]
  ? Replacement extends Node<NoInfer<A>, infer E2, T>
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
export function hoist<A, E, T extends Tag, const Items extends Replacements = readonly []>(
  root: Node<A, E, any>,
  tag: T,
  replacements?: ValidReplacements<Items>,
): {
  readonly node: Node<A, E>
  readonly hoisted: Node<unknown, E>
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
    node: node as Node<A, E>,
    hoisted: group(hoistedNodes) as Node<unknown, E>,
  }
}

export function compile<A, E, const Items extends Replacements = readonly []>(
  root: Node<A, E, any>,
  replacements?: ValidReplacements<Items>,
): Layer.Layer<A, E> {
  const replacementMap = replacementMapFrom(replacements)
  // Per-invocation, so two `compile` calls over the same nodes produce different WRAPPER objects.
  // That is not the same as two instances: a node with `deps: []` is returned as its module-level
  // layer object unchanged (below), and Effect memoizes by the inner reference, not by the
  // `Layer.provide` wrapper (AGENTS.md → Known pitfalls, item −1). Sharing across `compile` calls is
  // therefore a property of the MEMO MAP the results are built with, never of this cache — see the
  // measurement in `location-services.ts`.
  const cache = new Map<AnyNode, RuntimeLayer>()
  const compileNode = (node: AnyNode) =>
    walk<RuntimeLayer>(
      node,
      (node, context) => {
        if (node.kind === "unbound") throw new Error(`Unbound layer node: ${node.name}`)
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
  return layer as Layer.Layer<A, E>
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

export function hasUnbound(root: Node<unknown, unknown, any>, source: AnyNode): boolean {
  if (source.kind !== "unbound") throw new Error(`Cannot check non-unbound layer node: ${source.name}`)
  return walk<boolean>(root, (node, context) => {
    if (node === source) return true
    return node.dependencies.some(context.visit)
  })
}

function flatten(node: AnyNode): readonly AnyNode[] {
  return node.kind === "group" ? node.dependencies.flatMap(flatten) : [node]
}

export * as LayerNode from "./layer-node"
