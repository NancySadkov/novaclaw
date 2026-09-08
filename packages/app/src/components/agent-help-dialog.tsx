import { Dialog } from "@novaclaw/ui/v2/dialog-v2"
import { Icon } from "@novaclaw/ui/v2/icon"
import { useLanguage } from "@/context/language"

/**
 * HOW COLLEAGUES WORK — the explanation, in one place, on demand.
 *
 * 🔴 **This exists so the configuration screen does not have to teach** (owner, 2026-08-28: *"all such
 * descriptions and trivia should be moved to the Help button, which spawns another dialogue explaining
 * how agents work"*). The Tune dialog used to carry a paragraph under most controls — what memory is,
 * what a project folder does, what survives a rename — and the effect was the opposite of teaching:
 * the controls became hard to find among the prose, and the owner reported the folder picker as
 * MISSING when it had been on screen all along.
 *
 * ⚠️ **Removing that copy without rehoming it would have been a different mistake.** The product's
 * mission is educational (AGENTS.md — *"NovaClaw teaches as it works"*), and principle 8 says pick the
 * option a curious non-expert learns from. So the material is not deleted, it is moved behind one
 * button, where somebody who wants it asks once and reads it all — rather than everybody re-reading
 * fragments of it on every visit. That is uix.md §1.4's rule at the scale of a screen instead of a row.
 *
 * It deliberately explains the MODEL — what a colleague is, what it keeps, what it works on — and not
 * this dialog's field list. A help page that narrates the form goes stale the day a control moves; one
 * that explains the ideas is still true afterwards.
 */
export function AgentHelpDialog(props: { onDismiss: () => void }) {
  const language = useLanguage()
  const sections = ["colleague", "memory", "project", "model", "chat"] as const
  return (
    <Dialog size="full">
      <div class="flex h-full w-full flex-col overflow-hidden bg-v2-background-bg-base text-v2-text-text-base">
        <div class="flex items-center gap-3 border-b border-v2-border-border-base px-4 py-3">
          <button
            type="button"
            class="shrink-0 rounded-md p-1.5 text-v2-text-text-faint hover:bg-v2-background-bg-layer-03 hover:text-v2-text-text-base"
            aria-label={language.t("agentHelp.back")}
            title={language.t("agentHelp.back")}
            onClick={props.onDismiss}
          >
            <Icon name="chevron-left" size="normal" />
          </button>
          <span class="min-w-0 flex-1 truncate text-sm font-semibold">{language.t("agentHelp.title")}</span>
          <button type="button" class="text-xs text-v2-text-text-muted hover:underline" onClick={props.onDismiss}>
            {language.t("agentHelp.close")}
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div class="mx-auto flex max-w-[60ch] flex-col gap-5">
            {sections.map((key) => (
              <section>
                <h3 class="text-xs font-semibold uppercase tracking-wide text-v2-text-text-muted">
                  {language.t(`agentHelp.${key}.title`)}
                </h3>
                <p class="mt-1.5 text-[13px] leading-5 text-v2-text-text-base">
                  {language.t(`agentHelp.${key}.body`)}
                </p>
              </section>
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  )
}
