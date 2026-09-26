import { describe, expect, test } from "bun:test"
import {
  cachedOfficerChat,
  listAgents,
  listSessions,
  listUsage,
  rememberOfficerChat,
  resolveOfficerChat,
} from "./agent-list"

/**
 * WHAT SURVIVES THE TRIP from the roster response to the UI.
 *
 * 🔴 `listAgents` is a HAND-KEPT SUBSET of the agent row, and it dropped `workspace` silently: the
 * server stamped it, `GET /api/agent` returned it, and the config dialog's "Browse …'s workspace"
 * link never rendered because the value did not survive this function. Nothing failed — the link
 * simply was not there, which reads as "not implemented" rather than "lost in transit".
 *
 * It is the same shape as `agent-clone.ts`, which lost `model`, `archiveChats`, `color` and `steps`
 * to a hand-written list until its own ledger caught it. A subset of a schema that grows is wrong the
 * first time somebody adds a field and never says so.
 *
 * ⚠️ `workspace` is NOT covered by the `config` spread either — that is keyed on
 * `ConfigAgent.Info.fields`, and `workspace` is derived server-side rather than authored, so it
 * appears in no config schema by design and must be carried by name.
 */

const response = (rows: ReadonlyArray<Record<string, unknown>>) => ({
  agent: { list: async () => ({ data: { data: rows } }) },
})

describe("the fields a roster row keeps", () => {
  test("🔴 the derived workspace path survives", async () => {
    const [row] = await listAgents(
      response([{ id: "theron", mode: "primary", name: "Theron", workspace: "C:/data/scratch/theron" }]) as never,
    )
    expect(row?.workspace).toBe("C:/data/scratch/theron")
  })

  test("a row without one is simply absent, not an empty string", async () => {
    // `""` would render a Browse link pointing nowhere, which is worse than no link.
    const [row] = await listAgents(response([{ id: "theron", mode: "primary" }]) as never)
    expect(row?.workspace).toBeUndefined()
  })

  test("🔴 `paused` survives the trip — it draws the badge AND enables Resume", async () => {
    // The same hand-kept-subset defect as `workspace`, and it disabled TWO controls at once. Every
    // other link in the chain existed: the server sets it from config `disabled: true`, the wire
    // schema declares it, `contacts.ts` maps it and `pages/contacts.tsx` renders a badge for it —
    // only this mapper dropped it. So no badge ever appeared, and the config dialog's button always
    // read "Pause", which re-wrote `disabled: true` on an already-paused colleague. Resume was
    // unreachable through the UI entirely.
    const [row] = await listAgents(response([{ id: "wren", mode: "primary", name: "Wren", paused: true }]) as never)
    expect(row?.paused).toBe(true)
  })

  test("an active colleague is not reported as paused", async () => {
    // The control. A mapper hard-coding `paused: true` would satisfy the test above.
    const [row] = await listAgents(response([{ id: "edda", mode: "primary", name: "Edda" }]) as never)
    expect(row?.paused).toBe(false)
  })

  test("the identity fields a roster tile draws still come through", async () => {
    const [row] = await listAgents(
      response([
        { id: "iris", mode: "primary", name: "Iris", title: "Companion", avatar: "I", memory: "none" },
      ]) as never,
    )
    expect({ name: row?.name, title: row?.title, avatar: row?.avatar, memory: row?.memory }).toEqual({
      name: "Iris",
      title: "Companion",
      avatar: "I",
      memory: "none",
    })
  })
})

/**
 * A ROSTER THAT COULD NOT BE READ IS NOT AN EMPTY COMPANY.
 *
 * 🔴 Owner, 2026-08-28: *"contacts app now has no contacts. Not even Nova itself … lack of agents
 * (i.e. even nova itself being dead) should trigger Novaclaw recovery sequence"*. The instance was
 * pointed at a LAN server that had gone away. The SDK does not throw on an HTTP failure — it returns
 * `{ data?, error? }` — and this function read only `data`, so the failure arrived as a SUCCESSFUL
 * empty list. `global.tsx` keeps the roster's error precisely so Contacts can say "could not read"
 * instead of "you have nobody", and it never saw one because nothing ever rejected.
 *
 * A/B for each: delete the matching guard in `listAgents` and the test fails with a resolved `[]`.
 */
describe("a failed read is a fault, not an empty roster", () => {
  test("🔴 an error response REJECTS instead of resolving empty", async () => {
    const failing = { agent: { list: async () => ({ error: { _tag: "UnauthorizedError" } }) } }
    expect(listAgents(failing as never)).rejects.toBeDefined()
  })

  test("a body that is not a list rejects rather than reading as nobody", async () => {
    const wrong = { agent: { list: async () => ({ data: { data: { nope: true } } }) } }
    expect(listAgents(wrong as never)).rejects.toThrow(/not a list/i)
  })

  test("🔴 zero colleagues rejects — Nova is built in and cannot be absent", async () => {
    // `nova` is protected from removal through every door, so an instance that reports nobody is
    // reporting a fault about itself.
    expect(listAgents(response([]) as never)).rejects.toThrow(/at least Nova/i)
  })

  test("a healthy roster still comes back", async () => {
    // The control: without this the three tests above would pass against a function that always threw.
    const rows = await listAgents(response([{ id: "nova", mode: "primary", name: "Nova" }]) as never)
    expect(rows.map((row) => row.id)).toEqual(["nova"])
  })
})

