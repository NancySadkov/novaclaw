export * as LocationMutation from "./location-mutation"

import { makeLocationNode } from "./effect/app-node"
import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { FSUtil } from "./fs-util"
import { Location } from "./location"
import { fromBashDrive } from "./util/host-path"

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
  readonly resolve: (input: ResolveInput) => Effect.Effect<Target, PathError | FSUtil.Error>
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
      const hostPath = fromBashDrive(input.path)
      const relative = !path.isAbsolute(hostPath)
      const absolute = path.resolve(location.directory, hostPath)
      const lexicallyInternal = FSUtil.contains(location.directory, absolute)
      if (relative && !lexicallyInternal) return yield* new PathError({ path: input.path, reason: "relative_escape" })

      const resolved = yield* resolvePath(absolute)
      if (lexicallyInternal && !FSUtil.contains(locationRoot, resolved.canonical)) {
        return yield* new PathError({ path: input.path, reason: "location_escape" })
      }

      // ── (the project-exclusion gate is retired) ─────────────────────────────────────────────
      //
      // 🗑️ An exclusion gate used to sit HERE, after `resolvePath`, because this is the one call site
      // every path-taking tool funnels through: it looked up a `novaclaw.json` from the TARGET directory
      // (which is what made a nested project, an absolute path into this project from outside it, and a
      // path into a different project all answer with what the file's own owner wrote), folded two
      // Windows aliases `realPath` misses, and refused the read with an error naming the pattern and the
      // declaring file.
      //
      // Owner, 2026-09-16: *"We have retired the entire novaclaw.json mechanism and everything related
      // to it. Please ensure it is gone for good."* That deletion is the loss of a privacy guarantee,
      // not of a setting: `exclude` had no other source, so an excluded file is now readable by every
      // tool. The measurements that made the gate credible — a `subst`-mapped drive defeating the
      // climb, and the 8.3 short name surviving `realPath` — live in
      // `notes/reports/projects-program-2026-08-18.md`, which is now the record of a mechanism rather
      // than of a fix.

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

    return Service.of({ resolve })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [FSUtil.node, Location.node],
})
