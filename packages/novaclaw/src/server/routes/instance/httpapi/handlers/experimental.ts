import { InstanceState } from "@/effect/instance-state"
import { LocationServiceMap } from "@novaclaw/core/location-services"
import { ServerLocationServiceMap } from "@/location-service-map"
import { Location } from "@novaclaw/core/location"
import { ProjectFileResolve } from "@novaclaw/core/project-file"
import { ProjectFileCache } from "@novaclaw/core/project-file-cache"
import { ProjectFileWrite } from "@novaclaw/core/project-file-write"
import { ProjectGitignore } from "@novaclaw/core/project-gitignore"
import { SessionEffectiveConfig } from "@novaclaw/core/session/effective-config"
import { ProjectFile } from "@novaclaw/schema/project-file"
import { FSUtil } from "@novaclaw/core/fs-util"
import nodePath from "node:path"
import { AbsolutePath } from "@novaclaw/core/schema"
import { Worktree } from "@/worktree"
import { Effect, Layer } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"
import { ProjectWriteInput, WorktreeApiError } from "../groups/experimental"

function mapWorktreeError<A, R>(self: Effect.Effect<A, Worktree.Error, R>) {
  return self.pipe(
    Effect.mapError((error) => new WorktreeApiError({ name: error._tag, data: { message: error.message } })),
  )
}