describe("roster usage uses one batch response", () => {
  test("keeps every requested agent and parses the batched map", async () => {
    let calls = 0
    const usage = await listUsage(
      {
        agent: {
          usageMany: async ({ agentIDs }: { agentIDs: readonly string[] }) => {
            calls += 1
            expect(agentIDs).toEqual(["nova", "theron"])
            return {
              data: {
                data: {
                  nova: [{ minute: 10, generated: 3 }],
                  theron: [{ minute: 9, generated: 7 }],
                },
              },
            }
          },
        },
      } as never,
      ["nova", "theron"],
    )
    expect(calls).toBe(1)
    expect(usage).toEqual({
      nova: [{ minute: 10, generated: 3 }],
      theron: [{ minute: 9, generated: 7 }],
    })
  })

  test("a failed batch dims rates without rejecting the roster", async () => {
    const usage = await listUsage({ agent: { usageMany: async () => ({ error: { _tag: "Unavailable" } }) } } as never, [
      "nova",
      "theron",
    ])
    expect(usage).toEqual({ nova: [], theron: [] })
  })
})

describe("roster session time boundary", () => {
  test("keeps decoded, wire, and legacy timestamp shapes as epoch millis", async () => {
    const rows = await listSessions({
      session: {
        list: async () => ({
          data: {
            data: [
              {
                id: "ses_nova",
                time: {
                  created: { epochMillis: 1_000 },
                  updated: "1970-01-01T00:00:02.000Z",
                  archived: new Date(3_000),
                },
              },
            ],
          },
        }),
      },
    } as never)

    expect(rows[0]?.time).toEqual({ created: 1_000, updated: 2_000, archived: 3_000 })
  })

  test("preserves the spawned-worker type used by the officer roster", async () => {
    const rows = await listSessions({
      session: {
        list: async () => ({
          data: { data: [{ id: "worker", parentID: "root", type: "sub-agent", time: { created: 1 } }] },
        }),
      },
    } as never)
    expect(rows[0]?.type).toBe("sub-agent")
  })
})

/**
 * 🔴 OPENING A COLLEAGUE MUST BE INSTANT (owner, 2026-09-26). The agent route renders from this cache
 * so a previously-opened colleague needs no session list and no record fetch — the "signal from Mars"
 * was those two round trips on every click.
 */
