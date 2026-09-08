import { useDialogPortal } from "../../context/dialog-portal"
import { Select as Kobalte } from "@kobalte/core/select"
import { Show, createMemo, onCleanup, splitProps, type ComponentProps, type JSX } from "solid-js"
import { useControlLabel } from "./control-label"

/**
 * ⚠️ **This wraps UNCONDITIONALLY — with no `groupBy` every option lands in one `""` section — and
 * that is the shape v1 `Select`'s postmortem calls the bug it shipped** (`46c13ee3c`, ported from
 * PR #12: *"telling Kobalte to read section children from an `options` key made it treat ordinary
 * entries as sections — so the control rendered EMPTY"*). v1 was given a `selectIsGrouped` predicate
 * so the two props could not disagree; this component never was, and the difference was left
 * unexplained when `select` was retired.
 *
 * **Measured in the browser 2026-08-08, and v2 does NOT have that defect.** Settings → General's
 * language select — no `groupBy` — renders all **18** `[role="option"]` nodes, plus exactly one
 * zero-height `<li role="presentation">` for the anonymous section (its label is suppressed by the
 * `<Show>` in `sectionComponent` below). The mechanism, read out of kobalte 0.13.11: `buildNodes`
 * (`primitives/create-collection/utils.ts`) emits a **FLAT** array — a section node followed by its
 * children as further top-level nodes — and `listbox-root` iterates `[...collection()]`, so a
 * section costs one empty `<li>` and nothing else. Whatever made v1 render empty, it was not this
 * pairing on this version of Kobalte.
 *
 * So do not "fix" this by copying v1's predicate across. If you change it, re-measure the option
 * count in the browser first: the failure it would guard against is invisible to typecheck and to
 * every unit test, which is exactly how it shipped the first time.
 */
function groupOptions<T>(options: readonly T[], groupBy?: (x: T) => string): { category: string; options: T[] }[] {
  if (!groupBy) {
    return [{ category: "", options: [...options] }]
  }
  const map = new Map<string, T[]>()
  for (const opt of options) {
    const key = groupBy(opt)
    const arr = map.get(key)
    if (arr) arr.push(opt)
    else map.set(key, [opt])
  }
  return [...map.entries()].map(([category, opts]) => ({ category, options: opts }))
}

const ChevronDown = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path
      d="M11 9.5L8 6.5L5 9.5"
      stroke="currentColor"
      stroke-width="1"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
)

const CheckSmall = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path
      d="M3.53564 8.17857L6.39279 11.75L12.4642 4.25"
      stroke="currentColor"
      stroke-width="1"
      stroke-linecap="round"
      stroke-linejoin="round"
    />
  </svg>
)

type KobalteRootProps<T> = ComponentProps<typeof Kobalte<T, { category: string; options: T[] }>>

/**
 * Popper geometry, which this component gives an `appearance`-derived default to before handing it
 * on. Split into `local` rather than `root` only so those defaults can be applied.
 */
const POSITIONING_PROPS = ["placement", "gutter", "sameWidth", "flip", "slide", "fitViewport"] as const

/**
 * **The props that belong to the Kobalte ROOT, named exhaustively.** Everything not named here and
 * not one of this component's own props is a **TRIGGER** prop — see the contract note on
 * `SelectV2Props`. Kobalte's root renders a bare `role="group"` wrapper (`select-base.tsx` spreads
 * its leftovers onto a `Polymorphic as="div" role="group"`), so it is the wrong home for anything an
 * author writes to describe the control itself.
 */
const ROOT_PROPS = [
  "open",
  "defaultOpen",
  "modal",
  "preventScroll",
  "forceMount",
  "virtualized",
  "optionDisabled",
  "keyboardDelegate",
  "shouldFocusWrap",
  "disallowTypeAhead",
  "disallowEmptySelection",
  "closeOnSelection",
  "selectionBehavior",
  "allowDuplicateSelectionEvents",
  "name",
  "required",
  "readOnly",
  "validationState",
  "getAnchorRect",
  "shift",
  "overlap",
  "hideWhenDetached",
  "detachedPadding",
  "arrowPadding",
  "overflowPadding",
] as const

