import { createSignal, Show, type JSX } from "solid-js"
import { Popover as KobaltePopover } from "@kobalte/core/popover"
import { Button } from "@novaclaw/ui/button"
import { TextInputV2 } from "@novaclaw/ui/v2/text-input-v2"
import { TooltipV2 } from "@novaclaw/ui/v2/tooltip-v2"
import { useLanguage } from "@/context/language"

export type ComposerStrictControlState = {
  current: { enabled?: boolean; attempts?: number; wallMinutes?: number }
  permissionBelowFloor: boolean
  style: JSX.CSSProperties | undefined
  set: (value: { enabled: boolean; attempts?: number; wallMinutes?: number }) => void
  onClose: () => void
}

/**
 * The per-chat Strict switch (jh.md): OFF → click opens a small ask — how many agents race and the
 * time budget — then enables; ON → click turns it off directly. Enabling also raises the permission
 * mode to Bypass (the harness's autonomous floor) — the popover says so before the user commits.
 */
export function ComposerStrictControl(props: { state: ComposerStrictControlState }) {
  const language = useLanguage()
  const [open, setOpen] = createSignal(false)
  const [attempts, setAttempts] = createSignal("")
  const [wall, setWall] = createSignal("")
  const enabled = () => props.state.current.enabled === true
  const close = () => {
    setOpen(false)
    props.state.onClose()
  }
  const enable = () => {
    const racers = Number.parseInt(attempts(), 10)
    const minutes = Number.parseInt(wall(), 10)
    props.state.set({
      enabled: true,
      attempts: Number.isFinite(racers) && racers > 1 ? Math.min(racers, 8) : undefined,
      wallMinutes: Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, 480) : undefined,
    })
    close()
  }
  return (
    <KobaltePopover
      open={open()}
      onOpenChange={(next) => {
        if (next && enabled()) {
          // A click on an armed switch just turns Strict off — nothing to ask.
          props.state.set({ enabled: false })
          props.state.onClose()
          return
        }
        if (next) {
          setAttempts(
            props.state.current.attempts && props.state.current.attempts > 1
              ? String(props.state.current.attempts)
              : "",
          )
          setWall(props.state.current.wallMinutes ? String(props.state.current.wallMinutes) : "")
        }
        setOpen(next)
      }}
      modal={false}
      placement="top-start"
      gutter={4}
    >
      <TooltipV2 placement="top" gutter={4} value={language.t("prompt.strict.tooltip")}>
        <KobaltePopover.Trigger
          type="button"
          data-action="prompt-strict"
          data-enabled={enabled() ? "true" : undefined}
          class="flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] font-[440] leading-5 hover:bg-v2-background-bg-subtle"
          classList={{
            "text-v2-text-text-faint": !enabled(),
            "text-v2-text-text-base": enabled(),
          }}
          style={props.state.style}
        >
          <span>{language.t(enabled() ? "prompt.strict.on" : "prompt.strict.off")}</span>
        </KobaltePopover.Trigger>
      </TooltipV2>
      <KobaltePopover.Portal>
        <KobaltePopover.Content
          data-component="prompt-strict-popover"
          class="w-80 flex flex-col gap-3 p-4 rounded-md border border-border-base bg-surface-raised-stronger-non-alpha shadow-md z-50 outline-none"
          onEscapeKeyDown={(event) => {
            event.preventDefault()
            event.stopPropagation()
            close()
          }}
          onPointerDownOutside={() => setOpen(false)}
        >
          <div class="flex flex-col gap-1">
            <span class="text-[13px] font-[560] text-v2-text-text-base">
              {language.t("prompt.strict.popover.title")}
            </span>
            <span class="text-[12px] leading-4 text-v2-text-text-faint">
              {language.t("prompt.strict.popover.description")}
            </span>
          </div>
          <label class="flex items-center justify-between gap-3">
            <span class="text-[13px] text-v2-text-text-base">{language.t("prompt.strict.popover.attempts")}</span>
            <div class="w-[90px]">
              {/* TextInputV2 carries a fixed 280px default width — force it into the row's sizer
                  or it overflows the w-80 popover (same !w-full override the settings forms use). */}
              <TextInputV2
                type="number"
                appearance="base"
                class="!w-full"
                min="1"
                max="8"
                step="1"
                placeholder="1"
                value={attempts()}
                onInput={(event) => setAttempts(event.currentTarget.value)}
                aria-label={language.t("prompt.strict.popover.attempts")}
              />
            </div>
          </label>
          <label class="flex items-center justify-between gap-3">
            <span class="text-[13px] text-v2-text-text-base">{language.t("prompt.strict.popover.wallMinutes")}</span>
            <div class="w-[90px]">
              <TextInputV2
                type="number"
                appearance="base"
                class="!w-full"
                min="1"
                max="480"
                step="1"
                placeholder="45"
                value={wall()}
                onInput={(event) => setWall(event.currentTarget.value)}
                aria-label={language.t("prompt.strict.popover.wallMinutes")}
              />
            </div>
          </label>
          <Show when={props.state.permissionBelowFloor}>
            <span class="text-[12px] leading-4 text-v2-text-text-faint">
              {language.t("prompt.strict.popover.bypassNote")}
            </span>
          </Show>
          <div class="flex items-center justify-end gap-2">
            <Button variant="ghost" type="button" onClick={close}>
              {language.t("common.cancel")}
            </Button>
            <Button variant="primary" type="button" data-action="prompt-strict-enable" onClick={enable}>
              {language.t("prompt.strict.popover.enable")}
            </Button>
          </div>
        </KobaltePopover.Content>
      </KobaltePopover.Portal>
    </KobaltePopover>
  )
}