describe("the officer chat cache", () => {
  test("remembers the id AND directory, so the next open needs no fetch", () => {
    rememberOfficerChat("cache-srv", "daedalus", "ses_d", "/work")
    expect(cachedOfficerChat("cache-srv", "daedalus")).toEqual({ id: "ses_d", directory: "/work" })
    expect(cachedOfficerChat("cache-srv", "nova")).toBeUndefined()
  })

  test("a later prime that omits the directory keeps the one already known", () => {
    rememberOfficerChat("cache-srv2", "daedalus", "ses_d", "/work")
    rememberOfficerChat("cache-srv2", "daedalus", "ses_d")
    expect(cachedOfficerChat("cache-srv2", "daedalus")).toEqual({ id: "ses_d", directory: "/work" })
  })

  test("a NEW chat id does not inherit the old chat's directory", () => {
    rememberOfficerChat("cache-srv3", "daedalus", "ses_d", "/work")
    rememberOfficerChat("cache-srv3", "daedalus", "ses_new")
    expect(cachedOfficerChat("cache-srv3", "daedalus")).toEqual({ id: "ses_new", directory: undefined })
  })

  test("resolveOfficerChat with create:false never creates a chat on navigation", async () => {
    const created: unknown[] = []
    const sdk = {
      // The instance's answer, not a list to fold: a colleague with no chat is a 404 carrying the
      // kind the client matches on. See `officerChat` in agent-list.ts.
      agent: {
        chat: async () => {
          throw { data: { kind: "agent_chat_not_found", message: "no chat for this agent: nobody" } }
        },
      },
      session: {
        list: async () => ({ data: { data: [] } }),
        create: async (input: unknown) => {
          created.push(input)
          return { data: { data: { id: "ses_created" } } }
        },
      },
    }
    expect(await resolveOfficerChat(sdk as never, { agentID: "nobody", create: false, serverKey: "cache-srv4" })).toBeUndefined()
    expect(created).toEqual([])
    expect(cachedOfficerChat("cache-srv4", "nobody")).toBeUndefined()
  })

  test("resolveOfficerChat caches the live chat's id and directory", async () => {
    const sdk = {
      agent: { chat: async () => ({ data: { data: { id: "ses_live", title: "t", directory: "/live" } } }) },
      session: {
        list: async () => ({ data: { data: [] } }),
        create: async () => ({ data: { data: { id: "ses_created" } } }),
      },
    }
    expect(await resolveOfficerChat(sdk as never, { agentID: "solo", serverKey: "cache-srv5" })).toBe("ses_live")
    expect(cachedOfficerChat("cache-srv5", "solo")).toEqual({ id: "ses_live", directory: "/live" })
  })

  test("🔴 the answer comes from the instance, never from a page of the session list", async () => {
    // The defect this replaced: `listSessions` asks for no limit and therefore gets the newest 50
    // sessions. A colleague whose current chat is older than that page was answered with a STRANGER'S
    // transcript — or with nothing, which is the value that means "no chat" and would have started a
    // second one. A list carrying a different colleague's chat must not be consulted at all.
    const decoy = { id: "ses_stranger", agent: "someone-else", time: { created: 9 } }
    const sdk = {
      agent: { chat: async () => ({ data: { data: { id: "ses_true", title: "t", directory: "/true" } } }) },
      session: { list: async () => ({ data: { data: [decoy] } }), create: async () => ({ data: { data: {} } }) },
    }
    expect(await resolveOfficerChat(sdk as never, { agentID: "solo", serverKey: "cache-srv6" })).toBe("ses_true")
    expect(cachedOfficerChat("cache-srv6", "solo")).toEqual({ id: "ses_true", directory: "/true" })
  })

  test("a fault reading the colleague's chat is NOT answered as 'no chat'", async () => {
    // The 404 is an answer; a transport failure is not. Folding the second into the first is how a
    // colleague who HAS a chat gets a second one created beside it.
    const sdk = {
      agent: {
        chat: async () => {
          throw { data: { kind: "unreachable", message: "connection refused" } }
        },
      },
      session: { list: async () => ({ data: { data: [] } }), create: async () => ({ data: { data: {} } }) },
    }
    await expect(resolveOfficerChat(sdk as never, { agentID: "solo" })).rejects.toBeDefined()
  })

  test("🔴 a name that is not an agent gets NO chat created, while a chatless one does", async () => {
    // The kernel says why this distinction had to exist: `RosterChat.chatFor` reads rows and cannot
    // tell a chatless colleague from one that does not exist. So the instance asks the roster first
    // and refuses with its own kind. Creating on the phantom would write a transcript owned by a name
    // that is not an agent — and the caller cannot tell that from the quiet state it asked for.
    const created: unknown[] = []
    const phantom = {
      agent: {
        chat: async () => {
          throw { data: { kind: "agent_not_found", message: "no such agent: nobody" } }
        },
      },
      session: {
        list: async () => ({ data: { data: [] } }),
        create: async (input: unknown) => {
          created.push(input)
          return { data: { data: { id: "ses_phantom" } } }
        },
      },
    }
    expect(await resolveOfficerChat(phantom as never, { agentID: "nobody" })).toBeUndefined()
    expect(created).toEqual([])

    // The same call for a REAL colleague with no chat is the case that may create one.
    const chatless = {
      agent: {
        chat: async () => {
          throw { data: { kind: "agent_chat_not_found", message: "no chat for this agent: fresh" } }
        },
      },
      session: {
        list: async () => ({ data: { data: [] } }),
        create: async (input: unknown) => {
          created.push(input)
          return { data: { data: { id: "ses_first" } } }
        },
      },
    }
    expect(await resolveOfficerChat(chatless as never, { agentID: "fresh" })).toBe("ses_first")
    expect(created).toHaveLength(1)
  })

  test("a refusal naming a DIFFERENT agent is not this colleague's answer", async () => {
    // Both refusals are 404s, so the status cannot be the test. A refusal about someone else means the
    // instance answered about the wrong colleague, and reading it as "no chat" here would authorise a
    // second conversation beside a real one.
    const sdk = {
      agent: {
        chat: async () => {
          throw { data: { kind: "agent_chat_not_found", message: "no chat for this agent: someone-else" } }
        },
      },
      session: { list: async () => ({ data: { data: [] } }), create: async () => ({ data: { data: {} } }) },
    }
    await expect(resolveOfficerChat(sdk as never, { agentID: "solo" })).rejects.toBeDefined()
  })

  test("a 200 with no id is a fault, not permission to create", async () => {
    // The instance contradicting its own contract must not be smoothed into the one answer that
    // authorises writing a transcript over one that already exists.
    const created: unknown[] = []
    const sdk = {
      agent: { chat: async () => ({ data: { data: { title: "t", directory: "/d" } } }) },
      session: {
        list: async () => ({ data: { data: [] } }),
        create: async (input: unknown) => {
          created.push(input)
          return { data: { data: { id: "ses_written" } } }
        },
      },
    }
    await expect(resolveOfficerChat(sdk as never, { agentID: "solo" })).rejects.toBeDefined()
    expect(created).toEqual([])
  })
})
