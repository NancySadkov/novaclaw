import { afterEach, describe, expect, test } from "bun:test"
import { DateTime, Effect } from "effect"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { SessionMessage } from "../message"
import { AttachmentPaths } from "./attachment-paths"
import { STEER_PROVENANCE_PREFIX } from "../steer-provenance"

// Ported from https://github.com/NancySadkov/novaclaw/pull/9 by @DassaultFalconKing.
// Identity is `realpath`, so the cases that matter are the ALIASES: a symlink, a `..` segment and a
// percent-escaped URI all name one file, and a comparison that missed any of them would be
// protection in name only. Real files on purpose — the thing under test IS the filesystem resolution.

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

const tmp = () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "novaclaw-attachment-")))
  directories.push(directory)
  return directory
}

/** Whether this host lets an unprivileged process create a symlink (Windows: only under Developer
 *  Mode or elevation — AGENTS.md → Known pitfalls #4). Probed once, so the assertion below can be
 *  conditional without registering a platform-dependent SKIP in the asserted skip ledger. */
const canSymlink = (() => {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), "novaclaw-symlink-probe-"))
  try {
    fs.writeFileSync(path.join(probe, "t"), "t")
    fs.symlinkSync(path.join(probe, "t"), path.join(probe, "l"))
    return true
  } catch {
    return false
  } finally {
    fs.rmSync(probe, { recursive: true, force: true })
  }
})()

/** A user message carrying one attachment, in the shape `SessionHistory` hands the runner. */
const attached = (uri: string, sourceUri?: string) =>
  ({
    id: "msg_attachment",
    type: "user",
    text: "Use the attached task specification.",
    files: [{ uri, ...(sourceUri === undefined ? {} : { sourceUri }), mime: "text/markdown", name: "task spec.md" }],
    time: { created: DateTime.makeUnsafe(1) },
  }) as unknown as SessionMessage.Message

const resolve = (messages: readonly SessionMessage.Message[]) =>
  Effect.runPromise(AttachmentPaths.resolve(messages)).then((set) => [...set])

describe("AttachmentPaths.resolve", () => {
  test("percent-decodes a file URI, and resolves a symlink to the same identity as its target", async () => {
    const directory = tmp()
    // The space in the name is the point: `pathToFileURL` escapes it, and a naive `slice(7)` would
    // yield a path with a literal %20 that matches nothing.
    const target = path.join(directory, "task spec.md")
    fs.writeFileSync(target, "task")
    expect(await resolve([attached(pathToFileURL(target).href)])).toEqual([target])

    // ⚠️ Creating a symlink on Windows needs elevation or Developer Mode, so this leg is asserted
    // where the OS allows it rather than registered as a skip — a platform skip would move `core`'s
    // asserted skip count in `script/test-baseline.json` on one OS and not the other. The leg that
    // matters most runs everywhere: the `..` test below proves the same realpath property, and the
    // Spark (Linux) exercises the symlink leg on every run there.
    if (!canSymlink) return
    const alias = path.join(directory, "alias.md")
    fs.symlinkSync(target, alias)
    expect(await resolve([attached(pathToFileURL(alias).href)])).toEqual([target])
  })

  test("a `..` segment resolves to the same identity as the direct path", async () => {
    const directory = tmp()
    const target = path.join(directory, "task.md")
    fs.writeFileSync(target, "task")
    const indirect = path.join(directory, "sub", "..", "task.md")
    fs.mkdirSync(path.join(directory, "sub"))

    expect(await resolve([attached(pathToFileURL(indirect).href)])).toEqual([target])
  })

  test("uses sourceUri when the uri carries materialized bytes", async () => {
    const directory = tmp()
    const target = path.join(directory, "task.md")
    fs.writeFileSync(target, "task")

    // This is the CLI's shape: a bounded data: URI for the provider, the real path alongside it.
    // Without `sourceUri` the local identity is gone and the file is silently unprotected.
    expect(await resolve([attached("data:text/markdown;base64,dGFzaw==", pathToFileURL(target).href)])).toEqual([
      target,
    ])
  })

  test("ignores attachments with no local identity, and paths that no longer exist", async () => {
    // A paste or a screenshot has no file to protect; a deleted attachment has no identity to
    // compare against. Both are honestly unprotected rather than guessed at.
    expect(await resolve([attached("data:text/plain,task")])).toEqual([])
    expect(await resolve([attached("file:///definitely/missing/novaclaw-task.md")])).toEqual([])
  })

  test("a harness STEER does not contribute attachments, even though it rides the user role", async () => {
    // A steer is injected by the harness and carries the `user` role all the way into the durable
    // record. "The user attached this" and "something with the user role carried this" are different
    // questions, and this module answers the first. Steers are text-only today, so the two coincide
    // — which is precisely why this needs a test rather than a comment: the day that changes, the
    // harness would silently be deciding which of the user's files are protected.
    const directory = tmp()
    const target = path.join(directory, "task.md")
    fs.writeFileSync(target, "task")
    const uri = pathToFileURL(target).href
    const steer = {
      ...attached(uri),
      text: `${STEER_PROVENANCE_PREFIX}Stop repeating the same bash call.`,
    } as unknown as SessionMessage.Message

    // NEGATIVE CONTROL: the identical message without the prefix DOES resolve, so this asserts the
    // provenance predicate rather than a broken fixture.
    expect(await resolve([attached(uri)])).toEqual([target])
    expect(await resolve([steer])).toEqual([])
  })

  test("reads only USER messages — an assistant cannot enlarge its own protected set", async () => {
    const directory = tmp()
    const target = path.join(directory, "task.md")
    fs.writeFileSync(target, "task")
    const assistant = {
      ...attached(pathToFileURL(target).href),
      type: "assistant",
    } as unknown as SessionMessage.Message

    // NEGATIVE CONTROL: the identical message as `user` resolves, so this asserts the type filter
    // rather than a broken fixture.
    expect(await resolve([attached(pathToFileURL(target).href)])).toEqual([target])
    expect(await resolve([assistant])).toEqual([])
  })
})
