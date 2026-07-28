export * as AttachmentPaths from "./attachment-paths"

import { Effect } from "effect"
import fs from "node:fs/promises"
import { fileURLToPath } from "node:url"
import type { SessionMessage } from "../message"
import { isRealUserTurn } from "../steer-provenance"

/**
 * The canonical local identity of every file the USER attached to this conversation.
 *
 * Why this exists: a file handed to the agent as context is the user's own source of truth — a task
 * spec, a config, a document to summarize. Nothing in the tool layer distinguishes it from a file
 * the agent itself created, so an agent told to "do what the spec says" is free to rewrite the spec
 * to match what it did, and under the default permission mode (`bypass` — see
 * `EFFECTIVE_CONFIG_DEFAULTS`) it does so silently. Resolving the set once per turn is what lets the
 * permission evaluator recognise the file later.
 *
 * Identity is `realpath`, not the string the user typed: a symlink, a `..` segment, a percent-escape
 * and a differently-spelled absolute path are all the same file, and a comparison that missed any of
 * them would be protection in name only.
 *
 * ⚠️ Ported from https://github.com/NancySadkov/novaclaw/pull/9 by @DassaultFalconKing. The upstream
 * version resolved with `fs.realpathSync` inside the runner's Effect graph; this one does not block
 * the loop, matching how `location-mutation.ts` already resolves the mutation side.
 */
export const resolve = (messages: readonly SessionMessage.Message[]): Effect.Effect<ReadonlySet<string>> =>
  Effect.forEach(
    // ⚠️ `isRealUserTurn`, not `type === "user"`. A harness-injected steer rides the `user` role all
    // the way into the durable record, so "the user attached this" and "something with the user role
    // carried this" are different questions — and this module is deciding what the agent may not
    // overwrite. Steers are text-only today, so the two answers coincide; that is an accident of the
    // current injection path, not a property anyone guaranteed, and the moment it stops being true
    // the harness would be quietly deciding which of the user's files are protected. The shared
    // predicate is also what makes the answer legible to `test/steer-provenance.test.ts`, which
    // failed this file until it asked the question — exactly as designed.
    messages.filter(isRealUserTurn).flatMap((message) =>
      (message.files ?? []).flatMap((file) => {
        // A materialized attachment keeps its origin in `sourceUri`; an ordinary one IS its uri.
        const uri = (file as typeof file & { readonly sourceUri?: string }).sourceUri ?? file.uri
        return uri.startsWith("file:") ? [uri] : []
      }),
    ),
    (uri) =>
      // A path we cannot resolve is not protected, and that is the honest answer: the comparison is
      // by canonical identity, and there is no identity to compare against. It is also the only
      // reachable case for an attachment that has since been deleted or renamed.
      Effect.tryPromise(() => fs.realpath(fileURLToPath(uri))).pipe(
        Effect.map((path) => [path]),
        Effect.orElseSucceed((): string[] => []),
      ),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((paths) => new Set(paths.flat())))
