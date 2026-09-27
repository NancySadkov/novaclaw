import { afterEach, describe, expect, mock, test } from "bun:test"
import type { SessionMessage } from "@novaclaw/sdk/v2"
import { MarkedContext } from "@novaclaw/ui/context/marked"
import { createSignal } from "solid-js"
import { render } from "solid-js/web"
import { applySteerProvenance } from "@novaclaw/core/session/steer-provenance"

// Bun does not apply Vite's `?worker&url` transform. Resolve the same canonical module before the
// transcript import so this browser test reaches the shipped Solid component, not a copied shell.
mock.module("../../session-ui/src/components/markdown-shiki.worker.ts?worker&url", () => ({ default: "worker.js" }))
const { NativeTranscript } = await import("@novaclaw/session-ui/v2/native-transcript")

let dispose: (() => void) | undefined

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.innerHTML = ""
})

const messages = [
  { id: "msg_user", type: "user", text: "Keep the complete log", time: { created: 1 } },
  {
    id: "msg_assistant",
    type: "assistant",
    agent: "hecate",
    model: { providerID: "spark", id: "current" },
    // A step timestamp may settle before its command does. This is the precise persisted shape that
    // used to make a remounted transcript mistake the still-working turn for foldable history.
    time: { created: 2, completed: 3 },
    content: [
      { id: "text_1", type: "text", text: "Durable output before leaving Chat" },
      {
        id: "call_1",
        type: "tool",
        name: "bash",
        time: { created: 4, ran: 5 },
        state: {
          status: "running",
          input: { command: "bun run test --only=typecheck" },
          structured: {},
          content: [],
        },
      },
    ],
  },
] as unknown as SessionMessage[]

function mount(
  onStopCommand?: (callID: string, reason: string) => void | Promise<void>,
  options?: {
    messages?: SessionMessage[]
    status?: unknown
    liveGeneratedTokens?: number
    directory?: string
    foldStateKey?: string
  },
) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  dispose = render(
    () => (
      <MarkedContext.Provider
        value={{ parser: { parse: async (text: string) => text }, resolveFile: () => undefined } as never}
      >
        <NativeTranscript
          messages={options?.messages ?? messages}
          foldStateKey={options?.foldStateKey}
          status={(options?.status ?? { type: "busy" }) as never}
          liveGeneratedTokens={options?.liveGeneratedTokens}
          directory={options?.directory}
          onStopCommand={onStopCommand}
        />
      </MarkedContext.Provider>
    ),
    host,
  )
  return host
}

