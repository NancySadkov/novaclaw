import { expect, test } from "bun:test"
import { catchError, createMemo, createResource, createRoot, createSignal } from "solid-js"

// contacts.tsx renders:
//   <Show when={shown().length > 0} fallback={ …agents.error ? t("contacts.loadFailed") : … }>
// `shown()` -> `searchRoster(views(), …)` -> `views()` -> `(agents() ?? [])`.
// Question: when listAgents REJECTS, does the fallback get to run, or does the read blow up first?
test("an errored agents resource reaches the boundary, not the loadFailed fallback", async () => {
  const seen: string[] = []
  await new Promise<void>((resolve) => {
    createRoot((dispose) => {
      catchError(
        () => {
          const [src] = createSignal(1)
          const [agents] = createResource(src, async () => {
            throw new Error("listAgents failed")
          })
          const views = createMemo(() => (agents() ?? []) as unknown[])
          const shown = createMemo(() => views())
          setTimeout(() => {
            // exactly what the JSX guard evaluates
            try {
              const on = shown().length > 0
              seen.push(`guard:${on}`)
            } catch (e) {
              seen.push(`guard threw: ${(e as Error).constructor.name}`)
            }
            // and what the fallback would have said, had it been reached
            seen.push(`resource.error=${agents.error instanceof Error}`)
            resolve()
            dispose()
          }, 20)
        },
        (err) => seen.push(`boundary: ${(err as Error).message}`),
      )
    })
  })
  console.log(seen)
  expect(seen[0]).toBe("boundary: listAgents failed")
  // the guard never produced a boolean — the fallback branch is unreachable
  expect(seen.some((s) => s.startsWith("guard:"))).toBe(false)
})