/**
 * ## The TRIGGER is this component's element (contract, 2026-08-08)
 *
 * A `SelectV2` renders two elements an author could mean: Kobalte's `role="group"` wrapper, and the
 * trigger the user actually sees and clicks. **The trigger is the one.** `class`/`classList` already
 * landed there; `style`, `data-*`, `aria-*`, `id`, `ref` and DOM event handlers now land there too,
 * because a contract where half of what you write reaches the visible control and half reaches an
 * invisible wrapper is not a contract — it is a coin flip that typechecks either way.
 *
 * ⚠️ **This was not hypothetical.** Before this change every `SelectV2` prop that was not explicitly
 * split went to the ROOT, and eight live call sites were already writing trigger-shaped attributes:
 * `settings-v2/appearance.tsx`, `general.tsx` and `computer.tsx` each pass `data-action="…"` naming
 * the thing a user clicks, and `settings-v2/dialog-model-config.tsx` passes an `aria-label` for the
 * combobox. All nine were landing on the `role="group"` div. The `data-action`s still *looked* right
 * because the wrapper contains only the trigger, so a click at its centre hits the trigger anyway —
 * the `aria-label` did not: it named a group and left the combobox with no accessible name.
 *
 * The v1 `Select` this replaces reached its trigger with a `triggerProps` bag, a `triggerStyle`
 * escape hatch, and `size`/`variant` forwarded to a v1 `Button` it rendered `as={Button}`. **None of
 * those come back** (todo.md ruling 13 — one design system, no compatibility shim). Sizing is
 * `appearance`; everything else is just props on the element, which is what they would have been if
 * the trigger had been treated as the component's element from the start.
 */
export type SelectV2Props<T> = Pick<
  KobalteRootProps<T>,
  (typeof ROOT_PROPS)[number] | (typeof POSITIONING_PROPS)[number]
> &
  // Every name this component defines itself is removed from the div side first, so an
  // intersection can never quietly widen `appearance` back to `string`.
  Omit<
    ComponentProps<"div">,
    "onSelect" | "children" | "appearance" | "placeholder" | "value" | "onChange" | "onInput"
  > & {
    /** Disables the control: Kobalte's root state AND the trigger's own attribute + styling. */
    disabled?: boolean
    placeholder?: string
    options: readonly T[]
    /** Selected option (single selection). */
    current?: T
    value?: (x: T) => string
    label?: (x: T) => string
    groupBy?: (x: T) => string
    onSelect?: (value: T | null) => void
    onHighlight?: (value: T | undefined) => void | (() => void)
    onOpenChange?: (open: boolean) => void
    /** `base` / `large` match text-input-v2; `inline` is a compact chrome-less trigger. */
    appearance?: "base" | "large" | "inline"
    invalid?: boolean
    numeric?: boolean
    children?: (item: T) => JSX.Element
    valueClass?: string
  }

