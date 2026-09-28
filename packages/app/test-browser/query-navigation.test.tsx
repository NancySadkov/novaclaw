import { expect, test } from "bun:test"
import { createSignal, Show, startTransition, Suspense } from "solid-js"
import { render } from "solid-js/web"
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query"
import { useQuery } from "@/utils/query"
import { sessionExecutions } from "@/utils/session-execution-api"

test("pending queries let navigation finish and render their eventual result", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let release!: (value: string) => void
  let navigate!: () => Promise<void>
  const Page = () => {
    const [destination, setDestination] = createSignal("Home")
    const query = useQuery(() => ({
      queryKey: [destination()],
      queryFn: () =>
        new Promise<string>((resolve) => {
          release = resolve
        }),
    }))
    navigate = () =>
      startTransition(() => {
        setDestination("Officer")
      })
    return (
      <>
        {destination()}:{query.data ?? "pending"}
      </>
    )
  }
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <Suspense fallback="Blocked">
          <Page />
        </Suspense>
      </QueryClientProvider>
    ),
    host,
  )
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(host.textContent).toBe("Home:pending")
    let completed = false
    void navigate().then(() => {
      completed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(completed).toBe(true)
    expect(host.textContent).toBe("Officer:pending")
    release("ready")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(host.textContent).toBe("Officer:ready")
  } finally {
    dispose()
    client.clear()
    host.remove()
  }
})

test("leaving a session aborts its outstanding execution request", async () => {
  const host = document.createElement("div")
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const originalFetch = globalThis.fetch
  let requestSignal: AbortSignal | undefined
  let leave!: () => void
  globalThis.fetch = ((_input: unknown, init?: RequestInit) => {
    requestSignal = init?.signal ?? undefined
    return new Promise<Response>((_resolve, reject) => {
      requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true })
    })
  }) as typeof fetch
  const Session = () => {
    const query = useQuery(() => ({
      queryKey: ["execution"],
      queryFn: ({ signal }) => sessionExecutions({ url: "http://test.invalid" }, "ses_test", signal),
    }))
    return <span>{query.data?.length ?? "pending"}</span>
  }
  const Page = () => {
    const [open, setOpen] = createSignal(true)
    leave = () => setOpen(false)
    return (
      <Show when={open()}>
        <Session />
      </Show>
    )
  }
  const dispose = render(
    () => (
      <QueryClientProvider client={client}>
        <Page />
      </QueryClientProvider>
    ),
    host,
  )
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requestSignal?.aborted).toBe(false)
    leave()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(requestSignal?.aborted).toBe(true)
  } finally {
    dispose()
    client.clear()
    globalThis.fetch = originalFetch
  }
})
