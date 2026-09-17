import { createSignal, onCleanup, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { formatElapsed } from "@/utils/elapsed"

/**
 * A live "Running for 3m 12s" label for one activity row.
 *
 * One 1 Hz clock per row: the figure is read, not counted, so a faster tick would only spend
 * frames. Renders nothing when the row carries no start time, so an older row degrades to its
 * owner line instead of inventing an epoch-long duration.
 */
export function RunningFor(props: { startedAt: number | undefined }) {
  const language = useLanguage()
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(timer))

  return (
    <Show when={typeof props.startedAt === "number" && Number.isFinite(props.startedAt) ? props.startedAt : undefined}>
      {(startedAt) => (
        <span>{language.t("session.activity.runningFor", { elapsed: formatElapsed(startedAt(), now()) })}</span>
      )}
    </Show>
  )
}