describe("native transcript remount", () => {
  const toolStep = (id: string, names: string[], prose?: string) =>
    ({
      id,
      type: "assistant",
      agent: "iris",
      model: { providerID: "test", id: "test" },
      time: { created: 1, completed: 2 },
      content: [
        ...(prose ? [{ id: `${id}:text`, type: "text", text: prose }] : []),
        ...names.map((name, index) => ({
          id: `${id}:${index}`,
          type: "tool",
          name,
          time: { created: 1, completed: 2 },
          state: {
            status: "completed",
            input: { path: `${name}-${index}.txt`, command: "echo probe" },
            structured: {},
            content: [],
            outputPaths: [],
            result: "ok",
          },
        })),
      ],
    }) as unknown as SessionMessage

  test("folds consecutive tools across steps with per-tool counts and no single-use count", async () => {
    const host = mount(undefined, {
      messages: [
        toolStep("count-a", ["read", "read", "write"]),
        toolStep("count-b", ["read", "read", "read", "write", "write", "bash"]),
      ],
      status: { type: "idle" },
    })
    const fold = host.querySelector<HTMLDetailsElement>('[data-slot="native-tool-run"]')!
    expect(host.querySelectorAll('[data-slot="native-tool-run"]')).toHaveLength(1)
    expect(fold.open).toBe(false)
    expect(fold.querySelector("summary")?.textContent).toBe("Used tools Read 5x, Write 3x, Bash")
    fold.querySelector("summary")!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(fold.open).toBe(true)
    expect(fold.querySelectorAll('[data-component="basic-tool-v2"]')).toHaveLength(9)
  })

  test("keeps intervening prose outside the tool folds and leaves a single command ungrouped", () => {
    const host = mount(undefined, {
      messages: [
        toolStep("before-prose", ["read", "read"]),
        toolStep("after-prose", ["write", "write"], "The files are ready."),
        toolStep("single-command", ["bash"], "Now run the check."),
      ],
      status: { type: "idle" },
    })
    expect(host.querySelectorAll('[data-slot="native-tool-run"]')).toHaveLength(2)
    for (const prose of host.querySelectorAll('[data-slot="native-assistant-text"]'))
      expect(prose.closest('[data-slot="native-tool-run"]')).toBeNull()
    expect(host.querySelectorAll('[data-component="basic-tool-v2"]')).toHaveLength(5)
  })

  test("preserves an explicitly opened tool run through new steps and chat remount", async () => {
    const foldStateKey = "tool-run-expansion"
    const firstMessages = [toolStep("open-a", ["read", "read"])]
    const first = mount(undefined, { messages: firstMessages, foldStateKey, status: { type: "idle" } })
    first.querySelector<HTMLElement>('[data-slot="native-tool-run"] > summary')!.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    dispose?.()
    dispose = undefined
    first.remove()
    const next = mount(undefined, {
      messages: [...firstMessages, toolStep("open-b", ["write"])],
      foldStateKey,
      status: { type: "idle" },
    })
    const fold = next.querySelector<HTMLDetailsElement>('[data-slot="native-tool-run"]')!
    expect(fold.open).toBe(true)
    expect(fold.querySelector("summary")?.textContent).toBe("Used tools Read 2x, Write")
  })

  test("updates the summary and tool details when a streamed tool settles", async () => {
    const initial = toolStep("live-run", ["read", "write"]) as Extract<SessionMessage, { type: "assistant" }>
    const live = structuredClone(initial)
    const active = live.content[1] as Extract<(typeof live.content)[number], { type: "tool" }>
    active.state = { status: "running", input: { path: "live.txt" }, structured: {}, content: [] }
    const [items, setItems] = createSignal<SessionMessage[]>([live])
    const host = document.createElement("div")
    document.body.appendChild(host)
    dispose = render(
      () => (
        <MarkedContext.Provider
          value={{ parser: { parse: async (text: string) => text }, resolveFile: () => undefined } as never}
        >
          <NativeTranscript messages={items()} status={{ type: "busy" } as never} />
        </MarkedContext.Provider>
      ),
      host,
    )
    expect(host.querySelector('[data-slot="native-tool-run"] summary [role="status"]')).not.toBeNull()
    host.querySelector<HTMLElement>('[data-slot="native-tool-run"] > summary')!.click()
    setItems([initial])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(host.querySelector('[data-slot="native-tool-run"] summary [role="status"]')).toBeNull()
    expect(host.querySelector<HTMLDetailsElement>('[data-slot="native-tool-run"]')!.open).toBe(true)
    expect(host.textContent).toContain("write-1.txt")
  })

  test("keeps steering in the open work log and folds only after accepted exit", () => {
    const steered = [
      { id: "msg_user_start", type: "user", text: "Investigate the failure", time: { created: 1 } },
      {
        id: "msg_assistant_probe",
        type: "assistant",
        agent: "hecate",
        model: { providerID: "spark", id: "current" },
        time: { created: 2, completed: 5 },
        content: [
          {
            id: "call_probe",
            type: "tool",
            name: "bash",
            time: { created: 3, ran: 4, completed: 5 },
            state: {
              status: "completed",
              input: { command: "bun test" },
              structured: {},
              content: [],
              outputPaths: [],
              result: "still running",
            },
          },
        ],
      },
      { id: "msg_user_steer", type: "user", text: "Also inspect the event boundary", time: { created: 6 } },
    ] as unknown as SessionMessage[]

    const open = mount(undefined, { messages: steered, status: { type: "idle" } })
    expect(open.querySelectorAll('[data-slot="native-turn"]')).toHaveLength(1)
    expect(open.querySelector('[data-slot="native-turn-work"]')).toBeNull()
    expect(open.querySelector('[data-slot="native-turn-outcome"]')).toBeNull()

    dispose?.()
    dispose = undefined
    open.remove()
    const completed = mount(undefined, {
      messages: [
        ...steered,
        {
          id: "msg_assistant_exit",
          type: "assistant",
          agent: "hecate",
          model: { providerID: "spark", id: "current" },
          acceptedExit: { result: "The steered investigation is complete.", time: 9 },
          time: { created: 7, completed: 9 },
          content: [
            {
              id: "call_exit",
              type: "tool",
              name: "exit",
              time: { created: 8, ran: 8, completed: 9 },
              state: {
                status: "completed",
                input: { result: "The steered investigation is complete." },
                structured: {},
                content: [],
                outputPaths: [],
                result: "The steered investigation is complete.",
              },
            },
          ],
        } as unknown as SessionMessage,
      ],
      // A goal-oriented officer stays operationally busy while its accepted work unit sleeps.
      status: { type: "retry", attempt: 1, message: "Waiting for the environment to change…", next: 600_009 },
    })
    expect(completed.querySelectorAll('[data-slot="native-turn"]')).toHaveLength(1)
    expect(completed.querySelector('[data-slot="native-turn-work"]')).not.toBeNull()
    expect(completed.querySelector('[data-slot="native-turn-work"]')?.hasAttribute("open")).toBe(false)
    expect(completed.querySelector('[data-slot="native-turn-outcome"]')?.textContent).toContain(
      "The steered investigation is complete.",
    )
  })

  test("keeps the complete persisted turn visible after leaving and reopening Chat", async () => {
    const first = mount()
    expect(first.textContent).toContain("Keep the complete log")
    expect(first.textContent).toContain("Durable output before leaving Chat")
    expect(first.querySelector('[data-slot="native-turn-work"]')).toBeNull()

    // Navigation destroys the route component; reopening Chat builds it from the same native store.
    dispose?.()
    dispose = undefined
    first.remove()
    let stoppedCall: string | undefined
    let stoppedFor: string | undefined
    const reopened = mount((callID, reason) => {
      stoppedCall = callID
      stoppedFor = reason
    })

    expect(reopened.textContent).toContain("Keep the complete log")
    expect(reopened.textContent).toContain("Durable output before leaving Chat")
    expect(reopened.querySelector('[data-slot="native-turn-work"]')).toBeNull()

    // The full command is intentionally folded, but remains expandable while it is running.
    ;(reopened.querySelector('[data-slot="basic-tool-v2-trigger"]') as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(reopened.textContent).toContain("bun run test --only=typecheck")

    const input = reopened.querySelector('[data-slot="native-command-stop"] input') as HTMLInputElement
    const stop = reopened.querySelector('[data-slot="native-command-stop"] button') as HTMLButtonElement
    expect(stop.disabled).toBe(true)
    input.value = "it has made no progress"
    input.dispatchEvent(new Event("input", { bubbles: true }))
    expect(stop.disabled).toBe(false)
    stop.click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(stoppedCall).toBe("call_1")
    expect(stoppedFor).toBe("it has made no progress")
  })

  test("keeps the run token counter moving inside the active command", async () => {
    const startedAt = Date.now() - 1_000
    const host = mount(undefined, {
      liveGeneratedTokens: 321,
      status: {
        type: "busy",
        timing: { startedAt, phases: [], providerAttempts: [] },
      },
    })
    expect(host.querySelector('[data-slot="native-provider-status"]')).toBeNull()
    expect(host.querySelector('[data-slot="native-turn-receipt"]')).toBeNull()
    ;(host.querySelector('[data-slot="basic-tool-v2-trigger"]') as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    const prelude = host.querySelector('[data-slot="native-tool-prelude"]')
    expect(prelude?.querySelector('[data-slot="native-turn-tokens"]')?.textContent).toBe("~321")
  })

  test("nests the reasoning and folded profiling receipt inside the command they produced", async () => {
    const nested = [
      { id: "msg_user_nested", type: "user", text: "Inspect it", time: { created: 1 } },
      {
        id: "msg_assistant_nested",
        type: "assistant",
        agent: "hecate",
        model: { providerID: "spark", id: "current" },
        time: { created: 2, completed: 8 },
        timing: {
          startedAt: 2,
          completedAt: 8,
          phases: [{ phase: "generation", startedAt: 3, completedAt: 5 }],
          providerAttempts: [],
        },
        tokens: { input: 10, output: 4, reasoning: 3, cache: { read: 0, write: 0 } },
        content: [
          {
            id: "reasoning_nested",
            type: "reasoning",
            text: "I should inspect the file.",
            time: { created: 3, completed: 4 },
          },
          {
            id: "call_nested",
            type: "tool",
            name: "bash",
            time: { created: 5, ran: 6, completed: 8 },
            state: {
              status: "completed",
              input: { command: "file sample.bin" },
              structured: {},
              content: [],
              outputPaths: [],
              result: "data",
            },
          },
        ],
      },
    ] as unknown as SessionMessage[]
    const host = mount(undefined, { messages: nested, status: { type: "idle" } })

    expect(host.querySelector('[data-slot="native-reasoning"]')).toBeNull()
    expect(host.querySelector('[data-slot="native-turn-receipt"]')).toBeNull()
    ;(host.querySelector('[data-slot="basic-tool-v2-trigger"]') as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))

    const prelude = host.querySelector('[data-slot="native-tool-prelude"]')
    expect(prelude?.querySelector('[data-slot="native-reasoning"]')).not.toBeNull()
    const profiling = prelude?.querySelector('[data-slot="native-turn-profiling"]')
    expect(profiling?.hasAttribute("open")).toBe(false)
    expect(profiling?.querySelector('[data-slot="native-turn-phase"]')?.textContent).toContain("Writing the answer")
  })

  test("shows elapsed and timeout for commands and worker waits", () => {
    const now = Date.now()
    const timedMessages = [
      { id: "msg_user_timed", type: "user", text: "Run both", time: { created: now - 10_000 } },
      {
        id: "msg_assistant_timed",
        type: "assistant",
        agent: "hecate",
        model: { providerID: "spark", id: "current" },
        time: { created: now - 9_000, completed: now - 8_000 },
        content: [
          {
            id: "call_bash",
            type: "tool",
            name: "bash",
            time: { created: now - 8_000, ran: now - 8_000 },
            state: { status: "running", input: { command: "bun test" }, structured: {}, content: [] },
          },
          {
            id: "call_wait",
            type: "tool",
            name: "wait",
            time: { created: now - 7_000, ran: now - 7_000 },
            state: { status: "running", input: { sessionID: "ses_child" }, structured: {}, content: [] },
          },
        ],
      },
    ] as unknown as SessionMessage[]
    const host = mount(undefined, { messages: timedMessages })
    const timings = [...host.querySelectorAll('[data-slot="basic-tool-v2-timing"]')].map((node) => node.textContent)
    expect(timings[0]).toMatch(/^[78]s \/ 120s$/)
    expect(timings[1]).toMatch(/^[67]s \/ 420s$/)
  })

  test("reveals the absolute host path when a file edit is unfolded", async () => {
    const fileMessages = [
      { id: "msg_user_file", type: "user", text: "Update the note", time: { created: 1 } },
      {
        id: "msg_assistant_file",
        type: "assistant",
        agent: "hecate",
        model: { providerID: "spark", id: "current" },
        time: { created: 2, completed: 5 },
        content: [
          {
            id: "call_edit",
            type: "tool",
            name: "edit",
            time: { created: 3, ran: 4, completed: 5 },
            state: {
              status: "completed",
              input: { path: "drafts/browser-printing-wedge.md", oldString: "old", newString: "new" },
              structured: {},
              content: [],
            },
          },
        ],
      },
    ] as unknown as SessionMessage[]
    const host = mount(undefined, { messages: fileMessages, status: { type: "idle" }, directory: "C:\\Nova\\scratch" })
    ;(host.querySelector('[data-slot="basic-tool-v2-trigger"]') as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(host.querySelector('[data-slot="native-tool-path"]')?.textContent).toBe(
      "C:\\Nova\\scratch\\drafts\\browser-printing-wedge.md",
    )
  })

  test("🔴 an unfolded command survives the next agent step", async () => {
    // The bug (owner, 2026-09-18): a command the user opened to inspect folded itself back the moment
    // the agent took another step. The step appends an assistant message, which grows the active
    // turn's body; `stableGroups` can only reuse an UNCHANGED body, so `<For>` (reference-keyed)
    // remounts the whole `Turn`. Expansion lived inside that subtree, so the remount closed it. It
    // now lives above the turn (ToolFoldContext) and survives.
    const step = (id: string, toolID: string, created: number, command: string) =>
      ({
        id,
        type: "assistant",
        agent: "hecate",
        model: { providerID: "spark", id: "current" },
        time: { created, completed: created + 3 },
        content: [
          {
            id: toolID,
            type: "tool",
            name: "bash",
            time: { created: created + 1, ran: created + 2, completed: created + 3 },
            state: {
              status: "completed",
              input: { command },
              structured: {},
              content: [],
              outputPaths: [],
              result: "ok",
            },
          },
        ],
      }) as unknown as SessionMessage
    const [messages, setMessages] = createSignal<SessionMessage[]>([
      { id: "msg_user_step", type: "user", text: "Run the tests", time: { created: 1 } } as unknown as SessionMessage,
      step("msg_step_1", "call_step_1", 2, "bun test"),
    ])
    const host = document.createElement("div")
    document.body.appendChild(host)
    dispose = render(
      () => (
        <MarkedContext.Provider
          value={{ parser: { parse: async (text: string) => text }, resolveFile: () => undefined } as never}
        >
          <NativeTranscript messages={messages()} status={{ type: "idle" } as never} />
        </MarkedContext.Provider>
      ),
      host,
    )
    ;(host.querySelector('[data-slot="basic-tool-v2-trigger"]') as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(host.querySelectorAll('[data-slot="basic-tool-v2-content"]')).toHaveLength(1)

    // Step 2 lands in the same work unit. Without the store this is a fresh `Turn`, so the card the
    // user opened came back closed and `basic-tool-v2-content` went to zero.
    setMessages([...messages(), step("msg_step_2", "call_step_2", 6, "bun run typecheck")])
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(host.querySelectorAll('[data-slot="basic-tool-v2-content"]')).toHaveLength(1)
  })

  test("an unfolded command survives recreating the chat view", async () => {
    const foldStateKey = "native-transcript-remount-fold-state"
    const first = mount(undefined, { messages, status: { type: "idle" }, foldStateKey })
    ;(first.querySelector('[data-slot="basic-tool-v2-trigger"]') as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(first.querySelectorAll('[data-slot="basic-tool-v2-content"]')).toHaveLength(1)

    dispose?.()
    dispose = undefined
    first.remove()

    const reopened = mount(undefined, { messages, status: { type: "idle" }, foldStateKey })
    expect(reopened.querySelectorAll('[data-slot="basic-tool-v2-content"]')).toHaveLength(1)
  })

  test("todowrite is folded by default — the composer dock already carries the list", async () => {
    const todoMessages = [
      { id: "msg_user_todo", type: "user", text: "Plan it", time: { created: 1 } },
      {
        id: "msg_assistant_todo",
        type: "assistant",
        agent: "hecate",
        model: { providerID: "spark", id: "current" },
        time: { created: 2, completed: 5 },
        content: [
          {
            id: "call_todo",
            type: "tool",
            name: "todowrite",
            time: { created: 3, ran: 4, completed: 5 },
            state: {
              status: "completed",
              input: { todos: [{ content: "First", status: "completed" }, { content: "Second", status: "pending" }] },
              structured: {},
              content: [],
              outputPaths: [],
              result: "ok",
            },
          },
        ],
      },
    ] as unknown as SessionMessage[]
    const host = mount(undefined, { messages: todoMessages, status: { type: "idle" } })
    // Folded: the trigger (with its done/total count) shows, the list itself does not.
    expect(host.querySelector('[data-slot="native-todos"]')).toBeNull()
    ;(host.querySelector('[data-slot="basic-tool-v2-trigger"]') as HTMLElement).click()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(host.querySelectorAll('[data-slot="native-todo"]')).toHaveLength(2)
  })

  test("scratch cleanup warnings remain visible as folded notices with preservation instructions", () => {
    const text = 'Scratch cleanup: "C:/scratch/iris/trash-list.txt" lists files older than 3 days. ' +
      "If you still need any of these files, touch them. If you need most of them, delete the ones you don't need " +
      "and then delete trash-list.txt."
    const host = mount(undefined, { messages: [{
      id: "msg_cleanup", type: "user", text: applySteerProvenance(text), time: { created: 1 },
    }] as SessionMessage[], status: { type: "idle" } })
    expect(host.querySelector('[data-slot="native-user"]')).toBeNull()
    const fold = host.querySelector<HTMLDetailsElement>('[data-slot="native-notice"][data-kind="steer"]')!
    expect(fold).not.toBeNull()
    expect(fold.open).toBe(false)
    fold.open = true
    expect(fold.querySelector('[data-slot="native-notice-body"]')!.textContent).toContain(text)
    expect(fold.textContent).not.toContain("not a message from your user")
  })

  test("🔴 a stall notice is FOLDED — the instance is reporting silence, not the user speaking", async () => {
    const noticeMessages = [
      {
        id: "msg_stall_aris_theron_1",
        type: "user",
        text: "The message to theron you sent 31 minutes ago is still unanswered.",
        time: { created: 1 },
      },
    ] as unknown as SessionMessage[]
    const host = mount(undefined, { messages: noticeMessages, status: { type: "idle" } })
    // Folded: no user bubble, a collapsible notice whose body is hidden by default.
    expect(host.querySelector('[data-slot="native-user"]')).toBeNull()
    const details = host.querySelector('[data-slot="native-notice"]') as HTMLDetailsElement | null
    expect(details).not.toBeNull()
    expect(details!.open).toBe(false)
    expect(details!.textContent).toContain("Automated nudge")
    expect(details!.textContent).toContain("still unanswered")
  })
})
