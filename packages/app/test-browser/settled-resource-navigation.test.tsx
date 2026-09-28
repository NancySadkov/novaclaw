import { expect, test } from "bun:test"
import { createSignal, Show, startTransition, Suspense } from "solid-js"
import { render } from "solid-js/web"
import { createSettledResource } from "@/utils/settled-resource"

test("refreshing background data cannot hold an unrelated navigation transition", async () => {
  const host = document.createElement("div")
  document.body.append(host)
  let release!: (value: string) => void
  let navigate!: () => Promise<void>
  let reads = 0
  const Page = () => {
    const [destination, setDestination] = createSignal("Home")
    const [value, actions] = createSettledResource(
      () => true,
      () => {
        if (++reads === 1) return Promise.resolve("cached")
        return new Promise<string>((resolve) => {
          release = resolve
        })
      },
    )
    navigate = () =>
      startTransition(() => {
        void actions.refetch()
        setDestination("Officers")
      })
    return (
      <>
        <span>{destination()}</span>
        <span>{value()}</span>
      </>
    )
  }
  const dispose = render(
    () => (
      <Suspense fallback="Waiting">
        <Page />
      </Suspense>
    ),
    host,
  )
  try {
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(host.textContent).toBe("Homecached")
    let completed = false
    void navigate().then(() => {
      completed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(host.textContent).toBe("Officerscached")
    expect(completed).toBe(true)
    release("updated")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(host.textContent).toBe("Officersupdated")
  } finally {
    release?.("done")
    dispose()
    host.remove()
  }
})

test("a cold status read neither blocks navigation nor survives its view", async () => {
  const host = document.createElement("div")
  let signal: AbortSignal | undefined
  let navigate!: () => Promise<void>
  let leave!: () => Promise<void>
  const Status = () => {
    const [status] = createSettledResource(
      () => true,
      (_source, info): Promise<string> => {
        signal = info.signal
        return new Promise<string>((_resolve, reject) => {
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true })
        })
      },
    )
    return <span>Home:{status() ?? "unknown"}</span>
  }
  const Page = () => {
    const [home, setHome] = createSignal(false)
    navigate = () =>
      startTransition(() => {
        setHome(true)
      })
    leave = () =>
      startTransition(() => {
        setHome(false)
      })
    return (
      <Show when={home()} fallback="Officer">
        <Status />
      </Show>
    )
  }
  const dispose = render(
    () => (
      <Suspense fallback="Blocked">
        <Page />
      </Suspense>
    ),
    host,
  )
  try {
    let completed = false
    void navigate().then(() => {
      completed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(completed).toBe(true)
    expect(host.textContent).toBe("Home:unknown")
    expect(signal?.aborted).toBe(false)
    await leave()
    expect(signal?.aborted).toBe(true)
    expect(host.textContent).toBe("Officer")
  } finally {
    dispose()
  }
})
