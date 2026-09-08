export * as LocationMutation from "./location-mutation"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { FSUtil } from "./fs-util"
import { Location } from "./location"
import { ProjectExclusion } from "./project-exclusion"
import { ProjectFileCache } from "./project-file-cache"
import { ProjectFileResolve } from "./project-file"

export const Kind = Schema.Literals(["file", "directory"])
export type Kind = typeof Kind.Type

/**
 * Mutation paths do not accept project references. Relative paths must stay
 * inside the active Location. Absolute paths outside it require separate
 * `external_directory` approval.
 */
export const ResolveInput = Schema.Struct({
  path: Schema.String,
  /** Selects the external approval boundary; it does not validate the target type. */
  kind: Kind.pipe(Schema.optional),
  /**
   * Whether this operation will put the file's CONTENT in front of the model.
   *
   * 🔴 Defaults to `true`, and the default is the security property. `resolve` is the one place
   * every path-taking agentic tool funnels caller input through, so it is where `novaclaw.json`'s
   * `exclude` list is enforced (`project-exclusion.ts` carries the full reasoning and the pattern
   * semantics). A tool added later that never thinks about exclusions gets the REFUSAL rather than
   * the bypass — the inheritance the roadmap item asks for, in the fail-closed direction.
   *
   * Pass `false` only for an operation that writes without reading — `write`, `write_hex`, `trash`,
   * a bash redirect target, a working-directory classification. `edit` and `apply_patch` read
   * before they write and must take the default. The list is *"Never read"*, not *"never touch"*:
   * The exclusion list is scoped to **model read eligibility**, and refusing writes as well would
   * be a second, unrequested promise that also breaks generating a file the user excluded on purpose.
   */
  readsContent: Schema.optional(Schema.Boolean),
})
export type ResolveInput = typeof ResolveInput.Type

export class PathError extends Schema.TaggedErrorClass<PathError>()("LocationMutation.PathError", {
  path: Schema.String,
  reason: Schema.Literals(["relative_escape", "location_escape", "non_directory_ancestor"]),
}) {}

export interface ExternalDirectoryAuthorization {
  /** Canonical existing directory used as the external approval boundary. */
  readonly directory: string
  /** Concrete target shown to the user and saved by a file-scoped verdict. */
  readonly resource: string
  /** Directory-wide resource saved only by an always-scoped verdict. */
  readonly save: string
}

/**
 * External access is CLASSED (1I): reading outside the Location and mutating outside it are
 * separate permission actions, so an "allow always" saved for READING an external directory
 * (e.g. a toolchain like w64devkit) never silently authorizes writes there. read/glob-class
 * tools pass "read"; every mutating tool (edit/write/bash/apply-patch/trash) passes "write".
 */
export const externalDirectoryPermission = (input: ExternalDirectoryAuthorization, access: "read" | "write") => ({
  action: access === "read" ? "external_directory_read" : "external_directory_write",
  resources: [input.resource],
  save: [input.save],
  metadata: { targets: [input.resource] },
})

export const externalDirectoryPermissions = (
  inputs: readonly ExternalDirectoryAuthorization[],
  access: "read" | "write",
) => ({
  action: access === "read" ? "external_directory_read" : "external_directory_write",
  resources: [...new Set(inputs.map((input) => input.resource))],
  save: [...new Set(inputs.map((input) => input.save))],
  metadata: { targets: [...new Set(inputs.map((input) => input.resource))] },
})

export interface Target {
  /** Canonical existing path, or missing path below a canonical directory. */
  readonly canonical: string
  /** Permission resource: Location-relative for internal paths, canonical for external paths. */
  readonly resource: string
  readonly externalDirectory?: ExternalDirectoryAuthorization
}

export interface Interface {
  /**
   * Resolve a path and derive its permission resources. Relative paths must
   * stay inside the Location. Absolute paths outside it require separate
   * `external_directory` approval. This does not approve the mutation.
   */
  readonly resolve: (
    input: ResolveInput,
  ) => Effect.Effect<Target, PathError | FSUtil.Error | ProjectExclusion.ExcludedError | ProjectFileCache.FaultError>
  /**
   * The `novaclaw.json` exclusion list governing a canonical directory, for the two tools that
   * ENUMERATE rather than name (`glob`, `grep`). `resolve` speaks for their search root; only they
   * can speak for their rows. Everyone else should be using `resolve` and nothing else.
   *
   * ⚠️ Takes the directory only. The containment boundary the lookup climbs to is THIS location's
   * folder, supplied here rather than accepted from the caller — a boundary a caller could pass is
   * a boundary a caller could widen.
   */
  readonly exclusionsFor: (
    directory: string,
  ) => Effect.Effect<ProjectExclusion.Declaration | undefined, ProjectFileCache.FaultError>
}