export const experimentalHandlers = HttpApiBuilder.group(InstanceHttpApi, "experimental", (handlers) =>
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const worktreeSvc = yield* Worktree.Service

    const worktreeCreate = Effect.fn("ExperimentalHttpApi.worktreeCreate")(function* (ctx: {
      payload: typeof Worktree.CreateInput.Type | void
    }) {
      return yield* mapWorktreeError(worktreeSvc.create(ctx.payload ?? undefined))
    })

    /**
     * What importing the project root's `.gitignore` would ADD to its `exclude` list.
     *
     * 🔴 A SUGGESTION, computed on read and applied by nobody. Model read eligibility stays
     * distinct from watcher/build ignores, and this is where that distinction is either
     * respected or quietly lost: a `.gitignore` says what should not be COMMITTED, `exclude` says
     * what must never reach a model, and the two lists genuinely disagree (`dist/` is fine to read;
     * a committed secrets folder is not in the `.gitignore` at all). So nothing is copied without a
     * person confirming it, and the surface says which file it came from.
     *
     * ⚠️ Only the file beside the `novaclaw.json`. Patterns are relative to the folder that declared
     * them, so a nested `.gitignore` would have to be re-anchored line by line — and a re-anchored
     * line is no longer one the user can recognise in their own file.
     *
     * ⚠️ Absent, never an empty proposal, when there is no `.gitignore` or it is too big to be a
     * hand-maintained list. "There is nothing to import" and "there is no file" are different
     * sentences and the client renders them differently.
     */
    const gitignoreProposal = Effect.fn("ExperimentalHttpApi.gitignoreProposal")(function* (
      root: string,
      exclude: readonly string[],
    ) {
      const fs = yield* FSUtil.Service
      const file = nodePath.join(root, ".gitignore")
      const text = yield* fs.readFileStringSafe(file).pipe(Effect.orElseSucceed(() => undefined))
      if (text === undefined) return undefined
      // Bytes, not characters: the cap is about "is this a file a person maintains by hand".
      if (Buffer.byteLength(text, "utf8") > ProjectGitignore.MAX_BYTES) return undefined
      const proposal = ProjectGitignore.propose(text, exclude)
      return {
        file,
        add: proposal.add,
        already: proposal.already,
        dropped: proposal.dropped.map((item) => ({ source: item.source, reason: item.reason })),
        reincludes: proposal.reincludes,
      }
    })

    /**
     * The `novaclaw.json` governing the routed location.
     *
     * ⚠️ It carries the permission RULES, not only their count — corrected 2026-08-18. The count
     * shipped with a comment claiming *"the permission surface already renders rules"*, and no such
     * surface existed: a user refused by their folder's file could see that N rules governed them
     * and never which one. The count stays for the chat/Files chips, which really do want a number.
     */
    const project = Effect.fn("ExperimentalHttpApi.project")(function* () {
      const directory = (yield* InstanceState.context).directory
      const resolution = yield* Effect.gen(function* () {
        const location = yield* Location.Service
        return yield* ProjectFileResolve.resolve(directory, ProjectFileResolve.trustedBoundary(location))
      }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))))
      if (resolution.kind === "project") {
        const exclude = resolution.info.exclude ?? []
        // ⚠️ The SAME function the kernel's cache applies, called here rather than re-derived: the
        // client must be told exactly what is in force, and a second reading of "a project may hide,
        // never un-hide" is a second chance to get it wrong.
        const skills = ProjectFile.narrowSkills(resolution.info.skills)
        // ⚠️ The KERNEL's fold, called rather than re-derived — the same reason `narrowSkills` is
        // called above instead of the section being handed over raw. The draft composer renders this
        // verbatim; a second fold in the browser is a second chance to get `narrowTune`'s
        // raise-only rule wrong, and that has already happened once (`config-provenance.ts`).
        const stance = SessionEffectiveConfig.folderStance(resolution.info.tune, SessionEffectiveConfig.ceilings())
        const tuneFeatures: Record<string, boolean> = {}
        for (const feature of stance.applied) {
          const value = stance.config[feature]
          if (typeof value === "boolean") tuneFeatures[feature] = value
        }
        const gitignore = yield* gitignoreProposal(resolution.root, exclude).pipe(
          Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))),
        )
        return {
          kind: "project" as const,
          root: resolution.root,
          file: resolution.file,
          ...(resolution.info.name === undefined ? {} : { name: resolution.info.name }),
          permissionRules: resolution.info.permissions?.length ?? 0,
          permissions: resolution.info.permissions ?? [],
          exclude,
          skills: skills.hidden,
          skillsRefused: skills.refused,
          tune: {
            features: tuneFeatures,
            applied: stance.applied,
            refused: stance.refused,
            deferred: stance.deferred,
          },
          ...(gitignore === undefined ? {} : { gitignore }),
        }
      }
      // ⚠️ `invalid` is reported, never swallowed into `none`. "There is no project here" and "your
      // project file is broken" are the two answers a user acts on differently, and collapsing them
      // is how a typo becomes an afternoon.
      if (resolution.kind === "invalid")
        return { kind: "invalid" as const, file: resolution.file, reason: resolution.reason, detail: resolution.detail }
      return { kind: "none" as const }
      // ⚠️ `orDie` on the WHOLE handler. The resolver already ABSORBS every expected failure — an
      // unreadable file continues the walk, a malformed one comes back as `invalid` — so anything
      // surviving to here is a defect in this process, and calling that a client error would tell
      // the caller to fix a request that was fine.
    }, Effect.orDie)

    /**
     * Create or update the routed folder's `novaclaw.json`.
     *
     * ⚠️ The target is the ROUTED DIRECTORY's own file, never the ancestor `GET /api/project`
     * resolves to. "Make Default for this Folder" means this folder: writing into a grandparent
     * because that is where an existing file happened to live would silently change the defaults of
     * every sibling checkout under it.
     *
     * ⚠️ Write scope (AGENTS.md principle 11c): the session's working folder is one of the three
     * places NovaClaw may write, and `ProjectFileWrite.write` appends a constant filename to it, so
     * no caller-supplied path component reaches the filesystem.
     */
    const projectWrite = Effect.fn("ExperimentalHttpApi.projectWrite")(function* (ctx: {
      payload: typeof ProjectWriteInput.Type
    }) {
      const directory = (yield* InstanceState.context).directory
      const result = yield* Effect.gen(function* () {
        const written = yield* ProjectFileWrite.write(directory, ctx.payload)
        // 🔴 Drop the cached read NOW rather than waiting out its 1 s freshness bound. That TTL exists
        // for edits we cannot see coming; this one we made ourselves, and a turn starting inside that
        // window would otherwise run against the file as it WAS — a folder governed half by what its
        // owner just saved and half by what it used to say. Invalidating clears descendants too,
        // because a new file steals governance from every folder beneath it.
        //
        // ⚠️ Only on a successful write: a refusal changed no bytes, so discarding warm entries for
        // every directory underneath would be a cost with nothing behind it.
        //
        // ⚠️ **Inside this provided scope, deliberately.** The service must be the LOCATION's cache —
        // the very instance the kernel reads through. Reaching for a fresh `ProjectFileCache.layer`
        // here would compile, run, and invalidate a second cache nobody consults, which is a silent
        // no-op rather than a failure. (Measured: hoisting this line out of the scope failed 7 route
        // tests with "Service not found" while `tsgo -b` stayed green.)
        if (written.ok) yield* (yield* ProjectFileCache.Service).invalidate(directory)
        return written
      }).pipe(Effect.provide(locations.get(Location.Ref.make({ directory: AbsolutePath.make(directory) }))))
      // A refusal travels as a 200 body, deliberately — see `ProjectWriteResult`. `orDie` therefore
      // covers only defects: every condition a user can cause is already in the union.
      return result.ok
        ? {
            ok: true as const,
            file: result.file,
            created: result.created,
            sections: result.sections,
            cleared: result.cleared,
            refusedTune: result.refusedTune,
            refusedPermissions: result.refusedPermissions,
            refusedSkills: result.refusedSkills,
            refusedPolicies: result.refusedPolicies,
          }
        : { ok: false as const, file: result.file, reason: result.reason, detail: result.detail }
    }, Effect.orDie)

    return handlers
      .handle("project", project)
      .handle("projectWrite", projectWrite)
      .handle("worktreeCreate", worktreeCreate)
  }),
).pipe(Layer.provide(ServerLocationServiceMap.layer))
