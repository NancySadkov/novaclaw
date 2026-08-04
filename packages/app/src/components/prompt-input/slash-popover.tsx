import { Component, For, Match, Show, Switch } from "solid-js"
import { FileIcon } from "@novaclaw/ui/file-icon"
import { Icon } from "@novaclaw/ui/icon"
import { Tag } from "@novaclaw/ui/v2/badge-v2"
import { KeybindV2 } from "@novaclaw/ui/v2/keybind-v2"
import { getDirectory, getFilename } from "@novaclaw/core/util/path"
import type { Translator } from "@/context/language"

export type AtOption =
  | { type: "agent"; name: string; display: string }
  | { type: "file"; path: string; display: string; recent?: boolean }

export interface SlashCommand {
  id: string
  trigger: string
  title: string
  description?: string
  keybind?: string
  type: "builtin" | "custom"
  source?: "command" | "mcp" | "skill"
}

type PromptPopoverProps = {
  popover: "at" | "slash" | null
  setSlashPopoverRef: (el: HTMLDivElement) => void
  atFlat: AtOption[]
  atError?: unknown
  onAtRetry: () => void
  atActive?: string
  atKey: (item: AtOption) => string
  setAtActive: (id: string) => void
  onAtSelect: (item: AtOption) => void
  slashFlat: SlashCommand[]
  slashActive?: string
  setSlashActive: (id: string) => void
  onSlashSelect: (item: SlashCommand) => void
  commandKeybindParts: (id: string) => string[]
  t: Translator
}

const ROW_TEXT = "text-[13px] leading-[calc(var(--font-size-base)*1.8)] tracking-[-0.04px] [font-weight:440]"

export const PromptPopover: Component<PromptPopoverProps> = (props) => {
  return (
    <Show when={props.popover}>
      <div
        ref={(el) => {
          if (props.popover === "slash") props.setSlashPopoverRef(el)
        }}
        class="absolute inset-x-0 -top-2 -translate-y-full origin-bottom-left max-h-80 min-h-10
                 overflow-auto no-scrollbar flex flex-col p-2 z-[70] rounded-[10px] bg-v2-background-bg-base
                 shadow-[var(--v2-elevation-raised)]"
        onMouseDown={(e) => e.preventDefault()}
      >
        <Switch>
          <Match when={props.popover === "at"}>
            <Show
              when={!props.atError}
              fallback={
                <div class="flex items-center justify-between gap-3 px-2 py-1 text-v2-text-text-muted">
                  <span>{props.t("prompt.popover.searchError")}</span>
                  <button type="button" class="shrink-0 text-v2-text-text-base" onClick={props.onAtRetry}>
                    {props.t("prompt.popover.searchRetry")}
                  </button>
                </div>
              }
            >
              <Show
                when={props.atFlat.length > 0}
                fallback={<div class="px-2 py-1 text-v2-text-text-muted">{props.t("prompt.popover.emptyResults")}</div>}
              >
                <For each={props.atFlat.slice(0, 10)}>
                  {(item) => {
                    const key = props.atKey(item)

                    if (item.type === "agent") {
                      return (
                        <button
                          class="w-full flex items-center gap-x-2 px-2 py-0.5 rounded-[4px]"
                          classList={{
                            "bg-v2-overlay-simple-overlay-hover": props.atActive === key,
                          }}
                          onClick={() => props.onAtSelect(item)}
                          onPointerMove={() => props.setAtActive(key)}
                        >
                          <Icon name="brain" size="small" class="text-icon-info-active shrink-0" />
                          <span class={`whitespace-nowrap text-v2-text-text-base ${ROW_TEXT}`}>@{item.name}</span>
                        </button>
                      )
                    }

                    const isDirectory = item.path.endsWith("/")
                    const directory = isDirectory ? item.path : getDirectory(item.path)
                    const filename = isDirectory ? "" : getFilename(item.path)

                    return (
                      <button
                        class="w-full flex items-center gap-x-2 px-2 py-0.5 rounded-[4px]"
                        classList={{
                          "bg-v2-overlay-simple-overlay-hover": props.atActive === key,
                        }}
                        onClick={() => props.onAtSelect(item)}
                        onPointerMove={() => props.setAtActive(key)}
                      >
                        <FileIcon node={{ path: item.path, type: "file" }} class="shrink-0 size-4" />
                        <div class={`flex items-center min-w-0 ${ROW_TEXT}`}>
                          <span class="whitespace-nowrap truncate min-w-0 text-v2-text-text-muted">{directory}</span>
                          <Show when={!isDirectory}>
                            <span class="whitespace-nowrap text-v2-text-text-base">{filename}</span>
                          </Show>
                        </div>
                      </button>
                    )
                  }}
                </For>
              </Show>
            </Show>
          </Match>
          <Match when={props.popover === "slash"}>
            <Show
              when={props.slashFlat.length > 0}
              fallback={<div class="px-2 py-1 text-v2-text-text-muted">{props.t("prompt.popover.emptyCommands")}</div>}
            >
              <For each={props.slashFlat}>
                {(cmd) => {
                  const keybindParts = () => props.commandKeybindParts(cmd.id)
                  return (
                    <button
                      data-slash-id={cmd.id}
                      classList={{
                        "w-full flex items-center justify-between gap-4 px-2 py-1 rounded-[4px] scroll-my-2": true,
                        "bg-v2-overlay-simple-overlay-hover": props.slashActive === cmd.id,
                      }}
                      onClick={() => props.onSlashSelect(cmd)}
                      onPointerMove={() => props.setSlashActive(cmd.id)}
                    >
                      <div class="flex items-center gap-2 min-w-0">
                        <span class={`whitespace-nowrap text-v2-text-text-base ${ROW_TEXT}`}>/{cmd.trigger}</span>
                        <Show when={cmd.description}>
                          <span class={`truncate text-v2-text-text-muted ${ROW_TEXT}`}>{cmd.description}</span>
                        </Show>
                      </div>
                      <div class="flex items-center gap-2 shrink-0">
                        <Show when={cmd.type === "custom" && cmd.source !== "command"}>
                          <Tag>
                            {cmd.source === "skill"
                              ? props.t("prompt.slash.badge.skill")
                              : cmd.source === "mcp"
                                ? props.t("prompt.slash.badge.mcp")
                                : props.t("prompt.slash.badge.custom")}
                          </Tag>
                        </Show>
                        <Show when={keybindParts().length > 0}>
                          <KeybindV2 keys={keybindParts()} variant="neutral" />
                        </Show>
                      </div>
                    </button>
                  )
                }}
              </For>
            </Show>
          </Match>
        </Switch>
      </div>
    </Show>
  )
}
