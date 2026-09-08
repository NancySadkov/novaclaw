import type { PermissionActions } from "@novaclaw/core/permission-actions"
import type { TranslationKey } from "@/context/language"

/**
 * The i18n key that names each permission action in words.
 *
 * 🔴 **A table, not a template, and that is the whole design.** The obvious spelling is
 * `dynamicKey(`settings.permissions.tool.${action}.title`)` — one line instead of thirty-five. It is
 * also an unchecked key, and `i18n/key-typing.test.ts` is a shrink-only ledger of exactly those with
 * one instruction: *narrow the source*. It has a precedent to follow, too — `theme-swatches.tsx` left
 * that ledger the same way, by typing its source rather than by earning a line in it.
 *
 * ⭐ **Written out, the table does something the template cannot: a new action fails to COMPILE.**
 * `satisfies Record<PermissionActions.Action, TranslationKey>` is exhaustive over the closed action
 * union, so adding a gate without a label is a type error at the moment it is added, not a raw verb
 * a user meets in a dropdown six weeks later. That is not hypothetical — twenty-two of thirty-five
 * actions had reached this state by 2026-09-04, every one of them added after the original file
 * tools were labelled.
 *
 * ⚠️ It is keyed on the ACTION UNION, never on `PermissionActions.ALL`, which is annotated
 * `readonly string[]` on purpose: its consumers compare it against free text (an MCP tool's action
 * is the remote tool's own name). The union is the closed half; the array is the open one.
 *
 * The reverse direction — a label whose action no longer exists — cannot be a type error, because a
 * removed action simply removes a requirement. `permission-action-labels.test.ts` pins that half,
 * along with every title having its description and no label being blank.
 */
export const ACTION_LABEL_KEY = {
  bash: "settings.permissions.tool.bash.title",
  chat_upgrade: "settings.permissions.tool.chat_upgrade.title",
  colleague: "settings.permissions.tool.colleague.title",
  community_ask: "settings.permissions.tool.community_ask.title",
  community_say: "settings.permissions.tool.community_say.title",
  computer: "settings.permissions.tool.computer.title",
  create: "settings.permissions.tool.create.title",
  define_tool: "settings.permissions.tool.define_tool.title",
  edit: "settings.permissions.tool.edit.title",
  explore: "settings.permissions.tool.explore.title",
  external_directory_read: "settings.permissions.tool.external_directory_read.title",
  external_directory_write: "settings.permissions.tool.external_directory_write.title",
  js: "settings.permissions.tool.js.title",
  kb: "settings.permissions.tool.kb.title",
  "messenger.connect": "settings.permissions.tool.messenger.connect.title",
  "messenger.initiate": "settings.permissions.tool.messenger.initiate.title",
  "messenger.moderate": "settings.permissions.tool.messenger.moderate.title",
  "messenger.send": "settings.permissions.tool.messenger.send.title",
  plan_enter: "settings.permissions.tool.plan_enter.title",
  plan_exit: "settings.permissions.tool.plan_exit.title",
  provision: "settings.permissions.tool.provision.title",
  read: "settings.permissions.tool.read.title",
  recipe: "settings.permissions.tool.recipe.title",
  "register-app": "settings.permissions.tool.register-app.title",
  resource_status: "settings.permissions.tool.resource_status.title",
  revert: "settings.permissions.tool.revert.title",
  skill: "settings.permissions.tool.skill.title",
  spawn: "settings.permissions.tool.spawn.title",
  task: "settings.permissions.tool.task.title",
  todowrite: "settings.permissions.tool.todowrite.title",
  trash: "settings.permissions.tool.trash.title",
  wait: "settings.permissions.tool.wait.title",
  webfetch: "settings.permissions.tool.webfetch.title",
  websearch: "settings.permissions.tool.websearch.title",
  write: "settings.permissions.tool.write.title",
} satisfies Record<PermissionActions.Action, TranslationKey>