export class Service extends Context.Service<Service, Interface>()("@novaclaw/v2/LocationMutation") {}

interface ResolvedPath {
  readonly canonical: string
  readonly type?:
    | "File"
    | "Directory"
    | "SymbolicLink"
    | "BlockDevice"
    | "CharacterDevice"
    | "FIFO"
    | "Socket"
    | "Unknown"
  readonly directory: string
}

const slash = (value: string) => value.replaceAll("\\", "/")

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const location = yield* Location.Service
    // Captured at layer build and provided below, for the reason `project-file-cache.ts` states:
    // leaving the requirement to be discharged at call time pushes it into this service's R, which
    // must be `never`.
    const projects = yield* ProjectFileCache.Service
    const exclusionsFor = (directory: string, boundary: string) =>
      ProjectExclusion.declarationFor(directory, boundary).pipe(
        Effect.provideService(ProjectFileCache.Service, projects),
      )
    // Same boot tolerance as the FileSystem layer: a location whose directory was deleted
    // must still boot far enough to serve DB-only requests (e.g. deleting its sessions).
    const locationRoot = yield* fs
      .realPath(location.directory)
      .pipe(Effect.catch(() => Effect.succeed(location.directory)))

    function notFound<A>(effect: Effect.Effect<A, FSUtil.Error>) {
      return effect.pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(undefined)))
    }

    const resolvePath = Effect.fnUntraced(function* (absolute: string) {
      const existing = yield* notFound(fs.realPath(absolute))
      if (existing !== undefined) {
        const info = yield* fs.stat(existing)
        return {
          canonical: existing,
          type: info.type,
          directory: info.type === "Directory" ? existing : path.dirname(existing),
        } satisfies ResolvedPath
      }

      let anchor = path.dirname(absolute)
      while (true) {
        const canonical = yield* notFound(fs.realPath(anchor))
        if (canonical !== undefined) {
          const info = yield* fs.stat(canonical)
          if (info.type !== "Directory") {
            return yield* new PathError({ path: absolute, reason: "non_directory_ancestor" })
          }
          return {
            canonical: path.resolve(canonical, path.relative(anchor, absolute)),
            directory: canonical,
          } satisfies ResolvedPath
        }
        const parent = path.dirname(anchor)
        if (parent === anchor) return yield* new PathError({ path: absolute, reason: "non_directory_ancestor" })
        anchor = parent
      }
    })

    const resolve = Effect.fn("LocationMutation.resolve")(function* (input: ResolveInput) {
      const relative = !path.isAbsolute(input.path)
      const absolute = path.resolve(location.directory, input.path)
      const lexicallyInternal = FSUtil.contains(location.directory, absolute)
      if (relative && !lexicallyInternal) return yield* new PathError({ path: input.path, reason: "relative_escape" })

      const resolved = yield* resolvePath(absolute)
      if (lexicallyInternal && !FSUtil.contains(locationRoot, resolved.canonical)) {
        return yield* new PathError({ path: input.path, reason: "location_escape" })
      }

      // ── The project exclusion gate ──────────────────────────────────────────────────────────
      //
      // 🔴 HERE, and deliberately after `resolvePath`. Everything above has already turned whatever
      // the model typed into ONE canonical string: `path.resolve` collapsed `..` and normalised
      // separators, `realPath` followed symlinks and (on Windows) folded the path to its true
      // on-disk casing — measured: `…/SECRETS/key.txt` comes back as `…/Secrets/Key.TXT`. Screening
      // the canonical path is therefore screening the FILE, not a spelling of it, which is what
      // makes "prove exclusions cannot be bypassed through alternate tools or path aliases"
      // a property of this one call site rather than a checklist per tool. The alias vectors and
      // what each one measured are in `notes/reports/projects-program-2026-08-18.md`.
      //
      // The declaration is looked up from the TARGET's directory, so a nested project, an absolute
      // path into this project from outside it, and a path into a different project all get the
      // answer the file's own owner wrote. See `project-exclusion.ts`.
      //
      // ⚠️ …with ONE thing `realPath` does not do, folded in here: a **mapped / `subst` drive**.
      // Node's JS `realpath` keeps `Y:\key.txt` as `Y:\key.txt`; `realpath.native` collapses it to
      // the real volume path (both measured 2026-08-18). That difference was a live bypass, and the
      // reason it is a bypass is NOT matching — it is the WALK-UP. `exclusionsFor` climbs from the
      // target's directory looking for a `novaclaw.json`, so with `Y:` mapped at `<root>\secrets`
      // the climb from `Y:\` hits the root of a drive that holds no project file, answers
      // `undefined`, and there is nothing left to screen: `Y:\key.txt` returned the excluded file's
      // BYTES end to end. Mapped at the project root instead, the same climb finds
      // `Y:\novaclaw.json` without leaving the mapped volume and the exclusion bit normally — which
      // is exactly why the open half needed its own test rather than being assumed covered.
      //
      // 🔴 Both operands are folded, and both are load-bearing: the DIRECTORY so the declaration is
      // found at all, and the CANONICAL path so `screen` measures it relative to that declaration's
      // real root. Folding only the first finds the rules and then fails to match a `Y:\…` string
      // against a `C:\…` root.
      //
      // ⚠️ Deliberately NOT in `project-exclusion.ts`. Its `unalias` runs only AFTER a declaration
      // has been found — never reached in this vector — and its `~\d` gate exists precisely so
      // `screenAll` does not pay a sync `realpath.native` per row of a thousand-match grep. This
      // costs one such call per RESOLVE, on the read path only (a `readsContent: false` write pays
      // nothing), and none at all off win32, where `normalizePath` is the identity. The screened
      // strings stay LOCAL to this block: `canonical` and `resource` below are the permission
      // resources that stored user verdicts are keyed on, and re-spelling those to fix a matching
      // bug would invalidate them.
      if (input.readsContent !== false) {
        const screenDirectory = FSUtil.normalizePath(resolved.directory)
        const screenCanonical = path.resolve(screenDirectory, path.relative(resolved.directory, resolved.canonical))
        // ⚠️ The boundary is folded by the SAME rule as the two operands above, and for the same
        // reason. `locationRoot` is already a realpath, but a `subst` drive is not resolved by
        // `realpath` — so an unfolded boundary would fail `FSUtil.contains` against a folded
        // `screenDirectory` and `walk` would silently fall back to the queried folder, which is
        // exactly the collapse this call is fixing. A boundary that does not fold is a boundary
        // that quietly is not one.
        const screenBoundary = FSUtil.normalizePath(ProjectFileResolve.trustedBoundary(location))
        const declaration = yield* exclusionsFor(screenDirectory, screenBoundary)
        if (declaration) {
          const verdict = ProjectExclusion.screen(declaration, screenCanonical, resolved.type === "Directory")
          if (verdict.excluded && verdict.pattern !== undefined)
            return yield* new ProjectExclusion.ExcludedError({
              resource: input.path,
              pattern: verdict.pattern,
              file: declaration.file,
            })
        }
      }

      const external = !lexicallyInternal
      const resource = external
        ? slash(resolved.canonical)
        : slash(path.relative(locationRoot, resolved.canonical) || ".")
      const externalDirectory =
        input.kind === "directory" && resolved.type === "Directory" ? resolved.canonical : resolved.directory
      const externalResource = slash(path.join(externalDirectory, "*"))
      return {
        canonical: resolved.canonical,
        resource,
        externalDirectory: external
          ? {
              directory: externalDirectory,
              resource,
              save: externalResource,
            }
          : undefined,
      } satisfies Target
    })

    return Service.of({
      resolve,
      // ⚠️ The public method takes the directory ONLY. `glob` and `grep` ask about their search
      // root, and the trust root is this location's own folder — which is ours to supply, not
      // theirs to know. Handing the boundary to callers would let a caller widen it.
      exclusionsFor: (directory: string) =>
        exclusionsFor(directory, FSUtil.normalizePath(ProjectFileResolve.trustedBoundary(location))),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [FSUtil.node, Location.node, ProjectFileCache.node],
})
