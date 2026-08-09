import { createSignal } from "solid-js"
import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { ButtonV2 } from "@novaclaw/ui/v2/button-v2"
import { useDialog } from "@novaclaw/ui/context/dialog"
import { useLanguage } from "@/context/language"
import { useSettings } from "@/context/settings"

export type Highlight = {
  title: string
  description: string
  media?: {
    type: "image" | "video"
    src: string
    alt?: string
  }
}

export function DialogReleaseNotes(props: { highlights: Highlight[] }) {
  const dialog = useDialog()
  const language = useLanguage()
  const settings = useSettings()
  const [index, setIndex] = createSignal(0)

  const total = () => props.highlights.length
  const last = () => Math.max(0, total() - 1)
  const feature = () => props.highlights[index()] ?? props.highlights[last()]
  const isFirst = () => index() === 0
  const isLast = () => index() >= last()
  const paged = () => total() > 1

  function handleNext() {
    if (isLast()) return
    setIndex(index() + 1)
  }

  function handleClose() {
    dialog.close()
  }

  function handleDisable() {
    settings.general.setReleaseNotes(false)
    handleClose()
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault()
      handleClose()
      return
    }

    if (!paged()) return
    if (e.key === "ArrowLeft" && !isFirst()) {
      e.preventDefault()
      setIndex(index() - 1)
    }
    if (e.key === "ArrowRight" && !isLast()) {
      e.preventDefault()
      setIndex(index() + 1)
    }
  }

  return (
    // `size="content"` is v2's shrink-wrap box, which is what the v1 site was hand-building: it passed
    // `size="large" fit` and then overrode the content's width AND height anyway. Two of those
    // overrides do not survive the move and should not: `-mt-20` slid the content out of the box (v2's
    // container clips, v1's did not), and v2's `content` max-width is 640px, which is the v2 scale
    // this card is now on instead of its bespoke 720px.
    <Dialog size="content" class="w-[min(calc(100vw-64px),640px)] h-[400px] min-h-0">
      <div class="flex flex-1 min-w-0 min-h-0" tabIndex={0} autofocus onKeyDown={handleKeyDown}>
        {/* Left side - Text content */}
        <div class="flex flex-col flex-1 min-w-0 p-8">
          {/* Top section - feature content (fixed position from top) */}
          <div class="flex flex-col gap-2 pt-22">
            <div class="flex items-center gap-2">
              <h1 class="text-16-medium text-text-strong">{feature()?.title ?? ""}</h1>
            </div>
            <p class="text-14-regular text-text-base">{feature()?.description ?? ""}</p>
          </div>

          {/* Spacer to push buttons to bottom */}
          <div class="flex-1" />

          {/* Bottom section - buttons and indicators (fixed position) */}
          <div class="flex flex-col gap-12">
            <div class="flex flex-col items-start gap-3">
              {isLast() ? (
                <ButtonV2 variant="gold" size="large" onClick={handleClose}>
                  {language.t("dialog.releaseNotes.action.getStarted")}
                </ButtonV2>
              ) : (
                <ButtonV2 variant="neutral" size="large" onClick={handleNext}>
                  {language.t("dialog.releaseNotes.action.next")}
                </ButtonV2>
              )}

              <ButtonV2 variant="ghost" size="small" onClick={handleDisable}>
                {language.t("dialog.releaseNotes.action.hideFuture")}
              </ButtonV2>
            </div>

            {paged() && (
              <div class="flex items-center gap-1.5 -my-2.5">
                {props.highlights.map((_, i) => (
                  <button
                    type="button"
                    class="h-6 flex items-center cursor-pointer bg-transparent border-none p-0 transition-all duration-200"
                    classList={{
                      "w-8": i === index(),
                      "w-3": i !== index(),
                    }}
                    onClick={() => setIndex(i)}
                  >
                    <div
                      class="w-full h-0.5 rounded-[1px] transition-colors duration-200"
                      classList={{
                        "bg-icon-strong-base": i === index(),
                        "bg-icon-weak-base": i !== index(),
                      }}
                    />
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right side - Media content (edge to edge) */}
        {feature()?.media && (
          <div class="flex-1 min-w-0 bg-surface-base overflow-hidden">
            {feature()!.media!.type === "image" ? (
              <img
                src={feature()!.media!.src}
                alt={feature()!.media!.alt ?? feature()?.title ?? language.t("dialog.releaseNotes.media.alt")}
                class="w-full h-full object-cover"
              />
            ) : (
              <video src={feature()!.media!.src} autoplay loop muted playsinline class="w-full h-full object-cover" />
            )}
          </div>
        )}
      </div>
    </Dialog>
  )
}