export function SelectV2<T>(props: SelectV2Props<T>) {
  const labelId = useControlLabel()
  const portal = useDialogPortal()
  const [local, root, trigger] = splitProps(
    props,
    [
      "class",
      "classList",
      "placeholder",
      "options",
      "current",
      "value",
      "label",
      "groupBy",
      "onSelect",
      "onHighlight",
      "onOpenChange",
      "children",
      "appearance",
      "invalid",
      "numeric",
      "disabled",
      "valueClass",
      ...POSITIONING_PROPS,
    ],
    [...ROOT_PROPS],
  )

  const inline = () => (local.appearance ?? "base") === "inline"

  const state: { key?: string; cleanup?: void | (() => void) } = {}

  const stop = () => {
    state.cleanup?.()
    state.cleanup = undefined
    state.key = undefined
  }

  const keyFor = (item: T) => (local.value ? local.value(item) : String(item as string))

  const move = (item: T | undefined) => {
    if (!local.onHighlight) return
    if (!item) {
      stop()
      return
    }
    const key = keyFor(item)
    if (state.key === key) return
    state.cleanup?.()
    state.cleanup = local.onHighlight(item)
    state.key = key
  }

  onCleanup(stop)

  const grouped = createMemo(() => groupOptions(local.options, local.groupBy))

  return (
    <Kobalte<T, { category: string; options: T[] }>
      {...root}
      multiple={false}
      disabled={local.disabled}
      data-component="select-v2-root"
      placement={local.placement ?? (inline() ? "bottom-end" : "bottom-start")}
      gutter={local.gutter ?? 4}
      sameWidth={local.sameWidth ?? !inline()}
      flip={local.flip ?? true}
      slide={local.slide ?? true}
      fitViewport={local.fitViewport ?? false}
      value={local.current}
      options={grouped()}
      optionValue={(x) => (local.value ? local.value(x) : String(x as string))}
      optionTextValue={(x) => (local.label ? local.label(x) : String(x as string))}
      optionGroupChildren="options"
      placeholder={local.placeholder}
      sectionComponent={(sectionProps) => (
        <Kobalte.Section>
          <Show when={sectionProps.section.rawValue.category}>
            <div data-slot="menu-v2-group-label">{sectionProps.section.rawValue.category}</div>
          </Show>
        </Kobalte.Section>
      )}
      itemComponent={(itemProps) => (
        <Kobalte.Item
          {...itemProps}
          data-component="menu-v2-item"
          onPointerEnter={() => move(itemProps.item.rawValue)}
          onPointerMove={() => move(itemProps.item.rawValue)}
          onFocus={() => move(itemProps.item.rawValue)}
        >
          <Kobalte.ItemLabel data-slot="menu-v2-item-content" as="span">
            {local.children
              ? local.children(itemProps.item.rawValue)
              : local.label
                ? local.label(itemProps.item.rawValue)
                : String(itemProps.item.rawValue as string)}
          </Kobalte.ItemLabel>
          <Kobalte.ItemIndicator data-slot="menu-v2-item-indicator" forceMount>
            <CheckSmall />
          </Kobalte.ItemIndicator>
        </Kobalte.Item>
      )}
      onChange={(next) => {
        const v = next == null ? null : Array.isArray(next) ? ((next[0] as T) ?? null) : (next as T)
        // ⚠️ Kobalte fires this for its OWN pruning effect, not only for a user's pick. `SelectBase`
        // runs an effect on every change of its option KEYS — "delete selected keys that do not match
        // any option in the listbox" — which calls `setSelectedKeys`, and it defaults
        // `allowDuplicateSelectionEvents` to true, so `onChange` runs even when the selection did not
        // move. A caller whose option array is rebuilt reactively is therefore handed an `onSelect`
        // reporting the selection it already has, and if that handler writes remotely the write's own
        // refetch rebuilds the array and re-enters.
        //
        // Measured on the Affective settings tab, 2026-09-01: one gesture, two config writes, and a
        // clear whose second remove answered 400 to the user. It terminates at two only because
        // TanStack's structural sharing returns the identical object for the unchanged refetch —
        // against a store without it, one switch click produced 10,872 writes.
        //
        // A selection that did not move is not a select. `local.current` still holds the OLD option
        // when a real pick arrives, so this only ever suppresses the echo.
        if ((v == null ? null : keyFor(v)) === (local.current == null ? null : keyFor(local.current))) return
        local.onSelect?.(v)
        stop()
      }}
      onOpenChange={(open) => {
        local.onOpenChange?.(open)
        if (!open) stop()
      }}
    >
      <Kobalte.Trigger
        {...trigger}
        as="div"
        role="button"
        aria-labelledby={trigger["aria-labelledby"] ?? (trigger["aria-label"] ? undefined : labelId)}
        data-component="select-v2"
        data-appearance={local.appearance ?? "base"}
        data-invalid={local.invalid ? "" : undefined}
        data-numeric={local.numeric ? "" : undefined}
        disabled={local.disabled}
        data-disabled={local.disabled ? "" : undefined}
        classList={{
          ...local.classList,
          [local.class ?? ""]: !!local.class,
        }}
      >
        <div data-slot="select-v2-value">
          <Kobalte.Value<T> data-slot="select-v2-value-text" class={local.valueClass}>
            {(st) => {
              const selected = st.selectedOption()
              if (local.label && selected != null) return local.label(selected)
              return selected != null ? (selected as string) : ""
            }}
          </Kobalte.Value>
        </div>
        <span data-slot="select-v2-chevron" aria-hidden="true">
          <ChevronDown />
        </span>
      </Kobalte.Trigger>
      {/* Kobalte's modal boundary must see portalled controls as part of the active layer. */}
      <Kobalte.Portal mount={portal?.()}>
        <Kobalte.Content data-kb-top-layer="" data-component="menu-v2-content" data-slot="select-v2-content">
          <Kobalte.Listbox data-slot="select-v2-listbox" />
        </Kobalte.Content>
      </Kobalte.Portal>
    </Kobalte>
  )
}
