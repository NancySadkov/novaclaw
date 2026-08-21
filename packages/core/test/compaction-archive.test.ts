import { describe, expect, test } from "bun:test"
import { SessionCompactionArchive } from "@novaclaw/core/session/compaction-archive"
import type { SessionMessage } from "@novaclaw/core/session/message"

// Where a conversation goes when it is compacted (owner, 2026-08-21). One chat per colleague means
// the chat never ends, so this is the only moment the older half of its working life would otherwise
// stop being reachable.

const at = new Date("2026-08-21T14:32:11Z")

// The same shape `session-compaction.test.ts` uses: `serializeMessage` reads `type` and `text`, so a
// structural stand-in keeps the test about the ARCHIVE rather than about message construction.
const user = (text: string): SessionMessage.Message => ({ type: "user", text }) as unknown as SessionMessage.Message

describe("whether a colleague archives at all", () => {
  test("by default it does — the owner's rule is 'unless the settings disable it'", () => {
    expect(SessionCompactionArchive.shouldArchive({ memory: "own", archiveChats: undefined })).toBe(true)
    expect(SessionCompactionArchive.shouldArchive({ memory: undefined, archiveChats: undefined })).toBe(true)
  })

  test("turning it off in the profile is honoured", () => {
    expect(SessionCompactionArchive.shouldArchive({ memory: "own", archiveChats: false })).toBe(false)
  })

  test("a THROWAWAY never archives, whatever the archive flag says", () => {
    // Archiving would hand "Crashtest Joe" a memory by the back door — exactly what a probe must not
    // have, and the reason `memory: none` exists at all.
    expect(SessionCompactionArchive.shouldArchive({ memory: "none", archiveChats: true })).toBe(false)
    expect(SessionCompactionArchive.shouldArchive({ memory: "none", archiveChats: undefined })).toBe(false)
  })
})

describe("what the archive is called", () => {
  test("names the chat and the day, not the compaction", () => {
    // Something a colleague can recognise months later, rather than a database fact wearing a label.
    expect(SessionCompactionArchive.archiveLabel({ title: "Bookkeeping", at })).toBe("Bookkeeping · 2026-08-21")
  })

  test("an untitled chat still gets a usable name", () => {
    expect(SessionCompactionArchive.archiveLabel({ title: undefined, at })).toBe("Chat · 2026-08-21")
    expect(SessionCompactionArchive.archiveLabel({ title: "   ", at })).toBe("Chat · 2026-08-21")
  })
})

describe("what gets written", () => {
  test("the transcript becomes labelled passages", () => {
    const passages = SessionCompactionArchive.plan({
      messages: [user("the quarterly numbers are in the ledger"), user("and the audit is next week")],
      title: "Bookkeeping",
      at,
    })
    expect(passages.length).toBeGreaterThan(0)
    expect(passages[0]!.label).toBe("Bookkeeping · 2026-08-21")
    expect(passages.map((passage) => passage.text).join(" ")).toContain("quarterly numbers")
  })

  test("the same transcript plans the same ids — re-archiving overlaps, never duplicates them", () => {
    // This is what lets the archive run on EVERY compaction without tracking which messages were
    // already written: the engine dedupes by primary key, so the overlap between two cycles collapses
    // into the same rows instead of a second copy of the same afternoon.
    const messages = [user("the quarterly numbers are in the ledger")]
    const first = SessionCompactionArchive.plan({ messages, title: "Bookkeeping", at })
    const second = SessionCompactionArchive.plan({ messages, title: "Bookkeeping", at })
    expect(second.map((passage) => passage.id)).toEqual(first.map((passage) => passage.id))
  })

  test("an empty or contentless transcript writes NOTHING", () => {
    // A compaction that had nothing to compress must not leave an empty passage behind, or the
    // colleague's cabinet fills with rows that say nothing and still rank in a search.
    //
    // ⚠️ The blank case is not `length > 0`: `serializeMessage` prefixes a speaker label, so a blank
    // message serializes to `"[User]:    "` — eleven characters of nothing that chunk happily.
    expect(SessionCompactionArchive.plan({ messages: [], title: "Bookkeeping", at })).toEqual([])
    expect(SessionCompactionArchive.plan({ messages: [user("   ")], title: undefined, at })).toEqual([])
  })
})
