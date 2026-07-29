import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Ruling 1 — an invariant whose violation compiles green ships with a mechanical check.
 *
 * The `/undo` bug was never a logic error: every function involved was individually correct. What
 * shipped broken twice was the WIRING between them, and each break compiles, typechecks and passes
 * every unit test:
 *
 *   1. a caller stages a revert without refetching the record, so the client never learns of it;
 *   2. the transcript renders the store without the boundary, so nothing leaves the screen;
 *   3. a commit anchors on the previous PROMPT rather than the previous MESSAGE, silently deleting
 *      one turn more than the user asked for.
 *
 * These are source assertions because that is the only form a check for "the call sites are still
 * connected" can take — the alternative is mounting the whole session page against a fake server,
 * which is what nobody did on either of the previous two attempts. They are deliberately narrow:
 * each names one identifier that must (or must not) appear in one file.
 */
const read = (...segments: string[]) => readFileSync(join(import.meta.dir, ...segments), "utf8")

const commands = read("use-session-commands.tsx")
const page = read("..", "session.tsx")
const timeline = read("timeline", "native-timeline.tsx")
const model = read("timeline", "model.ts")

/**
 * The body of a `const <name> = async (...) => { ... }` declared at the component/hook scope
 * (two-space indent), sliced up to its own closing brace — the first following line that starts at
 * that same indent.
 */
const fn = (source: string, name: string) => {
  const start = source.search(new RegExp(`const ${name} = async \\(`))
  expect(start).toBeGreaterThan(-1)
  const rest = source.slice(start)
  const end = rest.search(/\n {2}\S/)
  expect(end).toBeGreaterThan(0)
  return rest.slice(0, end)
}

describe("revert wiring", () => {
  test("/undo and /redo go through the shared mutations, never a bare revert.stage", () => {
    expect(fn(commands, "undo")).toContain("actions.stageRevert(")
    expect(fn(commands, "redo")).toContain("actions.restoreRevert(")

    // The regression shape: `/undo` POSTing the mutation itself. It succeeds server-side and the
    // client record stays blank, so no dock renders and nothing leaves the transcript.
    expect(commands).not.toContain("client.v2.session.revert.")
  })

  test("the session page supplies those two mutations to the command hook", () => {
    const call = page.slice(page.indexOf("useSessionCommands({"), page.indexOf("const openReviewFile"))
    expect(call).toContain("stageRevert:")
    expect(call).toContain("restoreRevert:")
  })

  test("both revert mutations refetch the session record after staging", () => {
    // The server projector writes the boundary to SessionTable directly and publishes no
    // `session.updated`, so this refetch is the only thing that puts it in the client record.
    const staging = page.slice(page.indexOf("const revertMutation"), page.indexOf("const reverting"))
    expect(staging.match(/client\.v2\.session\.get\(/g)?.length).toBe(2)
  })

  test("the transcript render path applies the staged boundary", () => {
    expect(timeline).toContain("selectVisibleMessages")
    expect(timeline).toContain("revertMessageID?: string")
    // What is RENDERED must be the filtered list, not the raw store read.
    expect(timeline).toContain("selectVisibleMessages(stored(), props.revertMessageID)")
    expect(timeline).toContain("messages={messages()}")
    expect(timeline).not.toContain("messages={stored()}")

    // ...and the page must actually hand it the boundary.
    expect(page).toContain("revertMessageID={revertMessageID()}")
  })

  test("message navigation and the transcript share one visibility rule", () => {
    expect(model).toContain("selectVisibleMessages")
    // A second hand-rolled filter here is how the two views drifted apart in the first place.
    expect(model).not.toContain("message.id < revertMessageID")
  })

  test("every commit boundary is computed over the FULL message list", () => {
    for (const name of ["discardRolled", "revertToPrompt"]) {
      const body = fn(page, name)
      expect(body).toContain("commitBoundaryID(serverSync().nativeMessages.messages(sessionID) ?? [], ")
      // `userMessages()` here anchors on the previous PROMPT and takes the intervening reply with it.
      expect(body).not.toContain("userMessages()")
    }
  })

  test("the dock's Discard still routes through the one commit sequence", () => {
    expect(fn(page, "discardRolled")).toContain("commitRevertTo(sessionID, boundaryID)")
    expect(fn(page, "revertToPrompt")).toContain("commitRevertTo(sessionID, boundaryID)")
    // Reversible until Discard: staging alone must never reach `revert.commit`.
    const commit = page.indexOf("client.v2.session.revert.commit(")
    expect(commit).toBeGreaterThan(-1)
    expect(page.slice(page.indexOf("const commitRevertTo"), page.indexOf("Discard the rolled-back"))).toContain(
      "client.v2.session.revert.commit(",
    )
    expect(page.match(/client\.v2\.session\.revert\.commit\(/g)?.length).toBe(1)
  })
})
