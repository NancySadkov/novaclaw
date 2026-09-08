export const dict = {
  "files.title": "Files",
  "files.up": "Up",
  "files.askAiFolder": "Ask AI about this folder",
  "files.askAiFile": "Ask AI about this file",
  "files.loading": "Loading…",
  "files.cantRead": "Can't read this location",
  "files.empty": "Empty folder",
  "files.selectHint": "Select a file to preview",
  "files.binary": "This file can't be previewed:",
  "files.truncated": "truncated",
  "files.delete": "Delete (to Trash)",
  // Downloading from the browser — the point of browsing a colleague's workspace when the colleague
  // is on another machine.
  "files.download": "Download",
  "files.newFolder": "New folder",
  "files.newFolderTitle": "Create a new folder",
  "files.createFolder": "Create folder",
  "files.rename": "Rename",
  "files.renameTitle": 'Rename "{{name}}"',
  "files.deleteTitle": 'Move "{{name}}" to Trash?',
  "files.deleteDescription": "It will remain restorable from Trash for the configured retention period.",
  "files.operationFailed": "Couldn’t change this item",
  "files.nameError.empty": "Enter a name.",
  "files.nameError.reserved": "That name is reserved by the filesystem.",
  "files.nameError.separator": "Enter one name, without slashes.",
  "files.nameError.exists": "That name already exists here. Choose another name.",
  "files.trash": "Trash",
  "files.showHidden": "Hidden files",
  "files.trashHint": "You can restore it for about {{days}} days",
  "files.trashEmpty": "Trash is empty.",
  "files.trashLoadFailed": "Could not read the Trash — this is not an empty Trash.",
  "files.restore": "Restore",
  "files.drives": "Drives",
  "files.restoreFailed": "Couldn’t restore",

  // ─────────────────────────────────────────────────────────────────────────────────────────────
  // The Project a folder's `novaclaw.json` declares, said in Chats and in Files.
  //
  // The rule: *"never make a person infer project state from a hidden dotfile."* Settings
  // → General and the composer's Tune panel already say it; these two blocks are the same facts
  // written for the two surfaces a person is actually looking at when the question comes up.
  // `components/project-summary.ts` is the only reader, and `project-summary.test.ts` pins that
  // every key it can ask for is here.
  //
  // ⚠️ Two blocks rather than one shared prefix, because the sentences differ: Files is talking
  // about the folder on screen, Chats about the folder a chat is running in. What they must NOT
  // duplicate is a remedy — "update NovaClaw" versus "fix your file" comes from
  // `settings.project.invalid*` in both, so the three surfaces can never disagree about which one
  // a user should take.
  //
  // ⚠️ ENGLISH-ONLY on purpose, like the Settings → Project rows: the parity ratchet fails on an
  // EXTRA key in a locale and only COUNTS a missing one, so pasting English into de.ts et al. would
  // make the translation backlog read as done. Translate properly or leave the key out.
  "files.project.label.project": "Project",
  "files.project.label.plain": "Folder",
  "files.project.label.invalid": "Project not applied",
  "files.project.what":
    "A Project is simply a folder with a novaclaw.json file in it. That one file gives every chat you start in the folder the same starting settings and the same limits on what the agent may do.",
  "files.project.named": "This folder belongs to the Project “{{name}}”.",
  "files.project.unnamed": "This folder belongs to a Project.",
  "files.project.plain":
    "This folder is not a Project. Chats you start here use your normal settings — that is a perfectly good way to work.",
  "files.project.unusable":
    "This folder has a novaclaw.json, and it could not be used — so nothing in it is in force and chats here are running on your normal settings.",
  "files.project.rules":
    "{{count}} permission rules come from this file. A Project can only narrow what the agent may do, never widen it.",
  "files.project.rulesOne":
    "One permission rule comes from this file. A Project can only narrow what the agent may do, never widen it.",
  "files.project.rulesNone": "It changes no permissions.",
  "files.project.exclude": "It asks Nova not to read: {{list}}",
  "files.project.details": "What this folder's project file does",
  "chat.project.label.project": "Project",
  "chat.project.label.plain": "Folder",
  "chat.project.label.invalid": "Project not applied",
  "chat.project.what":
    "A Project is simply a folder with a novaclaw.json file in it. That one file gives every chat in the folder the same starting settings and the same limits on what the agent may do.",
  "chat.project.named": "This chat runs in the Project “{{name}}”.",
  "chat.project.unnamed": "This chat runs in a Project folder.",
  "chat.project.plain":
    "This chat's folder is not a Project. It uses your normal settings — that is a perfectly good way to work.",
  "chat.project.unusable":
    "This chat's folder has a novaclaw.json, and it could not be used — so nothing in it is in force and this chat is running on your normal settings.",
  "chat.project.rules":
    "{{count}} permission rules come from this file. A Project can only narrow what the agent may do, never widen it.",
  "chat.project.rulesOne":
    "One permission rule comes from this file. A Project can only narrow what the agent may do, never widen it.",
  "chat.project.rulesNone": "It changes no permissions.",
  "chat.project.exclude": "It asks Nova not to read: {{list}}",
  "chat.project.tune": "Tune, under the message box, lists the settings it handed to this chat.",
  // ─────────────────────────────────────────────────────────────────────────────────────────────
  "notes.title": "Notes",
  "notes.hint": "Shared with your agents — any chat can read them or add to them.",
  "notes.new": "New note",
  "notes.namePlaceholder": "note name…",
  "notes.placeholder": "Write anything — phone numbers, sites, birthdays…",
  "notes.loading": "Loading…",
  "notes.empty": "No notes yet",
  "notes.readFailed": "Could not read this note. Try again to continue editing.",
  "notes.loadFailed": "Could not read your notes. This is not an empty folder — the list did not arrive.",
  "notes.saving": "Saving…",
  "notes.saved": "Saved",
  "notes.saveFailed": "Couldn’t save",
  "trash.title": "Trash",
  "trash.hint": "Safe-deleted files — restorable for about {{days}} days, from any folder.",
  "trash.refresh": "Refresh",
  "trash.loading": "Loading…",
  "trash.empty": "Trash is empty.",
  // ⚠️ Deliberately NOT a variation on "Trash is empty." Those were the same sentence for years, and
  // on this screen the difference decides whether someone believes a deleted file is gone.
  "trash.loadFailed": "Could not read the Trash. This is not an empty Trash — the list did not arrive.",
  "trash.restore": "Restore",
  "trash.restoreFailed": "Couldn’t restore",
  "trash.expiresIn": "expires in",
  "trash.expiresUnderHour": "expires within the hour",
  "trash.expiringNow": "expiring now",

  // Processes — the friendly "what your agents are doing" activity view (uix.md §6.4 / SP1).
  "nav.tasks.untitled": "Untitled chat",
  "nav.tasks.all": "All Officers",
  "nav.tasks.close": "Close this task",
  "processes.status.working": "Working…",

  // Session presence — who else is looking at this chat, who is driving, and what to do when two
  // surfaces reach for it at once. Every line here has to read as an explanation, not a fault:
  // two people in one chat is a normal thing that happens, and the UI teaches it (principle 8).
  "presence.viewer.browser": "a browser window",
  "presence.viewer.desktop": "the desktop app",
  "presence.watching": "{{driver}} is driving this chat. You're watching along — you can still type.",
  "presence.driving": "{{others}} is here too, watching along. You're driving.",
  // These three name who is ACTUALLY writing. A room is contended as soon as anyone who is not
  // driving has a draft, so a single "you and X are both writing" line told the driver they were
  // writing when they were not — found by opening two windows, not by a test.
  "presence.contended.driving": "{{writers}} is writing here too. You're driving — whoever sends first goes first.",
  "presence.contended.youWriting": "You're writing while {{driver}} drives this chat. Whoever sends first goes first.",
  "presence.contended.otherWriting":
    "{{writers}} is writing here, and {{driver}} is driving. Whoever sends first goes first.",
  "presence.takeOver": "Take over",
  // Short on purpose: the line beside this one already says who is driving, so a handoff notice
  // that repeats it reads as a stutter ("You're driving. You're driving now.") — seen in the app.
  "presence.handoff.youTookOver": "You took over.",
  "presence.handoff.otherTookOver": "{{who}} took over.",
  "presence.handoff.youInherited": "{{who}} left, so you're driving now.",
  "presence.handoff.otherInherited": "{{who}} is driving now.",

  // Expertise levels — progressive disclosure with consent (uix.md §6).
  "settings.expertise.title": "Experience level",
  "settings.expertise.description": "Choose how much of NovaClaw you want to see. You can change this anytime.",
  "settings.expertise.change": "Change…",
  "settings.expertise.current": "Current",
  "settings.expertise.cancel": "Cancel",
  "settings.expertise.level.normal.name": "Normal",
  "settings.expertise.level.normal.blurb":
    "The essentials — chat with your agents, keep notes and files, connect models. The recommended way to use NovaClaw.",
  "settings.expertise.level.advanced.name": "Advanced",
  "settings.expertise.level.advanced.blurb":
    "More controls — the agent's instructions, its step-by-step reasoning, permission tuning, and custom tools.",
  "settings.expertise.level.developer.name": "Developer",
  "settings.expertise.level.developer.blurb":
    "Everything, including internals — raw model IDs, engine tuning, the shell, and unsafe permission modes.",
  "settings.expertise.action.unlock": "Unlock {{level}}",
  "settings.expertise.action.switch": "Switch to {{level}}",
  "settings.expertise.confirm.advanced":
    "Advanced mode shows more controls — you can change the agent's instructions, see its step-by-step reasoning, tune permissions, and define custom tools. Nothing changes until you change it, and you can switch back anytime — your settings are kept.",
  "settings.expertise.confirm.developer":
    "Developer mode exposes internals — raw model IDs, engine tuning, the shell, and unsafe permission modes like running commands without asking. Only turn this on if you know what these do.",
  "settings.expertise.confirm.downgrade": "Your advanced settings stay saved and active — unlock again to see them.",
  "settings.expertise.confirm.typePrompt": "Type {{word}} to confirm",
  "settings.expertise.confirm.cta": "Confirm",
  "settings.expertise.discover.advanced.title": "Looking for more?",
  "settings.expertise.discover.advanced.description":
    "Unlock Advanced features — the agent's instructions, reasoning, and custom tools.",
  "settings.expertise.discover.developer.title": "Need the internals?",
  "settings.expertise.discover.developer.description":
    "Unlock Developer features — raw model IDs, engine tuning, and the shell.",
  "settings.expertise.discover.action": "Unlock…",

  // Confirm dialogs on destructive/whole-config actions (uix.md §3.4 / P1).
  "settings.tools.confirm.title": "Delete this tool?",
  "settings.tools.confirm.description": "This permanently removes the “{{name}}” tool recipe. This can’t be undone.",
  "settings.general.row.configIO.title": "Configuration file",
  "settings.general.row.configIO.description":
    "Export this instance's full configuration as a file, or import one. Model API keys ride along — treat exports as secrets.",
  "settings.models.io.export": "Export models",
  "settings.models.io.import": "Import models",
  "settings.config.io.export": "Export config",
  "settings.config.io.import": "Import config",
  "settings.providers.export.dialogTitle": "Export settings file (novaclaw.jsonc)",
  "settings.providers.import.dialogTitle": "Import settings file (novaclaw.jsonc)",
  "settings.providers.export.toast": "Configuration exported",
  "settings.providers.import.toast": "Configuration imported",
  "settings.providers.import.invalid.title": "This file isn't a valid config file",
  "settings.providers.import.invalid.description": "Could not parse the config file.",
  "settings.providers.import.failed": "Import failed",
  "settings.providers.import.confirm.title": "Import configuration?",
  "settings.providers.import.confirm.description":
    "This merges the selected file into your current settings, overwriting any matching providers and models. Settings not present in the file are kept.",
  "settings.providers.import.confirm.action": "Import",
  "command.category.suggested": "Suggested",
  "command.category.view": "View",
  "command.category.session": "Chat",
  "command.chats.jump": "Go to the chat that needs you",
  "command.category.file": "File",
  "command.category.context": "Context",
  "command.category.terminal": "Terminal",
  "command.category.model": "Model",
  "command.category.mcp": "MCP",
  "command.category.permissions": "Permissions",
  "command.category.settings": "Settings",

  "theme.scheme.system": "System",
  "theme.scheme.light": "Light",
  "theme.scheme.dark": "Dark",

  "command.project.open": "Open project",
  "command.provider.connect": "Connect provider",
  "command.settings.open": "Open settings",

  "command.palette": "Command palette",

  "command.session.new": "New Agent",
  "command.file.open": "Open file",
  "command.tab.close": "Close tab",
  "command.context.addSelection": "Add selection to context",
  "command.context.addSelection.description": "Add selected lines from the current file",
  "command.input.focus": "Focus input",
  "command.terminal.toggle": "Toggle terminal",
  "command.fileTree.toggle": "Toggle file tree",
  "fileTree.loadFailed": "Could not load this folder",
  "fileTree.retry": "Try again",
  "command.review.toggle": "Toggle review",
  "command.terminal.new": "New terminal",
  "command.terminal.new.description": "Create a new terminal tab",
  "command.message.previous": "Previous message",
  "command.message.previous.description": "Go to the previous user message",
  "command.message.next": "Next message",
  "command.message.next.description": "Go to the next user message",
  "command.model.choose": "Choose model",
  "command.model.choose.description": "Select a different model",
  "command.mcp.toggle": "Toggle MCPs",
  "command.mcp.toggle.description": "Toggle MCPs",
  "command.model.variant.cycle": "Cycle thinking effort",
  "command.model.variant.cycle.description": "Switch to the next effort level",
  "command.prompt.mode.shell": "Shell",
  "command.prompt.mode.normal": "Chat",
  "command.permissions.autoaccept.enable": "Auto-accept permissions",
  "command.permissions.autoaccept.disable": "Stop auto-accepting permissions",
  "command.session.undo": "Undo",
  "command.session.undo.description": "Undo the last message",
  "command.session.redo": "Redo",
  "command.session.redo.description": "Redo the last undone message",
  "command.session.compact": "Compact session",
  "command.session.compact.description": "Summarize the session to reduce context size",
  "command.session.fork": "Fork from message",
  "command.session.fork.description": "Create a new chat from a previous message",

  "palette.search.placeholder": "Search files, commands, and chats",
  "palette.empty": "No results found",
  "palette.group.commands": "Commands",
  "palette.group.files": "Files",

  "dialog.model.select.title": "Select model",
  "dialog.model.search.placeholder": "Search models",
  "dialog.model.empty": "No model results",
  "dialog.model.manage": "Manage models",

  "model.tag.free": "Free",
  "model.tag.latest": "Latest",
  "model.provider.anthropic": "Anthropic",
  "model.provider.openai": "OpenAI",
  "model.provider.google": "Google",
  "model.provider.xai": "xAI",
  "model.provider.meta": "Meta",
  "model.input.text": "text",
  "model.input.image": "image",
  "model.input.audio": "audio",
  "model.input.video": "video",
  "model.input.pdf": "pdf",
  "model.tooltip.allows": "Allows: {{inputs}}",
  "model.tooltip.reasoning.allowed": "Allows reasoning",
  "model.tooltip.reasoning.none": "No reasoning",
  "model.tooltip.context": "Context limit {{limit}}",
  "model.tooltip.context.measured": "Context limit {{limit}}, confirmed by the server",

  "common.search.placeholder": "Search",
  "common.goBack": "Navigate back",
  "common.goForward": "Navigate forward",
  "common.loading": "Loading",
  "common.loading.ellipsis": "...",
  "common.cancel": "Cancel",
  "common.confirm": "Confirm",
  "common.clear": "Clear",
  "common.submit": "Submit",
  "common.save": "Save",
  "common.saving": "Saving...",
  "common.default": "Default",
  "common.attachment": "attachment",
  "control.scope.instance": "This instance",
  "control.scope.device": "This device",
  "control.scope.chat": "This chat",
  "control.scope.draft": "Draft — saved when you confirm",
  "control.scope.colleague": "This colleague — saved when you press Save",
  "control.scope.window": "This window — returns to the default next launch",

  "prompt.placeholder.shell": "Enter shell command... {{example}}",
  "prompt.placeholder.normal": 'Ask anything... "{{example}}"',
  "prompt.placeholder.simple": "Ask anything...",
  "prompt.placeholder.summarizeComments": "Summarize comments…",
  "prompt.placeholder.summarizeComment": "Summarize comment…",
  "prompt.mode.shell": "Shell",
  "prompt.mode.normal": "Chat",
  "prompt.mode.shell.exit": "esc to exit",
  "session.child.promptDisabled":
    "This is a helper the main chat started. You can't message it directly — go back to the main chat to continue.",
  "session.child.backToParent": "Back to the main chat.",

  "prompt.example.1": "Fix a TODO in the codebase",
  "prompt.example.2": "What is the tech stack of this project?",
  "prompt.example.3": "Fix broken tests",
  "prompt.example.4": "Explain how authentication works",
  "prompt.example.5": "Find and fix security vulnerabilities",
  "prompt.example.6": "Add unit tests for the user service",
  "prompt.example.7": "Refactor this function to be more readable",
  "prompt.example.8": "What does this error mean?",
  "prompt.example.9": "Help me debug this issue",
  "prompt.example.10": "Generate API documentation",
  "prompt.example.11": "Optimize database queries",
  "prompt.example.12": "Add input validation",
  "prompt.example.13": "Create a new component for...",
  "prompt.example.14": "How do I deploy this project?",
  "prompt.example.15": "Review my code for best practices",
  "prompt.example.16": "Add error handling to this function",
  "prompt.example.17": "Explain this regex pattern",
  "prompt.example.18": "Convert this to TypeScript",
  "prompt.example.19": "Add logging throughout the codebase",
  "prompt.example.20": "What dependencies are outdated?",
  "prompt.example.21": "Help me write a migration script",
  "prompt.example.22": "Implement caching for this endpoint",
  "prompt.example.23": "Add pagination to this list",
  "prompt.example.24": "Create a CLI command for...",
  "prompt.example.25": "How do environment variables work here?",

  "prompt.popover.emptyResults": "No matching results",
  "prompt.popover.searchError": "Could not search files right now",
  "prompt.popover.searchRetry": "Try again",
  "prompt.popover.emptyCommands": "No matching commands",
  "prompt.dropzone.label": "Drop images, PDFs, or text files here",
  "prompt.dropzone.file.label": "Drop to @mention file",
  "prompt.slash.badge.custom": "custom",
  "prompt.slash.badge.skill": "skill",
  "prompt.slash.badge.mcp": "mcp",
  "prompt.context.active": "active",
  "prompt.context.includeActiveFile": "Include active file",
  "prompt.context.removeActiveFile": "Remove active file from context",
  "prompt.context.removeFile": "Remove file from context",
  "prompt.action.attachFile": "Add files",
  "prompt.action.attachFile.scope": "Kept with this draft until you send it",
  "prompt.attachment.remove": "Remove attachment",
  "prompt.action.send": "Send",
  "prompt.action.stop": "Stop",

  "prompt.permissionMode.title": "Permission mode",
  // One word each — these render inside a narrow listbox (and on a phone). The explanations live in
  // `.hint` below, shown by the control's tooltip and the Settings row, not in the option label.
  // NOTE the display names do not match the internal values: Analyze=plan, Modify=bypass, Admin=yolo
  // (renamed from "Build"/"YOLO" — owner, 2026-09-01). Renaming the VALUES would touch the schema,
  // protocol, generated clients and every stored session row, for no
  // user-visible gain — so the mapping is here, and here only. `ask` and `surgical` are no longer
  // offered: surgical became a Tuning switch, and "ask about everything" is what Analyze/Modify bracket.
  "prompt.permissionMode.plan": "Analyze",
  "prompt.permissionMode.ask": "Ask",
  "prompt.permissionMode.surgical": "Surgical",
  "prompt.permissionMode.bypass": "Modify",
  "prompt.permissionMode.yolo": "Admin",
  "prompt.permissionMode.plan.hint": "Read only — but it can still write a report into a temp folder.",
  "prompt.permissionMode.ask.hint": "Asks before every change. Superseded by Analyze and Modify.",
  "prompt.permissionMode.surgical.hint": "Now a Tuning switch — “Edits instead of overwriting”.",
  "prompt.permissionMode.bypass.hint": "Write access to this project's folder.",
  "prompt.permissionMode.yolo.hint": "Write access to the ENTIRE computer, not just this project.",

  "prompt.strict.tooltip":
    "Strict mode: the harness plans, verifies every step, and recovers — built for small local models",
  "prompt.strict.off": "Strict",
  "prompt.strict.on": "Strict: on",
  "prompt.strict.popover.title": "Run this chat in Strict mode",
  "prompt.strict.popover.description":
    "The harness breaks your task into small steps, verifies each one by compiling or running it, and recovers from mistakes. Best for weak or local models on real coding tasks.",
  "prompt.strict.popover.attempts": "Agents racing (1–8)",
  "prompt.strict.popover.wallMinutes": "Time budget (minutes)",
  "prompt.strict.popover.bypassNote":
    "Strict mode works autonomously, so this chat's permission mode switches to Bypass (changes stay inside the project).",
  "prompt.strict.popover.enable": "Enable Strict",

  "prompt.features.tooltip": "Tune this chat — how it works, how careful it is, and when it asks",
  "prompt.features.label": "Tune",
  "prompt.features.popover.title": "Tune this chat",
  "prompt.features.popover.description":
    "These switches apply to this chat only (chats spawned from it inherit them). Everything else about each helper is configured in Settings.",
  "prompt.features.source.inherit": "Using Settings default: {{state}}",
  "prompt.features.source.project": "Set by this folder's project file: {{state}}",
  "prompt.features.source.parent": "Inherited from the chat that started this one: {{state}}",
  "prompt.project.title": "This folder's project file",
  "prompt.project.applied": "It sets: {{list}}",
  "prompt.project.refused":
    "It asked for, and did not get: {{list}}. A project file can turn a safety control on, never off.",
  "prompt.project.none": "It sets none of these.",

  "composer.tune.makeDefault.title": "Make Default for this Folder",
  // 🔴 SHORT on sight, long on demand (uix.md §1.4). This block was ~1,400 characters of prose
  // under one control — the owner quoted it back as "verbose and useless". Each visible line now says
  // what is in force in a few words; the reasoning moved to the `.more` popover beside the title.
  "composer.tune.makeDefault.description": "Save these switches as this folder's default.",
  "composer.tune.makeDefault.description.more":
    "The switches you changed in this chat are written into this folder's novaclaw.json, so every new chat here starts the same way. Anything you did not change keeps following your Settings.",
  "composer.tune.makeDefault.inForce.none": "No project file here yet — saving creates one.",
  "composer.tune.makeDefault.inForce.pending": "Checking…",
  "composer.tune.makeDefault.inForce.hereUnknown": "{{file}} is here; what it sets is not known yet.",
  "composer.tune.makeDefault.inForce.brokenUnreadable":
    "{{file}} could not be read — saving is refused until it is valid.",
  "composer.tune.makeDefault.inForce.brokenFuture": "{{file}} needs a newer NovaClaw — nothing in it applies here.",
  "composer.tune.makeDefault.inForce.here": "{{file}} is here. Saving replaces its Tune section only.",
  "composer.tune.makeDefault.inForce.ancestor": "Following {{file}} above. Saving gives this folder its own.",
  "composer.tune.makeDefault.nothing": "Nothing changed in this chat yet.",
  "composer.tune.makeDefault.preview": "Will save: {{list}}",
  "composer.tune.makeDefault.omitted": "Not saved: {{list}}.",
  "composer.tune.makeDefault.modeStays": "This chat's mode stays with the chat.",
  "composer.tune.makeDefault.action": "Save as folder default",
  "composer.tune.makeDefault.saving": "Saving...",
  "composer.tune.makeDefault.receipt.created": "Created {{file}}",
  "composer.tune.makeDefault.receipt.updated": "Updated {{file}}",
  "composer.tune.makeDefault.receipt.sections": "Sections written: {{list}}",
  "composer.tune.makeDefault.receipt.preserved": "Everything else in the file was left exactly as it was.",
  "composer.tune.makeDefault.receipt.refused":
    "Left out: {{list}}. A folder's file can turn a safety control on, never off.",
  "composer.tune.makeDefault.receipt.refusedBroken": "Nothing was saved. {{file}} could not be read: {{detail}}",
  "composer.tune.makeDefault.receipt.refusedFuture":
    "Nothing was saved. {{file}} was written by a newer NovaClaw, so this one cannot safely edit it. Update NovaClaw.",
  "composer.tune.makeDefault.receipt.untouched": "Your file is untouched — fix it, or move it aside, and try again.",
  "composer.tune.makeDefault.receipt.failed": "Nothing was saved: {{detail}}",

  "prompt.features.source.override": "This chat overrides Settings",
  "prompt.features.useDefault": "Use Settings default",
  "prompt.features.state.on": "On",
  "prompt.features.state.off": "Off",
  "prompt.features.introspection.title": "Stuck detector",
  "prompt.features.introspection.description":
    "A judge model periodically checks whether the agent is stuck and nudges it to change approach.",
  "prompt.features.quality.title": "Quality gates",
  "prompt.features.quality.description":
    "Compiles and tests after the agent edits code, and steers it to fix failures before finishing.",
  "prompt.features.affective.title": "Mood sampling",
  "prompt.features.affective.description":
    "Adapts the model's sampling to its appraised mood — steadier when frustrated, freer when exploring.",

  "prompt.features.safeMode.title": "Safe mode",
  // The visible line is what the switch DOES; the trade, the default and the two cases it does
  // not affect are on demand.
  "prompt.features.safeMode.description":
    "Unattended, run shell commands only inside a sandbox — and refuse them where there is none.",
  "prompt.features.safeMode.description.more":
    "Off by default, so the agent can install packages, build and run tests on its own. Turning it on trades some of that away for a harder boundary. It changes nothing while you are here answering: chats you drive yourself run the same either way, and commands from an untrusted messenger contact stay confined whatever this says.",
  "prompt.features.askBeforeChanges.title": "Ask before every change",
  "prompt.features.askBeforeChanges.description":
    "Stop and ask you before the agent edits, creates or deletes anything, and before it runs a shell command. Off by default — the permission mode already decides where it may work.",
  "prompt.features.surgicalEdits.title": "Edits instead of overwriting",
  "prompt.features.surgicalEdits.description":
    "Refuse to replace a whole file. The agent must make the smallest change that works, which keeps diffs readable and avoids losing parts of a file it did not mean to touch.",
  "prompt.features.contextBudget.title": "Context guard",
  "prompt.features.contextBudget.description":
    "Keep conversation, recalled memory, knowledge retrieval, and tool output from crowding one another out.",
  "prompt.features.memory.title": "Memory",
  "prompt.features.memory.description":
    "Let this chat recall what you have taught Nova and save useful new memories after it answers. Turn it off for a faster one-off conversation Nova will not remember later; the instance-wide Memory switch can still keep every chat off.",
  "prompt.features.shortChat.title": "Short chat",
  "prompt.features.shortChat.description":
    "Use Nova for fast local conversation without project access or memory. Turn this off for Agent, which can recall context and work in this folder.",
  "prompt.posture.section.title": "How Nova should help",
  "prompt.posture.chat.title": "Chat",
  "prompt.posture.chat.description": "Fast local conversation; no project access or memory.",
  "prompt.posture.agent.title": "Agent",
  "prompt.posture.agent.description": "Recalls context and can work in this folder.",
  "prompt.features.thinkingBudget.title": "Thinking budget",
  "prompt.features.thinkingBudget.description":
    "Caps how long the model reasons before it must answer, and stops it looping. Turn off to let it think as long as it wants — useful for comparing the two on the same task.",

  "prompt.mode.title": "Mode",
  "prompt.mode.description": "How this chat runs — with you, or working alone.",
  "prompt.mode.interactive.title": "Interactive",
  "prompt.mode.interactive.description": "You drive: the agent answers and waits for you.",
  "prompt.mode.auto-prompting.title": "Auto-prompting",
  // ⚠️ This said "shell commands run sandboxed" until 2026-07-31, and the owner's 2026-07-30 directive
  // had already made that false: unattended shell runs UNBOXED by default so the agent can actually
  // work, and Safe mode is the opt-in that puts it back in a sandbox. Caught in the web preview,
  // where the new Confinement panel two clicks away stated the opposite — a promise of containment
  // the product does not keep is ruling 2's *a fault is never described falsely*, and it is worse
  // than silence because a user picks this mode BECAUSE of it.
  "prompt.mode.auto-prompting.description":
    "Unattended: the agent keeps prompting itself until the task is done. Permission asks are auto-approved, and shell commands run with your account unless you turn on Safe mode below.",
  "prompt.mode.control": "Autonomy mode",
  "prompt.mode.goal-oriented.title": "Goal-oriented",
  "prompt.mode.goal-oriented.description":
    "Unattended: the agent loops toward the goal you set until it's reached. Same guardrails as auto-prompting.",
  "prompt.mode.short.auto-prompting": "Auto",
  "prompt.mode.short.goal-oriented": "Goal",

  "prompt.remote.title": "Remote chat",
  "prompt.remote.draft": "Start the chat first — then you can link it to a messenger here.",
  "prompt.remote.none": "No messenger accounts yet — add one in Settings",
  "prompt.remote.link": "Link this chat to a messenger…",
  "prompt.remote.pickAccount": "Which messenger?",
  "prompt.remote.pickChat": "Which conversation?",
  "prompt.remote.loading": "Loading conversations…",
  "prompt.remote.chatsEmpty": "No conversations known yet. Send the account a message once and it appears here.",
  "prompt.remote.manual": "Or type a chat id / handle",
  "prompt.remote.manualUse": "Use",
  "prompt.remote.trust.title": "Who is on the other side?",
  "prompt.remote.trust.operator.title": "Me or my family",
  "prompt.remote.trust.operator.description": "Full control of NovaClaw through this chat.",
  "prompt.remote.trust.client.title": "A client",
  "prompt.remote.trust.client.description":
    "The agent works for them — their messages are requests to consider, never commands.",
  "prompt.remote.trust.audience.title": "The public",
  "prompt.remote.trust.audience.description":
    "The agent only watches and moderates; it speaks in the chat only on purpose.",
  "prompt.remote.conflict": "That conversation already drives another chat.",
  "prompt.remote.conflict.steal": "Move it here instead",
  "prompt.remote.connected": "via {{driver}} · {{chat}}",
  "prompt.remote.disconnect": "Disconnect",
  "prompt.remote.back": "Back",
  "prompt.remote.toast.failed": "Messenger link failed",

  // WHO the prompt is for. The folder chip that stood here asked which directory a chat runs in —
  // a question the user answered again for every conversation. The folder belongs to the colleague
  // now, so this asks the one that is actually left.
  "prompt.agent.tooltip": "Which colleague this is for — they bring their own project and memory",
  "prompt.agent.tooltip.working": "This colleague is working — you can hand it to someone else once it is idle",
  "prompt.folder.tooltip": "This chat's working folder — click to move the chat somewhere else",
  "prompt.folder.tooltip.working": "The agent is working — you can move the chat once it's idle",
  "prompt.folder.pick.title": "Move this chat to a folder",
  "prompt.folder.moveFailed": "Moving the chat failed",

  "prompt.toast.pasteUnsupported.title": "Unsupported attachment",
  "prompt.toast.pasteUnsupported.description": "Only images, PDFs, or text files can be attached here.",
  "prompt.toast.modelAgentRequired.title": "Select an agent and model",
  "prompt.toast.modelAgentRequired.description": "Choose an agent and model before sending a prompt.",
  "prompt.toast.worktreeCreateFailed.title": "Couldn't create workspace",
  "prompt.toast.sessionCreateFailed.title": "Couldn't start the chat",
  "prompt.toast.attachmentsUnsupportedHere.title": "Attachments aren't supported here",
  "prompt.toast.attachmentsUnsupportedHere.description":
    "Commands and shell input can't carry a file yet. Send the attachment as an ordinary message instead.",
  "prompt.toast.shellSendFailed.title": "Failed to send shell command",
  "prompt.toast.commandSendFailed.title": "Failed to send command",
  "prompt.toast.promptSendFailed.title": "Failed to send prompt",
  "prompt.toast.promptSendFailed.description": "Couldn't find this chat. Try reopening it.",

  "dialog.mcp.title": "Connections",
  "dialog.mcp.description": "{{enabled}} of {{total}} enabled",
  "dialog.mcp.empty": "No connections yet. Connect an external tool or service to let your agents use it.",

  // The five MCP connection statuses, one label each — the set is closed by `MCPStatus` in
  // `packages/novaclaw/src/mcp/index.ts`. These render as a small label beside the server's name,
  // so they are lowercase fragments, and `needs a client ID` is shown above the server's own error
  // line explaining what to put in the config. ⚠️ `needs_client_registration` was MISSING until
  // 2026-07-29, so that status had no copy at all — a lookup with no entry resolves to nothing, not
  // to the key itself (`i18n/resolve.ts` measures the library and states what actually happens). The
  // app's translator is key-typed now, so a sixth status cannot ship without its label.
  "mcp.status.connected": "connected",
  "mcp.status.idle": "not connected",
  "mcp.status.failed": "failed",
  "mcp.status.needs_auth": "needs auth",
  "mcp.status.needs_client_registration": "needs a client ID",
  "mcp.status.disabled": "disabled",
  "mcp.auth.clickToAuthenticate": "Click to authenticate",

  "dialog.fork.empty": "No messages to fork from",

  "dialog.directory.action.selectFile": "Select file",
  "dialog.directory.action.selectFolder": "Select folder",
  "dialog.directory.root": "Root",
  "dialog.directory.parent": "Parent",
  "dialog.directory.filename": "Save as",
  "dialog.directory.readError": "Can't open this folder — you may not have permission.",
  "dialog.directory.bookmarks": "Bookmarks",
  "dialog.directory.places": "Places",
  "dialog.directory.homePlace": "Home",
  "dialog.directory.pin": "Bookmark this folder",
  "dialog.directory.unpin": "Remove bookmark",
  "dialog.directory.pinShort": "Bookmark",
  "dialog.directory.pinnedShort": "Bookmarked",

  "app.server.unreachable": "Could not reach {{server}}",
  "app.server.retrying": "Retrying automatically...",
  "app.server.otherServers": "Other servers",
  "app.server.none": "No instance connected",
  "app.server.noneHint":
    "NovaClaw's instance isn't running yet. It usually starts by itself — this screen will clear as soon as it comes up.",
  // A 401/403 is an ANSWER, not an outage. Saying "could not reach" here sent people to restart an
  // instance that was running perfectly and only wanted a different password.
  "app.server.rejected": "Could not sign in to {{server}}",
  "app.server.rejectedHint":
    "The instance is running, but it refused the saved username or password. Update the credentials for this instance, or pick another one below.",
  "app.connection.reconnecting": "Connection lost — reconnecting…",
  "app.connection.promptReconnecting": "Connection Lost. Reconnecting Attempt {{attempt}}",
  "app.connection.stillTrying": "Still trying. Your work is safe; this clears by itself once the instance is back.",
  "app.connection.restored": "Reconnected",
  // The BOUNDED end of the restart ladder. Says the three things the old "still trying" line could
  // not: it stopped, why it is safe to wait no longer, and what the one button will do.
  "app.connection.stopped.title": "This instance stopped and could not restart itself",
  "app.connection.stopped.description":
    "NovaClaw tried several times and has stopped trying. Your work is saved. Restarting the app usually fixes it.",
  "app.connection.stopped.restart": "Restart NovaClaw",
  "app.connection.stopped.restarting": "Restarting…",

  "dialog.server.title": "Servers",
  "dialog.server.search.placeholder": "Search servers",
  "dialog.server.empty": "No servers yet",
  "dialog.server.add.title": "Add server",
  "dialog.server.add.url": "Server address",
  "dialog.server.add.placeholder": "http://localhost:4096",
  "dialog.server.add.error": "Could not connect to server",
  "dialog.server.add.error.auth": "Wrong username or password",
  "dialog.server.add.checking": "Checking...",
  "dialog.server.add.button": "Add server",
  "dialog.server.add.name": "Server name (optional)",
  "dialog.server.add.namePlaceholder": "Localhost",
  "dialog.server.add.username": "Username (optional)",
  "dialog.server.add.usernamePlaceholder": "username",
  "dialog.server.add.password": "Password (optional)",
  "dialog.server.add.passwordPlaceholder": "password",
  "dialog.server.edit.title": "Edit server",

  "dialog.server.menu.edit": "Edit",
  "dialog.server.menu.default": "Set as default",
  "dialog.server.menu.defaultRemove": "Remove default",
  "dialog.server.menu.delete": "Delete",
  "dialog.server.status.default": "Default",
  "wsl.server.add": "Add WSL server",
  "wsl.server.label": "WSL",
  "wsl.server.menu.label": "WSL server",
  "wsl.server.retryStart": "Retry start",
  "wsl.server.updating": "Updating...",
  "wsl.onboarding.step.distro": "Choose distro",
  "wsl.onboarding.step.novaclaw": "NovaClaw",
  "wsl.onboarding.checkingRuntime": "Checking WSL...",
  "wsl.onboarding.restartRequired": "Windows needs a restart to finish installing WSL.",
  "wsl.onboarding.ready": "WSL is ready.",
  "wsl.onboarding.required": "WSL is required to continue.",
  "wsl.onboarding.checkingDistros": "Checking distros...",
  "wsl.onboarding.installingDistro": "Installing {{distro}}...",
  "wsl.onboarding.checkingDistro": "Checking {{distro}}...",
  "wsl.onboarding.listingDistros": "Listing distros...",
  "wsl.onboarding.distroReady": "{{distro}} is ready.",
  "wsl.onboarding.distroNotInstalled": "{{distro}} is not installed yet.",
  "wsl.onboarding.openDistroOnce": "Open {{distro}} once to finish setup.",
  "wsl.onboarding.finishingDistro": "Finishing setup for {{distro}}.",
  "wsl.onboarding.pickDistro": "Pick a distro or install one below.",
  "wsl.onboarding.checkingNovaclaw": "Checking NovaClaw...",
  "wsl.onboarding.checkingNovaclawIn": "Checking NovaClaw in {{distro}}...",
  "wsl.onboarding.updatingNovaclaw": "Updating NovaClaw...",
  "wsl.onboarding.updatingNovaclawIn": "Updating NovaClaw in {{distro}}...",
  "wsl.onboarding.updateNovaclawIn": "Update NovaClaw in {{distro}}.",
  "wsl.onboarding.updateNovaclaw": "Update NovaClaw",
  "wsl.onboarding.novaclawReadyIn": "NovaClaw is ready in {{distro}}.",
  "wsl.onboarding.novaclawReady": "NovaClaw is ready.",
  "wsl.onboarding.installNovaclawIn": "Install NovaClaw in {{distro}}.",
  "wsl.onboarding.installNovaclaw": "Install NovaClaw",
  "wsl.onboarding.chooseDistroFirst": "Choose a distro first.",
  "wsl.onboarding.loadFailed": "Failed to load WSL state.",
  "wsl.onboarding.loading": "Loading...",
  "wsl.onboarding.installWsl": "Install WSL",
  "wsl.onboarding.windowsRestartRequired": "Restart Windows to finish installing WSL, then reopen NovaClaw.",
  "wsl.onboarding.next": "Next",
  "wsl.onboarding.refresh": "Refresh",
  "wsl.onboarding.allDistrosAdded": "All installed distros are already added.",
  "wsl.onboarding.noDistros": "No distros detected yet.",
  "wsl.onboarding.install": "Install",
  "wsl.onboarding.installing": "Installing...",
  "wsl.onboarding.installDistro": "Install distro",
  "wsl.onboarding.wsl2Required":
    "This needs WSL 2, a newer version of Windows' Linux support. NovaClaw can help you upgrade it.",
  "wsl.onboarding.toolsRequired":
    "This Linux system is missing some tools NovaClaw needs. Open it once (button below) to finish setup.",
  "wsl.onboarding.openTerminal": "Open terminal",
  "wsl.onboarding.path": "Path: {{path}}",
  "wsl.onboarding.notFound": "not found",
  "wsl.onboarding.version": "Version: {{version}}",
  "wsl.onboarding.unknown": "unknown",
  "wsl.onboarding.desktopVersion": "desktop {{version}}",
  "wsl.onboarding.versionMismatch":
    "The NovaClaw installed in Linux is a different version than this app. Update it below to match.",
  "wsl.onboarding.adding": "Adding...",
  "server.row.noUsername": "no username",
  "server.row.devBuild": "dev build",

  "dialog.project.edit.title": "Edit project",
  "dialog.project.edit.name": "Name",
  "dialog.project.edit.icon": "Icon",
  "dialog.project.edit.icon.alt": "Project icon",
  "dialog.project.edit.icon.hint": "Click or drag an image",
  "dialog.project.edit.icon.recommended": "Recommended: 128x128px",
  "dialog.project.edit.color": "Color",
  "dialog.project.edit.color.select": "Select {{color}} color",
  "dialog.project.edit.worktree.startup": "Workspace startup script",
  "dialog.project.edit.worktree.startup.description": "Runs each time you create a new workspace.",
  "dialog.project.edit.worktree.startup.placeholder": "e.g. bun install",

  "dialog.releaseNotes.action.getStarted": "Get started",
  "dialog.releaseNotes.action.next": "Next",
  "dialog.releaseNotes.action.hideFuture": "Don't show these in the future",
  "dialog.releaseNotes.media.alt": "Release preview",

  "context.breakdown.title": "Context Breakdown",
  "context.breakdown.note":
    "Rough split of what's taking up the model's context. \"Other\" covers tool definitions and system overhead.",
  "context.breakdown.system": "System",
  "context.breakdown.user": "User",
  "context.breakdown.assistant": "Assistant",
  "context.breakdown.tool": "Tool Calls",
  "context.breakdown.other": "Other",

  "context.systemPrompt.title": "System Prompt",
  "context.rawMessages.title": "Raw messages",

  "context.stats.session": "Session",
  "context.stats.messages": "Messages",
  "context.stats.provider": "Provider",
  "context.stats.model": "Model",
  "context.stats.limit": "Context Limit",
  "context.stats.totalTokens": "Total Tokens",
  "context.stats.usage": "Usage",
  "context.stats.inputTokens": "Input Tokens",
  "context.stats.outputTokens": "Output Tokens",
  "context.stats.reasoningTokens": "Reasoning Tokens",
  "context.stats.cacheTokens": "Cache Tokens (read/write)",
  "context.stats.userMessages": "User Messages",
  "context.stats.assistantMessages": "Assistant Messages",
  "context.stats.totalCost": "Total Cost",
  "context.stats.sessionCreated": "Session Created",
  "context.stats.lastActivity": "Last Activity",

  "context.usage.tokens": "Tokens",
  "context.usage.usage": "Usage",
  "context.usage.cost": "Cost",
  "context.usage.window": "Context window",
  "context.usage.view": "View context usage",

  "language.en": "English",
  "language.zh": "简体中文",
  "language.zht": "繁體中文",
  "language.ko": "한국어",
  "language.de": "Deutsch",
  "language.es": "Español",
  "language.fr": "Français",
  "language.da": "Dansk",
  "language.ja": "日本語",
  "language.pl": "Polski",
  "language.ru": "Русский",
  "language.ar": "العربية",
  "language.no": "Norsk",
  "language.br": "Português (Brasil)",
  "language.bs": "Bosanski",
  "language.uk": "Українська",
  "language.th": "ไทย",
  "language.tr": "Türkçe",

  "toast.permissions.autoaccept.on.title": "Auto-accepting permissions",
  "toast.permissions.autoaccept.on.description": "Permission requests will be automatically approved",
  "toast.permissions.autoaccept.off.title": "Stopped auto-accepting permissions",
  "toast.permissions.autoaccept.off.description": "Permission requests will require approval",

  "toast.model.none.title": "No model selected",
  "toast.model.none.description": "Connect an AI service to summarize this chat",

  "toast.file.loadFailed.title": "Failed to load file",
  "toast.file.listFailed.title": "Failed to list files",

  "toast.context.noLineSelection.title": "No line selection",
  "toast.context.noLineSelection.description": "Select a line range in a file tab first.",

  "toast.session.listFailed.title": "Couldn't load chats for {{project}}",
  "toast.project.reloadFailed.title": "Failed to reload {{project}}",
  "toast.project.directoryMissing.title": "Project folder is missing",
  "toast.project.directoryMissing.description":
    "NovaClaw kept your chats, but {{directory}} no longer exists. Restore that folder or move the chat to another project before asking Nova to work there.",

  "error.page.title": "Something went wrong",
  "error.page.description": "An error occurred while loading the application.",
  "error.page.description.localServerStartup": "An error occurred while starting the local server.",
  "error.page.details.label": "Error Details",
  "error.page.details.show": "Show technical details",
  "error.page.details.hide": "Hide technical details",
  "error.page.action.retry": "Try again",
  "error.page.action.restart": "Restart",
  "error.page.action.exportLogs": "Export Logs",
  // A recovery action that fails answers in a sentence. The chain it produced — stack frames and all
  // — goes into the "Show technical details" box instead of into the body of the page, because this
  // is the screen a person reaches after something has already broken.
  "error.page.action.exportLogs.failed":
    "Could not export the logs. Open Show technical details below for what went wrong.",
  "error.page.details.actionFailure": "While exporting the logs:",
  "error.page.circular": "[Circular]",
  "error.page.report.prefix": "Please report this error to the NovaClaw team",
  "error.page.report.discord": "on Discord",
  "error.page.version": "Version: {{version}}",

  "error.dev.rootNotFound":
    "Root element not found. Did you forget to add it to your index.html? Or maybe the id attribute got misspelled?",

  "error.serverSDK.noServerAvailable": "No server available",
  "error.childStore.persistedCacheCreateFailed": "Failed to create persisted cache",
  "error.childStore.persistedProjectMetadataCreateFailed": "Failed to create persisted project metadata",
  "error.childStore.persistedProjectIconCreateFailed": "Failed to create persisted project icon",
  "error.childStore.storeCreateFailed": "Failed to create store",
  "directory.error.invalidUrl": "That folder link doesn't point anywhere valid.",

  "error.chain.unknown": "Unknown error",
  "error.chain.causedBy": "Caused by:",
  "error.chain.apiError": "API error",
  "error.chain.status": "Status: {{status}}",
  "error.chain.retryable": "Retryable: {{retryable}}",
  "error.chain.responseBody": "Response body:\n{{body}}",
  "error.chain.didYouMean": "Did you mean: {{suggestions}}",
  "error.chain.modelNotFound": "Model not found: {{provider}}/{{model}}",
  "error.chain.checkConfig": "Check the model in Settings → Models — it may have been renamed or removed.",
  "error.chain.mcpFailed":
    "Couldn't connect to the MCP tool server \"{{name}}\". NovaClaw can't sign in to MCP servers that require authentication yet.",
  "error.chain.providerInitFailed":
    'Failed to initialize provider "{{provider}}". Check credentials and configuration.',
  "error.chain.configJsonInvalid": "Config file at {{path}} isn't valid JSON (JSONC).",
  "error.chain.configJsonInvalidWithMessage": "Config file at {{path}} is not valid JSON(C): {{message}}",
  "error.chain.configDirectoryTypo":
    'Directory "{{dir}}" in {{path}} is not valid. Rename the directory to "{{suggestion}}" or remove it. This is a common typo.',
  "error.chain.configFrontmatterError": "Failed to parse frontmatter in {{path}}:\n{{message}}",
  "error.chain.configInvalid": "Config file at {{path}} is invalid",
  "error.chain.configInvalidWithMessage": "Config file at {{path}} is invalid: {{message}}",

  "notification.permission.title": "Permission required",

  "notification.session.responseReady.title": "Response ready",
  "notification.session.recovery.title": "Chat paused safely",
  "notification.session.recovery.fallbackDescription":
    "This chat paused safely and needs review before it can continue.",
  "notification.session.error.title": "Chat error",
  "notification.session.error.fallbackDescription": "An error occurred",

  // The session-fault taxonomy's headline sentences. `sessionErrorDisplay`
  // (packages/core/src/session/session-error.ts — it moved out of `session-ui` on 2026-07-30 so
  // the app, the transcript and the headless CLI can all reach it) classifies a
  // `Session.Error.Unknown` and returns ONE of these keys plus its params; the English text here is
  // kept identical to that module's own `SESSION_ERROR_TEXT` fallback, which surfaces where no
  // translator exists. Both halves are pinned by `session-error-keys.test.ts` — a new arm there
  // without a key here fails the suite by name.
  "session.error.interrupted": "Interrupted",
  "session.error.transport":
    "Can't reach the model server. It may be turned off, still starting, or on another network.",
  "session.error.transportEndpoint":
    "Can't reach the model server at {{endpoint}}. It may be turned off, still starting, or on another network.",
  // An offline/airgap block is a DECISION, not an outage — see `OfflineBlockedReason`. Never
  // phrase these as unreachability: the server may be perfectly healthy.
  "session.error.offlineBlocked": "Offline mode blocked this request, so it never left your computer.",
  "session.error.offlineBlockedEndpoint":
    "Offline mode blocked this request to {{endpoint}}, so it never left your computer.",
  "session.error.invalidRequest": "The model rejected this request.",
  "session.error.modelMissing":
    "This chat is set to a model its provider no longer serves. Pick another model for this chat.",
  "session.error.noRoute": "No route is configured for this model.",
  "session.error.authentication": "The model provider rejected this model's credentials.",
  "session.error.rateLimit": "The model provider is rate-limiting this account — try again in a moment.",
  "session.error.quotaExceeded": "This account is out of quota with the model provider.",
  "session.error.contentPolicy": "The model provider refused this request under its content policy.",
  "session.error.providerInternal": "The model server hit an internal error.",
  "session.error.gatewayTimeout":
    "The gateway reached the model server, but stopped waiting before it replied (HTTP {{status}}).",
  "session.error.invalidProviderOutput": "The model's reply could not be read.",
  "session.error.unknownProvider": "The model provider returned an error.",
  "session.error.toolFailure": "A tool failed.",
  "session.error.unknown": "The turn failed before it finished.",

  "home.title": "Home",
  // Help tour (O3/O4/O6 — i18n'd; adds a Settings pointer; softened data-safety copy).
  "help.tour.skip": "Skip",
  "help.tour.back": "Back",
  "help.tour.next": "Next",
  "help.tour.getStarted": "Get started",
  "help.tour.step.welcome.title": "Welcome to NovaClaw",
  "help.tour.step.welcome.body":
    "Your private AI workspace — an operating system where AI helpers work for you like apps. It runs on your own hardware, so your conversations and data stay with you.",
  "help.tour.step.apps.title": "A home screen of apps",
  "help.tour.step.apps.body":
    "Tap a tile to open an app. The big gold tile is Chats — that’s where everything starts, and its Recent and Active views show what the AI is doing right now. Notes keeps your everyday things, and Files lets AI work on your folders.",
  "help.tour.step.home.title": "The logo is your Home button",
  "help.tour.step.home.body":
    "See the NovaClaw logo in the top-left corner? Click it anytime to jump back to this home screen — from any chat or app. Think of it as your Start button.",
  "help.tour.step.chat.title": "Chat, and let AI help",
  "help.tour.step.chat.body":
    "A helper can break a big job into smaller ones, use tools on your behalf, and hand back the result. It can even draw charts and small visualizations right inside the chat — not just text.",
  "help.tour.step.build.title": "Ask for your own apps",
  "help.tour.step.build.body":
    "Want something this screen doesn’t have? Just ask — “make me a stock prices app on the home screen” — and a helper builds it and pins it as a new tile.",
  "help.tour.step.settings.title": "Set up your models",
  "help.tour.step.settings.body":
    "Open Settings to connect the AI models your helpers use and to manage servers. Settings is also home to Recovery, where you can reset or restore things if you ever need to.",
  "help.tour.step.data.title": "Your data is yours — and safe",
  "help.tour.step.data.body":
    "Notes are shared with your AI helpers so they know your context. When AI edits or removes files, deletions go to a Trash you can restore from — so an accidental change is easy to undo.",
  "help.tour.step.done.title": "You’re all set",
  "help.tour.step.done.body":
    "Open Chats and say hi. Hover any tile for a hint of what it does, and reopen this tour anytime from the Help app.",
  "session.info.folder": "Folder",
  "session.info.tags": "Tags",
  "common.remove": "Remove",
  "session.info.tags.placeholder": "Add a tag and press Enter",
  // ⚠️ The copy changed WITH the control (AGENTS.md principle 12): this was a fake text input whose
  // label said "Enter opens its chat", which described typing that never happened. It is a button.
  "home.newAgent.placeholder": "Start a new chat — opens ready to configure",
  "home.newAgent.notReady": "Still connecting to your workspace — try again in a moment.",
  "session.control.reverted":
    "{{control}} could not be changed on the server, so it has been put back. The chat is still running with the previous setting.",
  "home.newAgent.noColleagues":
    "This instance is not answering with its roster, so there is nobody to start a chat with. Nova is built in and can never be missing — check the server this window is connected to.",
  "session.info.agent": "Agent",
  "session.info.model": "Model",
  "session.info.status": "Status",
  "session.info.status.ready": "Ready",
  "session.info.changes": "Workspace changes",
  "session.info.changes.value": "{{files}} files · +{{additions}} −{{deletions}}",
  "session.info.cost": "Cost",
  "session.info.created": "Created",
  "session.info.updated": "Last activity",
  "session.info.tokens.thisChat": "Tokens",
  "session.info.tokens.value": "{{total}} ({{input}} read · {{output}} written)",
  "session.info.tokens.withThreads": "With threads",
  "session.info.tokens.rollup": "{{total}} across {{threads}} sub-agent threads",
  "session.info.tokens.hint":
    "Tokens are the pieces of text the AI reads and writes — a rough measure of how much work this chat has done.",
  "session.info.adhoc.title": "Session tools",
  "session.info.adhoc.promote": "Promote",
  "session.info.adhoc.promoted": "Promoted",
  "session.info.adhoc.discard": "Discard",
  "session.info.adhoc.manual": "Manual",
  "session.info.adhoc.hint":
    "Tools this chat's agent defined for itself. Promote copies one into this instance's configuration for every chat; Discard throws it away.",
  "session.info.prompt.title": "System prompt (this chat)",
  "session.info.prompt.placeholder": "Extra standing instructions for this chat…",
  "session.info.prompt.hint":
    "Standing instructions layered on top of the agent's base prompt — for this chat only (chats spawned from it inherit them). Applies from the next reply; the base prompt is never changed.",

  "session.tab.session": "Chat",
  "session.tab.review": "Review",
  "session.tab.context": "Context",
  "session.panel.reviewAndFiles": "Review and files",
  "session.review.filesChanged": "{{count}} Files Changed",
  "session.review.change.one": "Change",
  "session.review.change.other": "Changes",
  "session.review.loadingChanges": "Loading changes...",
  "session.review.empty": "No changes in this chat yet",
  "session.review.noVcs":
    "This folder isn't tracked by Git yet, so there's nothing to review. Create a Git repository below to track changes.",
  "session.review.noVcs.createGit.title": "Create a Git repository",
  "session.review.noVcs.createGit.description": "Track, review, and undo changes in this project",
  "session.review.noVcs.createGit.actionLoading": "Creating Git repository...",
  "session.review.noVcs.createGit.action": "Create Git repository",
  "session.review.noSnapshot":
    "Snapshot tracking is turned off, so per-session changes aren't available. Turn it on in settings to see them.",
  "session.review.noChanges": "No changes",
  "session.review.noLiveChanges": "No live workspace changes yet",
  "session.review.noUncommittedChanges": "No uncommitted changes yet",
  "session.review.noBranchChanges": "No branch changes yet",
  "session.review.source.live": "Live workspace",
  "session.review.source.recorded": "Recorded",
  "session.review.source.incomplete": "Recording incomplete",
  "session.review.loadFailed": "Could not load these changes right now.",
  "session.review.retry": "Try again",
  "session.device.unpin": "Remove Device pin",
  "session.device.unpinning": "Removing Device pin…",
  "session.device.unpinned": "Device pin removed",
  "session.device.unpinFailed": "Could not remove the Device pin",
  // Shown INSTEAD of the transcript when a message cannot be rendered — one calm line, never a stack
  // trace. The rest of the app keeps working; the fault is contained to this pane.
  "session.timeline.degraded": "This conversation couldn’t be displayed. Your messages are safe.",

  "session.files.selectToOpen": "Select a file to open",
  "session.files.all": "All files",
  "session.files.empty": "No files",
  "session.files.binaryContent": "Binary file (content cannot be displayed)",

  "session.messages.renderEarlier": "Render earlier messages",
  "session.messages.loadingEarlier": "Loading earlier messages...",
  "session.messages.loadEarlier": "Load earlier messages",
  "session.messages.loading": "Loading messages...",
  "session.messages.jumpToLatest": "Jump to latest",

  "session.context.addToContext": "Add {{selection}} to context",
  "session.todo.title": "Todos",
  "session.todo.collapse": "Collapse",
  "session.todo.expand": "Expand",
  "session.todo.progress": "{{done}} of {{total}} todos completed",
  "session.revertDock.summary.one": "{{count}} rolled back message",
  "session.revertDock.summary.other": "{{count}} rolled back messages",
  "session.revertDock.collapse": "Collapse rolled back messages",
  "session.revertDock.expand": "Expand rolled back messages",
  "session.revertDock.restore": "Restore message",
  "session.lostFolder.title": "This chat's folder is missing",
  "session.lostFolder.description":
    "It was working in {{folder}}, which is no longer there. Nova moved it to a temporary folder so it could keep going. If the folder moved, point this chat at the new one.",
  "session.lostFolder.choose": "Choose folder",
  "session.lostFolder.moving": "Moving…",
  "session.lostFolder.moved": "This chat now works in the folder you chose",
  "session.lostFolder.error": "Could not move this chat to that folder",
  "session.providerRecovery.title": "A previous reply was interrupted",
  "session.providerRecovery.description":
    "NovaClaw could not confirm that the reply finished. Continue when you are ready; the interrupted turn will not run again automatically.",
  "session.providerRecovery.toolDescription":
    "A tool may have changed something before the interruption. Check its target, then continue—NovaClaw will not run it again automatically.",
  "session.providerRecovery.resume": "Continue safely",
  "session.providerRecovery.resuming": "Continuing…",
  "session.providerRecovery.error": "Couldn’t continue",
  "session.revertDock.discard": "Delete {{count}} rolled back",
  "session.revertDock.discard.confirm.title": "Delete the rolled back messages?",
  "session.revertDock.discard.confirm.description":
    "{{count}} rolled back messages will be permanently deleted, along with everything that followed them. This cannot be undone — Restore puts them back instead.",
  "session.revertDock.discard.confirm.action": "Delete permanently",

  "session.revert.confirm.title": "Revert to this prompt?",
  "session.revert.confirm.description":
    "This rewinds the chat to before this prompt: it and every later message are removed, and your working files are restored to that point. The prompt is placed back in the composer to edit and resend. This can't be undone.",
  "session.revert.confirm.action": "Revert",
  "session.revert.error.title": "Revert failed",
  "session.revert.error.description": "Could not revert to this prompt. Check the server logs and try again.",

  "session.responderDock.operator": "You have control",
  "session.responderDock.operatorHint": "Nova is paused — you're replying in this conversation for now.",
  "session.responderDock.handBack": "Hand back to Nova",
  "session.responderDock.takeOver": "Take control",

  "session.new.title": "Build anything",
  "session.new.project.new": "New project",
  "session.new.project.search": "Search projects",
  "session.new.project.add": "Add project",
  "session.new.worktree.main": "Main branch",
  "session.new.worktree.mainWithBranch": "Main branch ({{branch}})",
  "session.new.workspace.runIn": "Run chat in",
  "session.new.workspace.triggerLocal": "Local",
  "session.new.workspace.local": "Local repository",
  "session.new.workspace.existing": "Workspace…",
  "session.new.lastModified": "Last modified",

  "session.header.search.placeholder": "Search {{project}}",
  "session.header.searchFiles": "Search files",
  "session.header.openIn": "Open in",
  "session.header.open.action": "Open {{app}}",
  "session.header.open.ariaLabel": "Open in {{app}}",
  "session.header.open.menu": "Open options",
  "session.header.open.copyPath": "Copy path",
  "session.header.open.finder": "Finder",
  "session.header.open.fileExplorer": "File Explorer",
  "session.header.open.fileManager": "File Manager",
  "session.header.open.app.vscode": "VS Code",
  "session.header.open.app.cursor": "Cursor",
  "session.header.open.app.zed": "Zed",
  "session.header.open.app.textmate": "TextMate",
  "session.header.open.app.antigravity": "Antigravity",
  "session.header.open.app.terminal": "Terminal",
  "session.header.open.app.iterm2": "iTerm2",
  "session.header.open.app.ghostty": "Ghostty",
  "session.header.open.app.warp": "Warp",
  "session.header.open.app.xcode": "Xcode",
  "session.header.open.app.androidStudio": "Android Studio",
  "session.header.open.app.powershell": "PowerShell",
  "session.header.open.app.sublimeText": "Sublime Text",

  "status.popover.trigger": "Status",
  "status.popover.ariaLabel": "Server configurations",
  "status.popover.tab.servers": "Servers",
  "status.popover.tab.mcp": "Connections",
  "status.popover.action.manageServers": "Manage servers",

  "session.share.popover.title": "Publish on web",
  "session.share.popover.description.shared":
    "This session is public on the web. It is accessible to anyone with the link.",
  "session.share.popover.description.unshared":
    "Share session publicly on the web. It will be accessible to anyone with the link.",
  "session.share.action.share": "Share",
  "session.share.action.publish": "Publish",
  "session.share.action.publishing": "Publishing...",
  "session.share.action.unpublish": "Unpublish",
  "session.share.action.unpublishing": "Unpublishing...",
  "session.share.action.view": "View",
  "session.share.copy.copied": "Copied",
  "session.share.copy.copyLink": "Copy link",

  "prompt.loading": "Loading prompt...",
  "expertise.gate.hint":
    "Your experience level decides how much of NovaClaw is on show. You can change it whenever you like, and change it back — nothing is deleted either way.",
  "expertise.gate.change": "Change experience level",
  "expertise.gate.home": "Back to home",
  "terminal.gate.description":
    "A terminal is a place to type commands directly to the machine this instance runs on — handy for checking on a service or fixing something by hand, and easy to get wrong if you have never used one. It appears once you switch to the Advanced level.",
  "debug.gate.description":
    "Debug is the view under the hood: which servers are connected, the error log, the instance's own log, and every session that is running right now with its internal id. Nothing here is needed to use NovaClaw — it is for working out why something misbehaved. It appears once you switch to the Developer level.",
  "registry.gate.description":
    "The Registry opens the database this instance keeps — your settings, sessions and records — as raw tables you can edit directly. Nothing asks you to confirm, and one wrong row can stop the instance from starting, so it appears once you switch to the Developer level.",
  "terminal.clear": "Clear",
  "terminal.find.label": "Find",
  "terminal.find.close": "Close find",
  "terminal.find.none": "No matches",
  "terminal.find.count": "{{index}} of {{total}}",
  "terminal.exited.title": "The shell ended",
  "terminal.exited.description":
    "It stopped with exit code {{code}}. Whatever it printed is still above — start a new shell when you have read it.",
  "terminal.exited.newShell": "New shell",
  "terminal.loading": "Loading terminal...",
  "terminal.unavailable.title": "The terminal could not start",
  "terminal.unavailable.description":
    "NovaClaw could not ask this instance where to open a shell, so nothing has started. The instance may be restarting — this is not a problem with your machine.",
  "terminal.unavailable.retry": "Try again",
  "terminal.title": "Terminal",
  "terminal.title.numbered": "Terminal {{number}}",
  "terminal.close": "Close terminal",
  "terminal.closeFailed": "Could not stop terminal",
  "terminal.closeRunning.action": "Stop and close",
  "terminal.closeRunning.title": "Stop the running command?",
  "terminal.closeRunning.description":
    "This terminal still has a command running. Closing it will stop that command and anything it started.",
  "terminal.closeRunning.unknownDescription":
    "NovaClaw could not check whether this terminal still has a command running. Closing it may stop unfinished work.",
  "terminal.stopAll.action": "Stop all",
  "terminal.stopAll.title": "Stop all terminals?",
  "terminal.stopAll.description":
    "This ends every terminal and command started from the Terminal app on {{server}}. This cannot be undone.",
  "terminal.stopAll.stopping": "Stopping...",
  "terminal.stopAll.done": "Terminals stopped",
  "terminal.stopAll.doneDescription": "Stopped {{count}} terminal(s).",
  "terminal.stopAll.failed": "Could not stop terminals",
  "terminal.connectionLost.title": "Connection Lost",
  "terminal.connectionLost.abnormalClose": "Connection dropped unexpectedly (code {{code}})",
  "terminal.connectionLost.description":
    "The terminal connection was interrupted. This can happen when the server restarts.",
  "terminal.connectionLost.retry": "Reconnect",
  "terminal.connectionLost.copy": "Copy details",
  "terminal.connectionLost.copied": "Copied",

  "common.closeTab": "Close tab",
  "common.dismiss": "Dismiss",
  "common.moreCountSuffix": " (+{{count}} more)",
  "common.requestFailed": "Request failed",
  "common.moreOptions": "More options",
  "common.learnMore": "Learn more",
  "common.rename": "Rename",
  "common.delete": "Delete",
  "common.close": "Close",
  "common.edit": "Edit",
  "common.key.esc": "ESC",
  "common.key.ctrl": "Ctrl",
  "common.key.alt": "Alt",
  "common.key.shift": "Shift",
  "common.key.meta": "Meta",
  "common.key.space": "Space",
  "common.key.backspace": "Backspace",
  "common.key.enter": "Enter",
  "common.key.tab": "Tab",
  "common.key.delete": "Delete",
  "common.key.home": "Home",
  "common.key.end": "End",
  "common.key.pageUp": "Page Up",
  "common.key.pageDown": "Page Down",
  "common.key.insert": "Insert",
  "common.unknown": "unknown",

  "common.time.justNow": "Just now",
  "common.time.minutesAgo.short": "{{count}}m ago",
  "common.time.hoursAgo.short": "{{count}}h ago",
  "common.time.daysAgo.short": "{{count}}d ago",

  "debugBar.ariaLabel": "Development performance diagnostics",
  "debugBar.na": "n/a",
  "debugBar.nav.label": "NAV",
  "debugBar.nav.tip":
    "Last completed route transition touching a session page, measured from router start until the first paint after it settles.",
  "debugBar.fps.label": "FPS",
  "debugBar.fps.tip": "Rolling frames per second over the last 5 seconds.",
  "debugBar.frame.label": "FRAME",
  "debugBar.frame.tip": "Worst frame time over the last 5 seconds.",
  "debugBar.jank.label": "JANK",
  "debugBar.jank.tip": "Frames over 32ms in the last 5 seconds.",
  "debugBar.long.label": "LONG",
  "debugBar.long.tip": "Blocked time and long-task count in the last 5 seconds. Max task: {{max}}.",
  "debugBar.delay.label": "DELAY",
  "debugBar.delay.tip": "Worst observed input delay in the last 5 seconds.",
  "debugBar.inp.label": "INP",
  "debugBar.inp.tip":
    "Approximate interaction duration over the last 5 seconds. This is INP-like, not the official Web Vitals INP.",
  "debugBar.cls.label": "CLS",
  "debugBar.cls.tip": "Cumulative layout shift for the current app lifetime.",
  "debugBar.mem.label": "MEM",
  "debugBar.mem.tipUnavailable": "Used JS heap vs heap limit. Chromium only.",
  "debugBar.mem.tip": "Used JS heap vs heap limit. {{used}} of {{limit}}.",

  "settings.section.desktop": "Settings",
  "settings.section.server": "Server",
  "settings.section.safety": "Safety",
  "settings.tab.general": "General",
  "settings.tab.appearance": "Appearance",
  "settings.tab.instances": "Instances",
  "settings.tab.shortcuts": "Shortcuts",
  // ⚠️ "Health", one word (owner, 2026-08-20: the old "Health & recovery" was "offensively long" for
  // a rail label). It was renamed there on 2026-08-19 to keep the health report discoverable, and the
  // shorter word does that job too — a worried person still reads their own question. A rail is an
  // INDEX, not a place to explain: the tab's own header says it covers recovery as well. The 17
  // translated bundles still say the older word; that is translation backlog, not a fork.
  "settings.tab.recovery": "Health",
  "settings.tab.about": "About",
  "settings.usage.title": "Usage",
  "settings.usage.description":
    "What this instance has spent, in tokens and money. Counted from your own sessions on this machine \u2014 nothing is sent anywhere to produce it.",
  "settings.usage.window.all": "All time",
  "settings.usage.window.days": "Last {{days}} days",
  "settings.usage.totals": "Totals",
  "settings.usage.sessions": "Sessions",
  "settings.usage.messages": "Messages",
  "settings.usage.cost": "Total cost",
  "settings.usage.costPerDay": "Average per day",
  "settings.usage.tokensIn": "Input tokens",
  "settings.usage.tokensOut": "Output tokens",
  "settings.usage.cacheRead": "Cache reads",
  "settings.usage.tokensPerSession": "Average tokens per chat",
  "settings.usage.byModel": "By model",
  "settings.usage.byTool": "By tool",
  "settings.usage.empty":
    "Nothing to report yet \u2014 this instance has no finished chats. The numbers appear as you use it.",
  "settings.usage.unreachable":
    "Nova could not be reached to read these numbers. Nothing has been lost; try again in a moment.",
  "settings.tab.storage": "Storage",

  // The one message every settings number box refuses with. It names the RANGE, because a control
  // that rejects a value without saying which values it wants is the c64-memory-poke the settings
  // rules exist to end — and because the alternative the boxes used to do (silently clamp the
  // half-typed value and write it) made the legal value unreachable.
  "settings.field.number.range": "Enter a whole number between {{min}} and {{max}}",
  "settings.field.number.rangeDecimal": "Enter a number between {{min}} and {{max}}",

  "settings.tunes.title": "Tunes",
  "settings.nudges.title": "Nudges",
  "settings.nudges.description":
    "Give agents a short instruction only when it is useful. Choose a built-in event or match text with a regular expression; nothing is added to every prompt.",
  "settings.nudges.add": "Add nudge",
  "settings.nudges.edit": "Edit nudge",
  "settings.nudges.toast.failed": "Couldn't save nudges",
  "settings.nudges.confirm.title": "Delete this nudge?",
  "settings.nudges.confirm.description": "“{{name}}” will stop guiding agents. This cannot be undone.",
  "settings.nudges.field.name": "Name",
  "settings.nudges.field.text": "Instruction shown to the agent",
  "settings.nudges.field.pattern": "Regular expression",
  "settings.nudges.field.tool": "Tool name, for example bash",
  "settings.nudges.field.mcp": "MCP server name",
  "settings.nudges.field.extension": "File extension, for example ts",
  "settings.nudges.agents.description": "Who receives this nudge. All agents is the default.",
  "settings.nudges.agents.all": "All agents",
  "settings.nudges.error.name": "Give this nudge a name.",
  "settings.nudges.error.text": "Write the instruction the agent should receive.",
  "settings.nudges.error.pattern": "This regular expression isn't valid.",
  "settings.nudges.error.hook": "Complete the selected trigger.",
  "settings.nudges.error.duplicate": "This nudge already exists.",
  "settings.nudges.hook.text-match": "Text matches a regular expression",
  "settings.nudges.hook.tool-call": "A specific tool is called",
  "settings.nudges.hook.mcp-call": "A tool from an MCP server is called",
  "settings.nudges.hook.file-read": "A file type is read",
  "settings.nudges.hook.file-write": "A file type is written",
  "settings.nudges.hook.after-compaction": "After context compaction",
  "settings.nudges.hook.resource-pressure": "When resources run low",
  "settings.nudges.hook.time-of-day": "During a time of day",
  "settings.nudges.resource.either": "Warning or critical",
  "settings.nudges.resource.warning": "Warning only",
  "settings.nudges.resource.floor": "Critical only",
  "settings.tunes.description":
    "Choose how NovaClaw protects the instructions, conversation, recalled memory, knowledge, and tool evidence that a model needs to keep working.",
  "settings.tunes.toast.failed": "Saving Tune settings failed",
  "settings.tunes.context.enabled.title": "Context guard",
  "settings.tunes.context.enabled.description": "Keep one kind of context from crowding out the others.",
  "settings.tunes.context.enabled.description.more": "System instructions and the original task are always protected.",
  "settings.tunes.todo.enabled.title": "Checklist reminders",
  "settings.tunes.todo.enabled.description":
    "Periodically put the current task list back in front of the model so long jobs stay on course.",
  "settings.tunes.todo.cadence.title": "Reminder cadence",
  "settings.tunes.todo.cadence.description": "How many saved chat messages pass between checklist reminders.",
  "settings.tunes.todo.budget.title": "Reminder budget",
  "settings.tunes.todo.budget.description":
    "The most context a reminder may use. Active work is kept first when the checklist is longer.",
  "settings.tunes.profiles.title": "Context profiles",
  "settings.tunes.profiles.description":
    "NovaClaw chooses a profile from the chat's working mode. Attended chats preserve more conversation; unattended workers reserve more room for tool evidence.",
  "settings.tunes.profile.interactive": "Interactive chat",
  "settings.tunes.profile.sub-agent": "Sub-agent",
  "settings.tunes.profile.auto-prompting": "Auto-prompting",
  "settings.tunes.profile.goal-oriented": "Goal-oriented",
  "settings.tunes.profile.total": "{{total}}% allocated",
  "settings.tunes.category.system": "Instructions",
  "settings.tunes.category.system.description": "System guidance and the agent's operating rules.",
  "settings.tunes.category.messages": "Conversation",
  "settings.tunes.category.messages.description": "User and assistant messages, including the original task anchor.",
  "settings.tunes.category.retrieval": "Knowledge retrieval",
  "settings.tunes.category.retrieval.description": "Results recalled from the durable knowledge base.",
  "settings.tunes.category.memory": "Memory",
  "settings.tunes.category.memory.description": "Personal and session memories recalled before the turn.",
  "settings.tunes.category.tool_output": "Tool output",
  "settings.tunes.category.tool_output.description": "Evidence returned by files, commands, browsers, and other tools.",

  // The Storage tab: what the instance costs in RAM/on disk and where its files live.
  "settings.storage.title": "Storage and resources",
  "settings.storage.description":
    "See what this instance uses in memory and on disk, where its files live, and unload a local model when you need the space.",
  "settings.storage.locations.title": "Where files live",
  "settings.storage.locations.description":
    "Useful for backing up, inspecting, or moving this instance. These locations are chosen when NovaClaw starts, so they are shown here rather than edited.",
  "settings.storage.copy": "Copy path",
  "settings.storage.open": "Open folder",
  "settings.storage.copied": "Path copied",
  "settings.storage.copyFailed": "Could not copy the path",
  "settings.storage.openFailed": "Could not open that folder",
  "settings.storage.instanceHome": "Instance home",
  "settings.storage.instanceHome.description":
    "This instance was started with --home, so everything lives in one folder.",
  "settings.storage.instanceHome.description.more":
    "Copy or delete it and you copy or delete the whole instance. Run another NovaClaw with a different --home to keep two independent instances on one machine.",
  "settings.storage.config": "Settings",
  "settings.storage.config.description":
    "Your settings. They are stored in the database below; this folder is only used to import or export a settings file.",
  "settings.storage.data": "Data",
  "settings.storage.data.description": "Chats, knowledge, recipes, notes and downloaded files.",
  "settings.storage.db": "Database",
  "settings.storage.db.description":
    "The single SQLite file holding your settings, chats and sessions. This is the one file to copy if you want to back up or move an instance — close NovaClaw first.",
  "settings.storage.scratch": "Scratch folder",
  "settings.storage.scratch.description":
    "Where an agent works when you start a chat without picking a folder. Safe to empty when nothing is running.",
  "settings.storage.log": "Logs",
  "settings.storage.log.description": "Diagnostic logs. Handy when reporting a problem.",
  // The activity-log retention row. Anti-obscurantist wording is mandatory
  // here: "Keep about 30 days of activity logs", never "retention: 30". "About" is exact: age
  // deletion only sees closed segments, while the independent byte ceiling may reclaim them sooner.
  "settings.storage.logs.title": "Activity log",
  "settings.storage.logs.description":
    "NovaClaw writes down what it does, so a problem can be explained instead of guessed at. This log stays on your computer — it is not the crash reporting you can switch off in Developer settings.",
  "settings.storage.logs.retention": "How much is kept",
  "settings.storage.logs.retention.description":
    "Keeps about {{days}} days of activity when space allows, and never more than {{size}} in total. Older entries are compressed, and the oldest are removed first.",
  "settings.storage.logs.retention.value": "{{days}} days · up to {{size}}",
  "settings.storage.logs.retention.days": "Keep about {{days}} days",
  "settings.storage.logs.level": "How much detail to write",
  "settings.storage.logs.level.description": "Info is the calm everyday record.",
  "settings.storage.logs.level.description.more":
    "Choose Debug while investigating a problem; Warn or Error keeps only increasingly serious events.",
  "settings.storage.logs.level.debug": "Debug · everything",
  "settings.storage.logs.level.info": "Info · everyday activity",
  "settings.storage.logs.level.warn": "Warn · problems only",
  "settings.storage.logs.level.error": "Error · failures only",
  "settings.storage.logs.subsystems.title": "Per-area detail",
  "settings.storage.logs.subsystems.description":
    "Developer controls for making one part of the instance more or less chatty without changing the rest. These changes take effect immediately.",
  "settings.storage.logs.saveFailed": "Could not change activity-log settings",
  "settings.storage.trash.title": "Trash",
  "settings.storage.trash.description": "Choose how long deleted files remain recoverable.",
  "settings.storage.trash.retention": "How long Trash keeps files",
  "settings.storage.trash.retention.description":
    "Deleted files stay recoverable for about {{days}} days, then cleanup removes them on a later Trash change.",
  "settings.storage.trash.retention.days": "Keep about {{days}} days",
  "settings.storage.state": "State",
  "settings.storage.state.description": "Window layout and other small bits of local state.",
  "settings.storage.cache": "Cache",
  "settings.storage.cache.description": "Regenerated automatically; safe to delete.",
  "settings.storage.tmp": "Temporary files",
  "settings.storage.tmp.description": "Short-lived working files. Cleared by the operating system.",

  // The heading over the three undo rungs. It exists because this tab now has TWO parts — the health
  // report first, then the ways back — and an unlabelled list under a report would read as more of
  // the report. ENGLISH-ONLY like its neighbours; translate properly or leave it out.
  // The after-a-crash behaviour switch. Plain language and no jargon: a person opening this tab is
  // worried, and "resumeInterrupted" / "execution lease" mean nothing to them (principle 12c).
  "settings.recovery.section.afterCrash": "After a crash",
  "settings.recovery.row.resumeInterrupted.title": "Pick work back up",
  "settings.recovery.row.resumeInterrupted.description":
    "If Nova is interrupted mid-task — a crash, a restart, a power cut — carry on where it left off.",
  "settings.recovery.row.resumeInterrupted.description.more":
    "Nova never blindly repeats unfinished actions. If it cannot be sure whether a file or external action finished, " +
    "the officer first inspects what is actually there, then continues. Anything that has already failed several " +
    "times in a row still waits for you. Turn this off if you would " +
    "rather decide every restart yourself; nothing is lost either way, it simply waits.",
  "settings.recovery.section.restore": "Ways back",
  "settings.recovery.row.resetUi.title": "Reset appearance and layout",
  "settings.recovery.row.resetUi.description": "Reset how NovaClaw looks and is laid out back to the defaults.",
  "settings.recovery.row.resetUi.description.more":
    "Theme, the welcome tour, and view options. Your chats, files, and connected models are kept.",
  "settings.recovery.row.resetUi.action": "Reset",
  "settings.recovery.row.resetUi.confirm": "Click again to confirm",
  "settings.recovery.row.factory.title": "Factory reset",
  "settings.recovery.row.factory.description":
    "Erase all chats, sessions and configuration on this device and start fresh. Coming soon.",
  "settings.recovery.row.factory.action": "Erase everything",
  "settings.recovery.row.snapshots.title": "Snapshots",
  "settings.recovery.row.snapshots.description": "Roll the workspace back to an earlier point in time.",
  "settings.recovery.row.snapshots.description.more":
    "File deletions already land in a dated Trash; full workspace snapshots are coming soon.",
  "settings.recovery.row.snapshots.action": "Browse snapshots",

  // The Appearance tab's visual section (color scheme/theme/fonts) — "Visual", since the tab title is
  // already "Appearance" and the tab also holds Sound Effects.
  "settings.appearance.section.visual": "Visual",
  // Color-scheme presets (uix.md §7).
  "settings.appearance.theme.title": "Color scheme",
  "settings.appearance.theme.description":
    "Pick a color palette. Each pairs one warm highlight color with a calm background.",
  "settings.appearance.theme.nova": "Nova",
  "settings.appearance.theme.summer": "Summer",
  "settings.appearance.theme.autumn": "Autumn",
  "settings.general.section.notifications": "System notifications",
  "settings.general.section.updates": "Updates",
  "settings.general.section.sounds": "Sound effects",

  "settings.general.row.instance.title": "Connected instance",
  "settings.general.row.instance.description":
    "Which NovaClaw instance this window is talking to. Pick another to point the whole UI at it.",
  "settings.general.row.instance.default": "default",
  "settings.general.row.instance.temporary":
    "Temporarily connected — this window returns to {{default}} (the default) next launch.",
  "settings.general.row.instance.return": "Return to default",
  "settings.instances.discovered.title": "Discovered on your network",
  "settings.instances.discovered.rescan": "Scan again",
  "settings.instances.discovered.add": "Add this instance",
  // The pointer at the very top of General, and the reason it is the FIRST thing in that tab. The
  // health report itself moved to Health & recovery; the argument that used to keep it in General —
  // a worried person must not read a language picker first — is preserved by this row plus the
  // report leading its new tab plus the tab's new name. Deliberately a control (a button that
  // navigates), not a summary: a second place that states the verdict is a second place for the
  // verdict to be stale, and this tab is not where findings live any more.
  // ENGLISH-ONLY like its neighbours; translate properly or leave the keys out.
  "settings.general.row.health.title": "Is something wrong?",
  "settings.general.row.health.description": "Checks this instance and says what to do about anything it finds.",
  "settings.general.row.health.description.more":
    "It looks at its models, its storage, and how far the agent's shell is boxed in on this machine. It is also where the ways back live, if you need one.",
  "settings.general.row.health.action": "Open health & recovery",
  "settings.health.title": "Is anything wrong?",
  "settings.health.checking": "Checking…",
  "settings.health.unreachable": "This instance could not be reached, so nothing below was checked.",
  "settings.health.recheck": "Check again",
  "settings.health.testProvider": "Test the connection to my model provider",
  "settings.health.notifications.title": "Recent notifications",
  "settings.health.notifications.description": "Pop-ups fade away, but their recent messages remain here for 30 days.",
  "settings.health.notifications.notice": "Notification",
  "settings.health.notifications.error": "{{session}} needs attention",
  "settings.health.notifications.complete": "{{session}} finished a reply",
  "settings.health.notifications.empty": "No recent notifications",
  "settings.health.notifications.emptyDescription":
    "Notifications that fade from the screen will remain reviewable here.",
  "settings.health.logs.export": "Download all logs",
  "settings.health.logs.exporting": "Preparing logs…",
  "settings.health.logs.exported": "Logs downloaded",
  "settings.health.logs.failed": "Could not download logs",
  // Erase Memory (owner, 2026-08-22) — for starting a run from a clean slate without reinstalling.
  // ⚠️ The wording names WHOSE memory goes, because "erase memory" reads as "this chat's" to most
  // people and the actual scope is every colleague on the roster plus Nova.
  // ⚠️ NOT "Erase everything…" — the Health tab already carries a control by that name and it is the
  // FULL install reset. Two danger-styled buttons on one screen whose labels start with the same
  // words is how somebody reaching for "just the memories" wipes their instance. This one names what
  // goes (memory) and shares no leading word with the other; the owner's framing was the contrast
  // itself: erase the RAGs "without resetting entire Novaclaw install".
  "settings.health.eraseMemory": "Erase all agent memory",
  "settings.health.eraseMemory.confirm.title": "Erase all memory?",
  "settings.health.eraseMemory.confirm.description":
    "Every memory every colleague has — Nova included — is deleted permanently. Their chats, briefs and settings are untouched, and nothing is archived: this cannot be undone. Use it to start a run from a clean slate.",
  "settings.health.eraseMemory.confirm.action": "Erase all memory",
  "settings.health.eraseMemory.erasing": "Erasing…",
  "settings.health.eraseMemory.done": "Erased {{count}} memories — every agent starts fresh",
  "settings.health.eraseMemory.empty": "There was nothing to erase",
  "settings.health.eraseMemory.failed": "Could not erase memory",
  // Community P1 — the instance identity. Plain language on purpose: a user who does not grasp that
  // the backup file IS their instance will store it carelessly, and there is no reset if they do.
  "settings.identity.title": "This instance's identity",
  "settings.identity.networkID": "Instance key",
  "settings.identity.networkIDDescription": "Share this so others can add you",
  "settings.identity.networkIDHint":
    "Your instance's public key. It is how other people's NovaClaw recognises yours — the address behind it can change, this cannot.",
  "settings.identity.copy": "Copy",
  "settings.identity.copied": "Copied",
  "settings.identity.backupTitle": "Back up this identity",
  "settings.identity.backupDescription": "Save a copy you can restore after a disk failure",
  "settings.identity.backupHint":
    "The saved file IS this instance: anyone who has it can act as you, and nobody can undo that. Keep it somewhere private. Without it, a lost disk loses your identity, the people you know and your history for good — there is no way to reset it.",
  "settings.identity.backupAction": "Back up…",
  "settings.identity.backupConfirm": "Save the file somewhere private.",
  "settings.identity.backupProceed": "Save backup",
  "settings.identity.backupBusy": "Saving…",
  "settings.identity.backupCancel": "Cancel",
  "settings.identity.restoreTitle": "Restore an identity",
  "settings.identity.restoreDescription": "Become the same peer again on a rebuilt machine",
  "settings.identity.restoreHint":
    "Load a file saved by Back up. Everyone who knew the old instance keeps knowing you — the people you know, channels and history stay attached to the key, not to the machine.",
  "settings.identity.restoreAction": "Restore…",
  "settings.identity.restoreChosen":
    "This replaces the identity below, and there is no way to undo it. Contacts and channels that know the current key lose you — and anything already said from this instance stays in its rooms but stops being yours, because it was signed by the key you are replacing.",
  "settings.identity.restoreProceed": "Replace identity",
  "settings.identity.restoreBusy": "Restoring…",
  "settings.identity.restoreCancel": "Cancel",
  "settings.identity.restoreDone": "Restored. This instance is now {id}.",
  "settings.identity.restoreUnreadable": "That file is not an identity backup.",
  "settings.identity.rotateTitle": "Move to a new key",
  "settings.identity.rotateDescription": "Keep your name and history when you change machines or keys",
  // ⚠️ States the limit FIRST, because the wrong reason to press this is the one people arrive with.
  // A stolen key can rotate itself, faster than its owner, who has to notice the theft first.
  "settings.identity.rotateHint":
    "Your instance gets a new key, signed by the old one, and everyone who can reach you follows it — so people who know you keep knowing you, and what you have already said keeps its author. This does NOT undo a stolen key: whoever has your old key can do exactly this, sooner than you can. It is for planned moves.",
  "settings.identity.rotateAction": "Move to a new key…",
  "settings.identity.rotateConfirm": "Your old key stops being you. Peers that never hear about it lose you.",
  "settings.identity.rotateProceed": "Move",
  "settings.identity.rotateBusy": "Moving…",
  "settings.identity.rotateCancel": "Cancel",
  "settings.identity.rotateDone": "Moved. {count} reachable peer(s) were told; others find out when they next ask.",
  "settings.storage.resources.title": "This instance's resources",
  // Shown as a hover/tap hint on the Host memory row, not as an always-on paragraph (owner, 2026-08-13).
  "settings.storage.resources.description":
    "How much memory the whole machine has promised to programs, against its commit limit — the number that predicts running out. The RAM figures below are resident memory; SQLite and the knowledge base live inside NovaClaw's process.",
  "settings.storage.resources.loading": "Measuring this instance…",
  "settings.storage.resources.hostMemory": "Host memory pressure",
  "settings.storage.resources.memoryValue": "{{used}} committed of {{total}} commit limit",
  "settings.storage.resources.disk": "Disk use",
  "settings.storage.resources.unknown": "not measurable",
  "settings.storage.resources.localModel": "Managed local model",
  "settings.storage.resources.stop": "Stop / cancel",
  "settings.general.row.language.title": "Language",
  "settings.general.row.language.description": "Change the language NovaClaw is shown in.",
  "settings.general.row.shell.title": "Terminal Shell",
  "settings.general.row.shell.description":
    "Choose the shell used for your terminal. Compatible shells are also used for agent tool calls.",
  "settings.general.row.shell.autoDefault": "Auto (Default)",
  "settings.general.row.shell.terminalOnly": "terminal only",
  "settings.general.row.colorScheme.title": "Mode",
  "settings.general.row.colorScheme.description":
    "Dark for now. A light preset is on the way; this unlocks when it lands.",
  "settings.general.row.theme.title": "Theme",
  "settings.general.row.theme.description":
    "Choose a full visual style, including colors and fonts. Or browse more themes.",
  "settings.general.row.font.default": "Default",
  "settings.general.row.font.custom": "Type a font name…",
  "settings.general.row.font.title": "Code Font",
  "settings.general.row.font.description": "Set the font used for code shown in chats. Leave blank to use the default.",
  "settings.general.row.terminalFont.title": "Terminal Font",
  "settings.general.row.terminalFont.description": "Customise the font used in the terminal",
  "settings.general.row.uiFont.title": "UI Font",
  "settings.general.row.uiFont.description": "Customise the font used throughout the interface",
  "settings.general.row.mobileTitlebarBottom.title": "Bottom navigation",
  "settings.general.row.mobileTitlebarBottom.description":
    "Place the title bar and session tabs at the bottom of the screen on mobile",
  "settings.general.row.defaultPermissionMode.title": "Default permission mode",
  "settings.general.row.defaultPermissionMode.description": "How much a new chat can do on its own before asking you.",
  "settings.general.row.defaultPermissionMode.description.more":
    "“Plan” and “Ask” check with you first; the higher modes act without asking, which is faster but riskier — only pick those for trusted work.",
  "settings.general.row.shellBundle.title": "Shell environment",
  "settings.general.row.shellBundle.description":
    "The bash + git substrate agents run on. Provisioning downloads the pinned PortableGit bundle (~59 MB) so every machine gets the same environment — do it before going airgapped",
  "settings.general.row.shellBundle.bundled": "Bundled PortableGit",
  "settings.general.row.shellBundle.system": "System bash",
  "settings.general.row.shellBundle.none": "No bash — agents fall back to cmd.exe",
  "settings.general.row.shellBundle.unknown": "Status unavailable",
  "settings.general.row.shellBundle.provision": "Provision",
  "settings.general.row.shellBundle.reprovision": "Re-provision",
  "settings.general.row.shellBundle.provisioning": "Provisioning…",
  "settings.general.row.telemetry.title": "Telemetry",
  "settings.general.row.telemetry.statusUnavailable": "Crash-reporting status is temporarily unavailable.",
  "settings.general.row.telemetry.statusAirgap": "Offline / airgap mode is keeping every crash report on this device.",
  "settings.general.row.telemetry.statusConsentOff": "Crash reporting is turned off on this instance.",
  "settings.general.row.telemetry.statusNoEndpoint":
    "Crash reports stay on this device because no collector is configured.",
  "settings.general.row.telemetry.statusNotReady":
    "Crash reporting is configured but the collector has not passed its intake check yet.",
  "settings.general.row.telemetry.statusReady":
    "Crash reporting is ready. You can inspect the exact payload before anything leaves this device.",
  "settings.general.row.telemetry.inspect": "See exactly what's shared",
  "settings.general.row.telemetry.controlTitle": "Crash reporting",
  "settings.general.row.telemetry.controlDescription":
    "Let NovaClaw send scrubbed crash fingerprints so we can fix faults.",
  "settings.telemetryStatus.title": "What a crash report shares",
  "settings.telemetryStatus.description":
    "This sample is made by the same code that builds a real report. Chats, code, file paths, error messages, hostnames and session IDs are never included.",
  "settings.telemetryStatus.payload": "Exact payload preview",
  "settings.telemetryStatus.fields": "Every possible field",
  // ⚠️ Ruling 2, and Kiro Crew's disclosure in spirit: when something else pins the switch off, the
  // switch says so instead of sitting there looking effective. Airgap is an INDEPENDENT veto — it
  // does not withdraw consent, it overrides it — so the copy states the override rather than
  // silently flipping the toggle the user set.
  "settings.general.row.telemetry.forcedOff": "forced off — offline/airgap mode is on",
  "settings.general.row.offline.title": "Offline mode",
  "settings.general.row.offline.description":
    "Restrict NovaClaw's network requests to local connections, configured model providers and explicitly allowed hosts. Maintenance uploads and package downloads stop. Changes apply to new requests immediately. Shell programs can ignore proxy settings; a complete airgap needs operating-system or network isolation.",
  "settings.general.row.offline.active": "on — process isolation not guaranteed",
  "settings.general.row.offline.inactive": "ready (offline mode is off)",

  // Settings → General → Confinement — the honest posture surface. ⚠️ ENGLISH-ONLY on
  // purpose, like `askBeforeChanges` and `surgicalEdits` before it: the parity ratchet fails on an
  // EXTRA key in a locale and only COUNTS a missing one, and pasting English into de.ts et al. would
  // make the translation backlog read as done. Translate properly or leave the key out.
  "settings.project.section": "Project",
  // ⚠️ EVERY sentence below NAMES the folder — see `settings-v2/project-copy.ts` for why, and
  // `project-copy.test.ts` for the check that keeps it true. These rows used to say "this folder"
  // and "add a novaclaw.json HERE" with nothing on screen saying which folder that was; on a desktop
  // launch the instance's folder is the user's home, so the invitation read as "make C:\Users\<you>
  // a Project" to a reader who had a project chat open, and twice made a working feature look broken.
  "settings.project.subject":
    "These rows describe {{directory}} — the folder this instance itself is working in. It is fixed when the instance starts and does not follow whichever chat you have open; a chat running in another folder shows that folder's own Project inside the chat.",
  "settings.project.subjectHome":
    "These rows describe your home folder, {{directory}}. This instance was not started in a working folder, so the folder it is working in is your home. It does not follow whichever chat you have open; a chat running in another folder shows that folder's own Project inside the chat.",
  "settings.project.none": "{{directory}} is not a Project",
  "settings.project.noneDetail":
    "Add a novaclaw.json to {{directory}} to give that folder its own defaults. Without one it works exactly as it does now.",
  // The home folder gets its own sentence rather than the generic invitation above. A novaclaw.json
  // at the top of your home folder is not wrong, but it governs every chat you start anywhere
  // beneath it — so the copy says what accepting the offer would actually mean instead of hiding the
  // control (teach, don't gatekeep).
  "settings.project.noneHome": "Your home folder is not a Project",
  "settings.project.noneHomeDetail":
    "That is the normal state, and usually the one you want. You can add a novaclaw.json to {{directory}} below, but a Project at the top of your home folder applies to every chat you start anywhere inside it — most people want one on a single working folder instead.",
  "settings.project.namedTitle": "{{directory}} belongs to the Project “{{name}}”",
  "settings.project.unnamedTitle": "{{directory}} belongs to a Project",
  "settings.project.rootHere": "The novaclaw.json that says so is in this folder.",
  "settings.project.rootAbove":
    "The novaclaw.json that says so is in {{root}}, above this folder — it governs this folder and everything else beneath that one.",
  "settings.project.rootLabel": "Project root",
  "settings.project.fileLabel": "Declared in",
  "settings.project.rulesLabel": "Permission rules",
  "settings.project.rulesValue": "From this folder. They can only narrow your settings, never widen them.",
  "settings.project.fileDetail": "The file that makes this folder a Project.",
  // The visible line distinguishes the two mechanisms: dedicated file/search tools resolve paths
  // and enforce this list; raw shell sees only tokens and therefore cannot make the same promise.
  // The instance-reported confinement posture selects one of these three sentences.
  "settings.project.excludeDetail.sandboxed":
    "File and search tools block these paths; raw shell screening is only best effort, though Safe mode can sandbox it on this instance.",
  "settings.project.excludeDetail.unavailable":
    "File and search tools block these paths; raw shell screening is only best effort, with no working sandbox reported on this instance.",
  "settings.project.excludeDetail.unknown":
    "File and search tools block these paths; raw shell screening is only best effort, and this instance's sandbox status is unknown.",
  "settings.project.excludeDetail.more":
    "Dedicated file and search tools enforce this path list. Raw shell screening checks direct path tokens only: it cannot see paths assembled with variables, globs, subshells, or find -exec, and hardlinks can give a file another name. Only an operating-system sandbox is a hard boundary. Turn on Safe mode in a chat's Tuning controls; it sandboxes shell commands where a backend is available and refuses them otherwise. Health & recovery shows what this instance can enforce.",
  "settings.project.rulesNone": "None — this file changes no permissions",
  "settings.project.excludeNone":
    "No paths are excluded from file and search tools; add patterns here when those tools should skip keys, credentials, personal files, or bulky folders.",
  "settings.project.excludeLabel": "Excluded paths",
  "settings.project.excludeSandboxAction": "Sandbox status",
  "settings.project.invalid": "The novaclaw.json in {{directory}} could not be used",
  "settings.project.invalidFuture":
    "It was written by a newer NovaClaw. Update NovaClaw to use it — the file itself is probably fine.",
  "settings.project.invalidBroken": "The file could not be read: {{detail}}",

  // ── Settings → Pre-action policies, and the chat sheet's "what a policy did" section ──────────
  //
  // The gap: a policy could refuse a tool call, rewrite its arguments or hold it for a
  // human, and NONE of that was visible anywhere. Two surfaces read these keys — Settings (what is
  // installed, and the switch) and the chat details sheet (what actually happened in this chat).
  //
  // 🔴 Two rules run through every sentence below and must survive any edit:
  //  1. **A policy's own words are the policy's, not ours.** `{{describe}}`, `{{detail}}` and every
  //     `{{id}}` are supplied by whoever wrote the policy. The copy therefore attributes rather
  //     than asserts — "the policy says", never "this policy is safe".
  //  2. **An empty list is a SENTENCE, not a hidden section.** A chat where nothing intervened says
  //     so; hiding the section would trade the one claim this feature exists to make for silence.
  //
  // ⚠️ ENGLISH-ONLY on purpose, like the Confinement and Project blocks above: the parity ratchet
  // fails on an EXTRA key in a locale and only COUNTS a missing one, so pasting English into de.ts
  // would make the translation backlog read as done.
  "policies.section": "Checks before every tool",
  "policies.inForce.none":
    "Right now: nothing is installed, so no check runs before a tool. NovaClaw normally ships two — if this stays empty, something has gone wrong with this instance.",
  "policies.inForce.all":
    "Right now: {{count}} installed, and all of them run. Each one sees a tool call before it happens and may add a note, correct it, ask you first, or refuse it.",
  "policies.inForce.some":
    "Right now: {{count}} installed, and {{off}} switched off. The rest see a tool call before it happens and may add a note, correct it, ask you first, or refuse it.",
  "policies.toggle.failed":
    "“{{id}}” did not change — saving failed, so the switch is back where it was. Nothing about this check has moved.",
  "policies.inForce.title": "What runs before a tool",
  "policies.hint":
    "These are installed with NovaClaw, not written here — a folder can ask for one by name below, and no file can ever add a command of its own.",
  "policies.row.describes": "It says: “{{describe}}”",
  "policies.row.optIn": "Only runs in folders whose novaclaw.json asks for it by name.",
  "policies.row.advisory": "Advisory: if it stops answering, your tool call still runs.",
  "policies.row.safetyCritical": "If it stops answering, tool calls are refused until it does — on purpose.",
  "policies.row.off": "Switched off — it is not consulted at all.",
  "policies.row.requestedHere": "This folder asks for it by name.",
  // 🔴 Says out loud why this row has no entry in the folder's list below. A folder may ADD a check
  // and may never take one away, so a check that already runs everywhere is not something a folder
  // gets an opinion about — and a reader who could not see that would reasonably conclude the list
  // below was simply incomplete.
  "policies.row.everywhere":
    "Runs in every folder already. A folder can ask for a check by name, and can never switch one off.",
  "policies.folder.title": "What this folder asks for",
  "policies.folder.none": "Nothing — this folder takes whatever is installed and switched on.",
  "policies.folder.requested": "{{file}} asks for: {{ids}}",
  "policies.folder.missing.title": "Every tool in this folder is being refused",
  "policies.folder.missing":
    "{{file}} asks for {{ids}}, which is not installed here. A check that was asked for and is missing is not the same as no check, so NovaClaw refuses rather than run the folder unguarded. Install it, or remove that line from the file.",
  "policies.folder.disabled.title": "Every tool in this folder is being refused",
  "policies.folder.disabled":
    "{{file}} asks for {{ids}}, and you have switched it off. Switch it back on above, or remove that line from the file.",

  // ── The folder's list, as something a person can CHANGE ───────────────────────────────────────
  //
  // The gap: *"a folder's policy list is READ-ONLY in the app — wants the section-scoped
  // write Permissions got."* Until this block existed the only way to change it was to hand-edit
  // JSON, which is the "poke memory bytes" principle 12 was raised against.
  //
  // 🔴 The one law every sentence here has to keep visible: a folder may only ever ADD a check.
  // There is no spelling in a novaclaw.json for "do not run that one here", and there must not be —
  // a folder that could remove a guard is a cloned repository disarming the user's rails.
  "policies.folder.edit.title": "Ask for a check in this folder",
  "policies.folder.edit.description":
    "A folder's novaclaw.json can name the checks it wants running while you work in it. Saving here writes only that list — the rest of the file is left exactly as it was.",
  "policies.folder.edit.narrowing":
    "A folder can only ever ADD a check. Nothing written here can stop a check this NovaClaw installed from running — that switch is yours, above.",
  "policies.folder.edit.elsewhere":
    "The file governing this folder is {{file}}, which lives in a folder above it. Saving here would create a second file that takes over from it completely — its Tune, its permissions and its excluded-path list along with this — so the list is read-only here. Edit {{file}} instead.",
  "policies.folder.edit.empty": "This folder asks for nothing, so it runs whatever is installed and switched on.",
  "policies.folder.edit.remove": "Remove",
  "policies.folder.edit.add": "Ask for it",
  "policies.folder.edit.addPlaceholder": "the id of a check",
  "policies.folder.edit.addFallback":
    "Installed on another machine but not this one? Type its id. ⚠️ Until it is installed here too, every tool call in this folder is refused — NovaClaw will not run a folder that asked to be guarded and is not.",
  "policies.folder.edit.nothingToOffer":
    "There is nothing left to add: this folder already asks for every check installed here.",
  // 🔴 The consequence of ticking a check that already runs everywhere, said BEFORE the control. It
  // is not a warning against doing it — it is a real and safe thing to declare — but nobody would
  // predict it from a tick box, and finding out by having every tool call refused is the wrong way.
  "policies.folder.edit.alwaysOnCost":
    "Asking for a check that already runs in every folder changes nothing while it is switched on. If you ever switch it off above, every tool call in this folder is refused instead — which is the point: the folder is saying it must never run unguarded.",
  "policies.folder.edit.preview": "Saving writes: {{list}}",
  "policies.folder.edit.previewClear": "Saving removes the list from the file entirely.",
  "policies.folder.edit.save": "Save this folder's list",
  "policies.folder.edit.saving": "Saving…",
  "policies.folder.edit.receipt.refused":
    "Not written: {{list}}. That is not the id of a check — a novaclaw.json names a check by id and can never carry a command. Everything else in the list was saved.",
  "policies.folder.edit.status.running": "Installed here and switched on: it runs in this folder.",
  "policies.folder.edit.status.switchedOff":
    "Installed here and switched OFF, so every tool call in this folder is refused. Switch it on above, or remove it here.",
  "policies.folder.edit.status.missing":
    "Not installed here, so every tool call in this folder is refused until it is. Install it, or remove it here.",
  "policies.folder.edit.status.alwaysOn":
    "Already runs in every folder, so this changes nothing today. If you switch it off above, every tool call in this folder is refused rather than run unguarded.",

  // ── Settings → Project → the folder's permission rules, and where the OTHER rules come from ──
  //
  // 🔴 The sentences here carry the one thing a person needs when a tool call was refused: WHICH of
  // the three sources did it, because the three are fixed in three different places. A single merged
  // list would send two thirds of its readers somewhere that cannot help them.
  "settings.permissions.project.title": "Rules this folder adds",
  "settings.permissions.project.description":
    "A folder can carry its own permission rules in its novaclaw.json, so a checkout can be stricter than the rest of your machine. Anyone you got the folder from wrote them, so they are only ever allowed to take capability away.",
  "settings.permissions.project.inForce.none":
    "Right now: no project file governs this folder, so it adds no rules. Saving one below creates novaclaw.json here.",
  "settings.permissions.project.inForce.here": "Right now: {{file}} governs this folder, and saving updates it.",
  "settings.permissions.project.inForce.ancestor":
    "Right now: {{file}} governs this folder from a folder above it. Saving here creates a separate novaclaw.json for THIS folder — the file above is not modified, but it stops applying here, because the nearest one wins.",
  "settings.permissions.project.inForce.ancestorEdit":
    "So a rule you save here replaces everything that file was contributing to this folder, not just its permissions. Edit {{file}} itself if you meant to change the whole checkout.",
  // The line names the FILE — the actionable half, since the fix is editing it. Why a local edit
  // would replace rather than extend is the reasoning, and it goes behind the disclosure.
  "settings.project.exclude.elsewhere":
    "This list comes from {{file}}, in a folder above this one — open that file to change it.",
  "settings.project.exclude.elsewhere.more":
    "Editing it here would not extend that list: it would create a second novaclaw.json for this folder that takes over from it completely. Use the Permissions section above if you really do want this folder to have its own declaration.",
  "settings.project.exclude.import.elsewhere":
    "Not offered here: this folder's settings come from {{file}}, one or more folders up. Importing would create a second novaclaw.json here that replaces it rather than adding to it.",
  "settings.permissions.project.origin.project": "This folder",
  "settings.permissions.project.origin.projectDetail":
    "From novaclaw.json in the folder. Edit them here, or in the file — it is plain text and meant to be committed.",
  "settings.permissions.project.origin.personal": "Your saved answers",
  "settings.permissions.project.origin.personalDetail":
    'What you chose when Nova asked — every "always allow" and "always refuse" you gave on this machine. Remove one and Nova will ask again next time.',
  "settings.permissions.project.origin.session": "The chat itself",
  "settings.permissions.project.origin.sessionDetail":
    "Each chat adds rules of its own from its Mode (Analyze, Modify, Admin) and its Tuning switches. They belong to that chat and are changed below its message box, not here.",
  "settings.permissions.project.narrowing":
    'A folder can only ever make things stricter. "Refuse" and "ask me first" work; "allow" does not, because a folder is never allowed to hand out access your own settings withhold.',
  "settings.permissions.project.empty": "This folder adds no rules of its own.",
  "settings.permissions.project.personalEmpty": "You have not saved any answers on this machine yet.",
  "settings.permissions.project.remove": "Remove",
  "settings.permissions.project.add": "Add rule",
  "settings.permissions.project.addAction": "What the agent wants to do",
  "settings.permissions.project.actionPick": "Pick what it wants to do",
  "settings.permissions.project.actionFallback":
    "Not in the list? Type it instead. The list holds what this build itself asks permission for — an action that a plugin or a connected tool server adds is not something it can know about.",
  "settings.permissions.project.actionGroup.read": "Reading and searching",
  "settings.permissions.project.actionGroup.mutate": "Changing files",
  "settings.permissions.project.actionGroup.execute": "Running things",
  "settings.permissions.project.actionGroup.external": "Reaching outside this folder",
  "settings.permissions.project.actionGroup.network": "The internet",
  "settings.permissions.project.actionGroup.session": "The chat’s own state",
  "settings.permissions.project.actionGroup.capability": "Memory, skills and new tools",
  "settings.permissions.project.actionGroup.delegation": "Handing work to another agent",
  "settings.permissions.project.actionGroup.social": "Speaking as you to other people",
  "settings.permissions.project.actionGroup.legacy": "Older names, still honoured",
  "settings.permissions.project.addResource": "Which files or commands (use * for all)",
  "settings.permissions.project.omitted": "{{list}} will not be saved: a folder cannot grant access, only withhold it.",
  "settings.permissions.project.save": "Save to this folder",
  "settings.permissions.project.saving": "Saving…",
  "settings.permissions.project.preview": "Will be written: {{list}}",
  "settings.permissions.project.previewClear":
    "Will be written: nothing — the permissions section is removed from the file, and everything else in it stays.",
  "settings.permissions.project.receipt.created": "Created {{file}}",
  "settings.permissions.project.receipt.updated": "Updated {{file}}",
  "settings.permissions.project.receipt.cleared": "The permissions section was removed.",
  // 🔴 NAMES the sections rather than saying "permissions", and the fix came from running it. One
  // receipt is shared by every control that writes this file — permissions, the excluded-path list, the
  // .gitignore import and now the folder's checks — so a sentence naming ONE section told three of
  // them a falsehood about their own write ("Only the permissions section changed", after saving a
  // list of checks). Principle 12's own generalising lesson, one layer in: change the COPY with the
  // control, including the copy the control INHERITED.
  "settings.permissions.project.receipt.preserved":
    "Only {{sections}} changed. Everything else in the file — including anything a newer NovaClaw put there — is exactly as it was.",
  /** The same sentence when a write touched no section at all, so it never says "only  changed". */
  "settings.permissions.project.receipt.preservedNone":
    "Nothing in the file changed — including anything a newer NovaClaw put there.",
  "settings.permissions.project.receipt.refused": "Not saved, because a folder cannot grant access: {{list}}",
  "settings.permissions.project.receipt.refusedBroken": "Nothing was written: {{file}} could not be read ({{detail}}).",
  "settings.permissions.project.receipt.refusedFuture":
    "Nothing was written: {{file}} was made by a newer NovaClaw. Update NovaClaw — the file is probably fine.",
  "settings.permissions.project.receipt.untouched": "Your file is exactly as you left it.",
  "settings.permissions.project.receipt.failed": "Could not save: {{detail}}",

  // ── Settings → Project → editing the excluded-path list ─────────────────────────────────────
  //
  // ⚠️ Removal exists as well as adding, on purpose. An import-only control is a one-way door: a
  // person who imported a .gitignore and found Nova unable to read something it should could only fix
  // it by hand-editing JSON, which is the c64-poke this product refuses (principle 12).
  "settings.project.exclude.editTitle": "Edit paths excluded from file and search tools",
  "settings.project.exclude.editDescription":
    "One pattern per line, the same way .gitignore reads: a bare name matches anywhere (secrets), a slash anchors it to this folder (/build), a trailing slash means folders only (logs/), and a leading ! puts something back in reach. The last line that matches wins.",
  "settings.project.exclude.addPattern": "A file, folder or pattern",
  "settings.project.exclude.add": "Add",
  "settings.project.exclude.remove": "Remove",
  "settings.project.exclude.preview": "Will be written: {{list}}",
  "settings.project.exclude.previewClear":
    "Will be written: nothing — the exclude list is removed, so file and search tools may read these paths again. Everything else in the file stays.",
  "settings.project.exclude.save": "Save the list",
  "settings.project.exclude.saving": "Saving…",

  // ── Settings → Project → importing a .gitignore into the excluded-path list ──────────────────
  //
  // 🔴 Read eligibility stays DISTINCT from watcher/build ignores. The copy has
  // to say that out loud, because the two lists look interchangeable and are not.
  "settings.project.exclude.import.title": "Start from .gitignore",
  "settings.project.exclude.import.distinct":
    "A .gitignore says what should not be committed. This list tells Nova's file and search tools what to skip. They overlap — a .env belongs on both — but they are not the same: build output is fine to read, and a secret that IS committed will not be in .gitignore at all. So this copies nothing on its own; look at the list and decide.",
  "settings.project.exclude.import.noFile": "There is no .gitignore next to this project's novaclaw.json.",
  "settings.project.exclude.import.nothingNew":
    "Everything in {{file}} is already on this list ({{count}} patterns). Nothing to add.",
  "settings.project.exclude.import.preview": "Would add {{count}} from {{file}}: {{list}}",
  "settings.project.exclude.import.already": "Already on the list: {{list}}",
  "settings.project.exclude.import.dropped": "Skipped, because NovaClaw cannot read them the way git does: {{list}}",
  "settings.project.exclude.import.reincludes":
    "Careful — these lines put files BACK in reach, and they are added at the end, so they win over anything above them: {{list}}",
  "settings.project.exclude.import.action": "Add to Excluded paths",
  "settings.project.exclude.import.saving": "Adding…",
  "settings.project.exclude.import.done": "Added {{count}} to Excluded paths in {{file}}",

  // ⚠️ `settings.confinement.section` ("Confinement") was DELETED on 2026-08-19, not orphaned: these
  // rows moved into the Nova Health report (owner: *"Confinement shouldn't really be a user
  // configurable, but part of the health report"*), so they no longer own a section heading. No
  // locale carried the key, so removing it here removes it everywhere. Every row title below still
  // says what its row is about, which is what the heading was doing.
  "settings.confinement.title": "Sandbox for the agent's shell",
  "settings.confinement.meanwhile":
    "Two things hold regardless: Analyze mode refuses to run shell commands at all, and a turn driven by someone messaging you from outside can only run them inside a sandbox — where there is none, it is refused. Beyond those, in every mode except Admin the agent is told to leave everything outside your project folder alone, which is an instruction the model follows rather than a wall. Full OS confinement comes from a setup recipe, not from NovaClaw’s core.",

  "settings.confinement.reason.confined":
    "This machine can sandbox, and it does ({{backend}}). A chat running on its own gets its shell commands boxed in: they can only change files in the project folder, and they have no network.",
  "settings.confinement.reason.partial-backend":
    "This machine has {{backend}}, which can restrict files but not the network. NovaClaw does not count half a box as containment, so shell commands still run with your own access.",
  "settings.confinement.reason.platform-unsupported":
    "NovaClaw has no operating-system sandbox for {{platform}} yet — that arrives in the next release, the one about security. Until then a shell command an agent runs here reaches whatever you can reach, exactly like a program you started yourself.",
  "settings.confinement.reason.backend-absent":
    "This machine runs Linux, where NovaClaw sandboxes with bwrap — and bwrap is not installed here, so there is no box to put commands in. Install it (on Debian or Ubuntu: apt install bubblewrap) and restart this instance.",
  "settings.confinement.reason.backend-blocked":
    "bwrap is installed here, and the sandbox was refused when this instance tested it — so commands are not being boxed. On Ubuntu 24.04 and its relatives that is usually one missing file, the /etc/apparmor.d/bwrap profile. Add it, restart this instance, and the check below should pass.",
  "settings.confinement.reason.unreported":
    "This instance runs {{platform}}, where NovaClaw has a sandbox — but it did not report whether the sandbox actually works on its machine, and this screen will not guess. Update the instance to get a real answer.",
  "settings.confinement.reason.unknown":
    "This screen could not reach the instance to ask, so it has nothing to tell you. That means it does not know — not that nothing is protecting you.",
  "settings.confinement.reason.checking": "Asking this instance what it can enforce on its own machine…",
  "settings.confinement.verdict.confined": "Sandboxed",
  "settings.confinement.verdict.partial-backend": "Partly sandboxed",
  "settings.confinement.verdict.platform-unsupported": "No sandbox yet",
  "settings.confinement.verdict.backend-absent": "No sandbox — bwrap missing",
  "settings.confinement.verdict.backend-blocked": "Sandbox blocked",
  "settings.confinement.verdict.unreported": "Not reported",
  "settings.confinement.verdict.unknown": "Unknown",
  "settings.confinement.verdict.checking": "Checking…",
  "settings.confinement.enclosure.title": "What this machine already runs inside",
  "settings.confinement.enclosure.description":
    "Separate from the sandbox above: that is what NovaClaw can put AROUND a command, this is what is already around NovaClaw itself.",
  "settings.confinement.enclosure.container": "Inside a container",
  "settings.confinement.enclosure.vm": "Inside a virtual machine",
  "settings.confinement.enclosure.bare": "Directly on this machine",
  "settings.confinement.enclosure.unknown": "Not measured",
  "settings.confinement.backend.namespaces": "Linux namespaces, via bwrap",
  "settings.confinement.backend.seatbelt": "macOS Seatbelt",
  "settings.confinement.backend.appcontainer": "Windows AppContainer",
  "settings.confinement.backend.none": "no sandbox backend",
  "settings.confinement.platform.win32": "Windows",
  "settings.confinement.platform.darwin": "macOS",
  "settings.confinement.platform.linux": "Linux",
  "settings.confinement.probe.title": "What was actually tested",
  "settings.confinement.probe.description":
    "The check this instance ran on its own machine at startup, and what came back.",
  "settings.confinement.probe.description.more": "Run it yourself to confirm — this screen is only repeating it.",
  "settings.confinement.probe.unreported": "This instance did not report a check.",
  "settings.confinement.probe.checking": "Asking the instance…",
  "settings.confinement.probe.none": "No check runs on {{platform}} — there is no sandbox to test yet.",
  "settings.confinement.probe.exit": "exit {{code}}",
  "settings.confinement.probe.error": "could not run: {{detail}}",
  "settings.confinement.probe.noOutcome": "no result",
  "settings.instances.access.title": "This instance",
  "settings.instances.access.hint":
    "The API token other instances and agents must present to reach this one (HTTP Basic, username 'novaclaw'). Empty means open. Applies immediately.",
  "settings.instances.access.placeholder": "API token",
  "settings.instances.access.source.stored": "Stored token in force.",
  "settings.instances.access.source.launcher": "Launcher default in force.",
  "settings.instances.access.source.open": "No token in force — this instance is open.",
  "settings.instances.access.source.checking": "Checking which token is in force…",
  "settings.instances.access.saveFailed":
    "Saving failed — this instance's token has not changed, and what you typed is still in the box.",
  "settings.instances.peers.title": "Agent peers",
  "settings.instances.peers.hint":
    "Peer instances this instance's agents may drive over HTTP — full API access with the stored token. Agents see them in their environment.",
  "settings.instances.peers.name": "name",
  "settings.instances.peers.url": "http://host:port",
  "settings.instances.peers.token": "peer token",
  "settings.instances.peers.token.reveal": "Show token",
  "settings.instances.peers.token.hide": "Hide token",
  "settings.instances.peers.scan": "Find instances on my network",
  "settings.instances.peers.scanning": "Looking…",
  "settings.instances.peers.none": "No other instances answered on this network — fill the fields below.",
  "settings.instances.peers.add": "Add peer",
  "settings.instances.peers.saveFailed":
    "Saving failed — the peer list has not changed, and the name, address and token you typed are still below. Try again once the instance answers.",
  "settings.general.row.virtualFs.title": "Virtual workspace",
  "settings.general.row.virtualFs.description":
    "Keep this instance's projects, notes, and files in an app-private folder — for hosts without a browsable filesystem.",
  "settings.general.row.feedReasoning.title": "Reasoning sections",
  "settings.general.row.feedReasoning.description":
    "How the model's reasoning shows in chat. Auto follows your expertise level.",
  "settings.general.row.feedTool.title": "Tool and shell cards",
  "settings.general.row.feedTool.description":
    "How tool calls (shell commands, edits, …) show in chat. Auto follows your expertise level.",
  "settings.general.feedDisplay.auto": "Auto",
  "settings.general.feedDisplay.expanded": "Expanded",
  "settings.general.feedDisplay.collapsed": "Collapsed",
  "settings.general.row.pinchZoom.title": "Pinch to zoom",
  "settings.general.row.pinchZoom.description": "Allow trackpad pinch and Ctrl-scroll gestures to zoom",

  "settings.general.row.releaseNotes.title": "Release notes",
  "settings.general.row.releaseNotes.description": 'Show a "What\'s New" summary after NovaClaw updates.',

  // The status line under the toggle, one per state of context/highlights.tsx. Plain English on
  // purpose: the Debug app's error log carries the URL and the status code, this says what happened.
  // Never leave one of these blank — an unavailable subsystem has to name itself (todo.md ruling 2).
  "settings.general.row.releaseNotes.status.idle":
    "NovaClaw looks for release notes the first time it starts a new version.",
  "settings.general.row.releaseNotes.status.checking": "Checking for release notes…",
  "settings.general.row.releaseNotes.status.new": "Release notes for this version are ready — {{count}} to show.",
  "settings.general.row.releaseNotes.status.none": "Up to date — this version had no release notes to show.",
  "settings.general.row.releaseNotes.status.unavailableRetry":
    "Couldn't reach the release-notes list. NovaClaw will try again the next time it starts.",
  "settings.general.row.releaseNotes.status.unavailableFinal":
    "No release notes are published for this version, so NovaClaw has stopped checking.",

  "sound.option.none": "None",
  "sound.option.alert01": "Alert 01",
  "sound.option.alert02": "Alert 02",
  "sound.option.alert03": "Alert 03",
  "sound.option.alert04": "Alert 04",
  "sound.option.alert05": "Alert 05",
  "sound.option.alert06": "Alert 06",
  "sound.option.alert07": "Alert 07",
  "sound.option.alert08": "Alert 08",
  "sound.option.alert09": "Alert 09",
  "sound.option.alert10": "Alert 10",
  "sound.option.bipbop01": "Bip-bop 01",
  "sound.option.bipbop02": "Bip-bop 02",
  "sound.option.bipbop03": "Bip-bop 03",
  "sound.option.bipbop04": "Bip-bop 04",
  "sound.option.bipbop05": "Bip-bop 05",
  "sound.option.bipbop06": "Bip-bop 06",
  "sound.option.bipbop07": "Bip-bop 07",
  "sound.option.bipbop08": "Bip-bop 08",
  "sound.option.bipbop09": "Bip-bop 09",
  "sound.option.bipbop10": "Bip-bop 10",
  "sound.option.staplebops01": "Staplebops 01",
  "sound.option.staplebops02": "Staplebops 02",
  "sound.option.staplebops03": "Staplebops 03",
  "sound.option.staplebops04": "Staplebops 04",
  "sound.option.staplebops05": "Staplebops 05",
  "sound.option.staplebops06": "Staplebops 06",
  "sound.option.staplebops07": "Staplebops 07",
  "sound.option.nope01": "Nope 01",
  "sound.option.nope02": "Nope 02",
  "sound.option.nope03": "Nope 03",
  "sound.option.nope04": "Nope 04",
  "sound.option.nope05": "Nope 05",
  "sound.option.nope06": "Nope 06",
  "sound.option.nope07": "Nope 07",
  "sound.option.nope08": "Nope 08",
  "sound.option.nope09": "Nope 09",
  "sound.option.nope10": "Nope 10",
  "sound.option.nope11": "Nope 11",
  "sound.option.nope12": "Nope 12",
  "sound.option.yup01": "Yup 01",
  "sound.option.yup02": "Yup 02",
  "sound.option.yup03": "Yup 03",
  "sound.option.yup04": "Yup 04",
  "sound.option.yup05": "Yup 05",
  "sound.option.yup06": "Yup 06",

  "settings.general.notifications.agent.title": "Agent",
  "settings.general.notifications.agent.description":
    "Show system notification when the agent is complete or needs attention",
  "settings.general.notifications.permissions.title": "Permissions",
  "settings.general.notifications.permissions.description": "Show system notification when a permission is required",
  "settings.general.notifications.errors.title": "Errors",
  "settings.general.notifications.errors.description": "Show system notification when an error occurs",

  "settings.general.sounds.agent.title": "Agent",
  "settings.general.sounds.agent.description": "Play sound when the agent is complete or needs attention",
  "settings.general.sounds.permissions.title": "Permissions",
  "settings.general.sounds.permissions.description": "Play sound when a permission is required",
  "settings.general.sounds.errors.title": "Errors",
  "settings.general.sounds.errors.description": "Play sound when an error occurs",

  "settings.shortcuts.title": "Keyboard shortcuts",
  "settings.shortcuts.reset.button": "Reset to defaults",
  "settings.shortcuts.reset.toast.title": "Shortcuts reset",
  "settings.shortcuts.reset.toast.description": "Keyboard shortcuts have been reset to defaults.",
  "settings.shortcuts.conflict.title": "Shortcut already in use",
  "settings.shortcuts.conflict.description": "{{keybind}} is already assigned to {{titles}}.",
  "settings.shortcuts.unassigned": "Unassigned",
  "settings.shortcuts.pressKeys": "Press keys",
  "settings.shortcuts.search.placeholder": "Search shortcuts",
  "settings.shortcuts.search.empty": "No shortcuts found",

  "settings.shortcuts.group.general": "General",
  "settings.shortcuts.group.session": "Chat",
  "settings.shortcuts.group.navigation": "Navigation",
  "settings.shortcuts.group.modelAndAgent": "Model and agent",
  "settings.shortcuts.group.terminal": "Terminal",
  "settings.shortcuts.group.prompt": "Prompt",

  "settings.models.title": "Models",
  "settings.models.probe.test": "Test",
  "settings.models.probe.probing": "Testing…",
  "settings.models.probe.ok": "Endpoint and generation are healthy",
  "settings.models.probe.unreachable": "Couldn't connect",
  "settings.models.probe.auth": "Sign-in failed — check your API key",
  "settings.models.probe.missing": "Model not found on this provider",
  "settings.models.probe.noUrl": "No server address saved",
  "settings.models.probe.error": "Error",
  "settings.models.probe.window": "window",
  // Capability tier — a rough size class NovaClaw uses to decide how much to scaffold a model
  // (and, later, to note in the system prompt). "Guess" = let NovaClaw probe and estimate it.
  "settings.models.tier.label": "Tier",
  "settings.models.tier.pick": "Set capability tier",
  "settings.models.tier.guess.name": "Guess",
  "settings.models.tier.guess.range": "auto",
  "settings.models.tier.guess.blurb":
    "Let NovaClaw estimate the tier by probing the model. Choose a specific tier if you already know its size.",
  "settings.models.tier.micro.name": "Micro",
  "settings.models.tier.micro.range": "under 7B",
  "settings.models.tier.micro.blurb":
    "Phone- and edge-sized models (e.g. Gemma 3 4B, Qwen3 4B, Llama 3.2 3B). Fast and cheap, but need small, well-scoped steps and heavy guidance.",
  "settings.models.tier.tiny.name": "Tiny",
  "settings.models.tier.tiny.range": "7B–24B",
  "settings.models.tier.tiny.blurb":
    "Small local models (e.g. Qwen3 8B/14B, Gemma 3 12B, Mistral Small). Good for everyday tasks with clear instructions; still benefit from being broken into steps.",
  "settings.models.tier.small.name": "Small",
  "settings.models.tier.small.range": "~24B–~64B",
  "settings.models.tier.small.blurb":
    "Capable local models (e.g. Qwen3 32B, Gemma 3 27B). Solid general assistants that can follow a multi-step plan with light scaffolding.",
  "settings.models.tier.medium.name": "Medium",
  "settings.models.tier.medium.range": "~64B–~128B",
  "settings.models.tier.medium.blurb":
    "Strong open models (e.g. Llama 3.3 70B, gpt-oss 120B). Reliable reasoning and tool use across most tasks.",
  "settings.models.tier.large.name": "Large",
  "settings.models.tier.large.range": "~128B–~256B",
  "settings.models.tier.large.blurb":
    "Near-frontier open models (e.g. DeepSeek V3, GLM-4.6, Qwen3 235B). Roughly Claude Sonnet class — they handle complex, long-running work with little hand-holding.",
  "settings.models.tier.frontier.name": "Frontier",
  "settings.models.tier.frontier.range": "256B+ / closed",
  "settings.models.tier.frontier.blurb":
    "The strongest models (e.g. Claude Opus & Sonnet, GPT-5, Gemini 2.5 Pro). Best judgment and reliability; they need the least guidance.",
  "settings.models.tier.dialog.title": "Model size",
  "settings.models.tier.dialog.description":
    "About how large is {{model}}? NovaClaw uses this to give it the right amount of guidance — smaller models get more scaffolding.",
  "settings.models.config.open": "Configure",
  "settings.models.config.title": "Configure {{model}}",
  "settings.models.config.description":
    "Set how this model runs. Leave a field blank to use the model's or provider's own default.",
  "settings.models.config.defaultPlaceholder": "default",
  "settings.models.config.section.identity": "Identity and connection",
  "settings.models.config.providerName.name": "Connection name (optional)",
  "settings.models.config.providerName.desc": "A concise name shown in Nova.",
  "settings.models.config.providerName.desc.more": "Leave it blank to identify this connection by its serving URL.",
  "settings.models.config.apiPath.name": "API path",
  // Owner, 2026-08-24: a row's description is SCANNED, not read — one clause saying what the field
  // is. Anything a person only wants once moves to `hint`, which pops on hover/focus. The rule is
  // the same one `settings.identity.*` already follows; these rows simply predated it.
  "settings.models.config.apiPath.desc": "The endpoint Nova connects to.",
  "settings.models.config.apiPath.desc.more": "Shared by every model from this provider, not just this one.",
  "settings.models.config.apiKey.name": "API key",
  "settings.models.config.apiKey.desc": "The key Nova sends to this provider.",
  "settings.models.config.apiKey.desc.more":
    "Shared by every model from this provider. Hidden until you reveal it; clearing the field removes the stored key.",
  "settings.models.config.apiKey.reveal": "Show API key",
  "settings.models.config.apiKey.hide": "Hide API key",
  "settings.models.config.modelID.name": "Model ID",
  "settings.models.config.modelID.desc": "The exact model identifier Nova sends to the API.",
  "settings.models.config.modelName.name": "Model name",
  "settings.models.config.modelName.desc": "The friendly name shown in Nova.",
  "settings.models.config.section.sampling": "Sampling",
  "settings.models.config.section.limits": "Limits",
  "settings.models.config.section.reliability": "Connection recovery",
  "settings.models.config.section.capabilities": "Capabilities",
  "settings.models.config.section.modalities": "What it handles",
  "settings.models.config.section.corrections": "Behaviour corrections",
  "settings.models.config.prePrompt.name": "Model-specific corrections",
  "settings.models.config.prePrompt.desc": "A short note added to every chat with this model.",
  "settings.models.config.prePrompt.desc.more":
    "For correcting a quirk in how the model behaves — e.g. “Never wrap replies in markdown code fences” or “Stop apologising; answer directly”. It travels with the model, not the task, so keep it to behaviour fixes — not task instructions.",
  "settings.models.config.prePrompt.placeholder": "e.g. Don’t wrap answers in code fences.",
  "settings.models.config.temperature.name": "Temperature",
  "settings.models.config.temperature.desc":
    "Higher is more creative and varied; lower is more focused and repeatable. Around 0.7 for chat, 0 for code.",
  "settings.models.config.top_p.name": "Top-P (nucleus)",
  "settings.models.config.top_p.desc":
    "Only consider the most likely words that together make up this share of the probability. 1 = off.",
  "settings.models.config.top_k.name": "Top-K",
  "settings.models.config.top_k.desc": "Only consider the K most likely next words. 0 or blank = off.",
  "settings.models.config.min_p.name": "Min-P",
  "settings.models.config.min_p.desc":
    "Drop words less likely than this fraction of the top word — a gentler alternative to Top-P. 0 = off.",
  "settings.models.config.repetition_penalty.name": "Repetition penalty",
  "settings.models.config.repetition_penalty.desc":
    "Discourages repeating the same words. 1 = off; around 1.1 helps stop loops.",
  "settings.models.config.presence_penalty.name": "Presence penalty",
  "settings.models.config.presence_penalty.desc":
    "Discourages reusing any word already used, nudging toward new topics. 0 = off.",
  "settings.models.config.frequency_penalty.name": "Frequency penalty",
  "settings.models.config.frequency_penalty.desc":
    "Discourages words the more often they have already appeared. 0 = off.",
  "settings.models.config.context.name": "Context window",
  "settings.models.config.context.desc":
    "How many tokens of the conversation the model can see at once. Match the model's real limit.",
  "settings.models.config.images.name": "Images per request",
  // Short because the number is the point: what to type, and what blank does. The reason a cap
  // exists at all belongs to whoever hits it, not to everyone who opens this dialog.
  "settings.models.config.images.desc": "How many images this model takes at once. Blank assumes 1.",
  "settings.models.config.maxTokens.name": "Max response length",
  "settings.models.config.maxTokens.desc": "The most tokens the model may generate in a single reply.",
  "settings.models.config.thinkingBudget.name": "Thinking budget",
  "settings.models.config.thinkingBudget.desc": "Soft cap on the model's reasoning per turn.",
  "settings.models.config.thinkingBudget.desc.more":
    "When it's reached, the harness nudges the model to wrap up and answer — curbing runaway thinking in smaller models. Blank uses the default (¼ of the context).",
  "settings.models.config.thinkingEffort.name": "Thinking effort",
  "settings.models.config.thinkingEffort.desc": "How hard this model is told to think, sent with every request.",
  "settings.models.config.thinkingEffort.desc.more":
    "This is the `reasoning_effort` parameter the inference server receives — the server decides what each level costs and how long it thinks for. It is NOT the Thinking budget above: that one is NovaClaw's own limit, counted here and enforced by interrupting the model mid-thought. Leave this unset to use whatever the server does by default. Not every endpoint honours every level (OpenAI takes minimal through high; some servers add max), and one it does not know is refused by the server rather than by NovaClaw.",
  "settings.models.config.thinkingEffort.unset": "Server default",
  "settings.models.config.thinkingEffort.value.none": "None",
  "settings.models.config.thinkingEffort.value.minimal": "Minimal",
  "settings.models.config.thinkingEffort.value.low": "Low",
  "settings.models.config.thinkingEffort.value.medium": "Medium",
  "settings.models.config.thinkingEffort.value.high": "High",
  "settings.models.config.thinkingEffort.value.xhigh": "Very high",
  "settings.models.config.thinkingEffort.value.max": "Max",
  "settings.models.config.retryAttempts.name": "Connection attempts",
  "settings.models.config.retryAttempts.desc":
    "How patiently NovaClaw reconnects when this model sends no reply or an incomplete reply. Persistent keeps trying for about three minutes.",
  "settings.models.config.tool_call.name": "Tool use",
  "settings.models.config.tool_call.desc": "Let the model use NovaClaw's tools.",
  "settings.models.config.tool_call.desc.more":
    "Read and edit files, run commands, search. Turn off for models that can't.",
  "settings.models.config.toolChannel.name": "How tools are offered",
  "settings.models.config.toolChannel.native":
    "This model is handed tools through the endpoint's own tool channel — the usual way, and the one that works when it works.",
  "settings.models.config.toolChannel.prompted":
    "This model's endpoint can't carry tool calls properly, so the tools are described in the prompt instead and the calls are read back out of its reply.",
  "settings.models.config.toolChannel.source.default": "Not tested — using the usual way",
  "settings.models.config.toolChannel.source.measured": "Chosen by testing this endpoint",
  "settings.models.config.toolChannel.source.configured": "Set by you, in this model's settings",
  "settings.models.config.toolChannel.overridden":
    "Testing said {{channel}}. Your setting is being used instead — clear it to go back to the tested answer.",
  "settings.models.config.toolChannel.inconclusive.chat-only":
    "Testing found no working way to offer tools here at all, so the usual way is still being used. Expect the agent to answer rather than act.",
  "settings.models.config.toolChannel.inconclusive.unknown":
    "The last test couldn't reach a conclusion, so the usual way is still being used. Try again when the endpoint is up.",
  "settings.models.config.toolChannel.moved":
    "This model's address changed since it was tested (it was {{from}}), so the old result no longer applies. Test again.",
  "settings.models.config.toolChannel.test": "Test what this endpoint can do",
  "settings.models.config.toolChannel.testing": "Testing — this asks the model a few questions…",
  "settings.models.config.toolChannel.testFailed": "The test couldn't finish. The endpoint may be down.",
  "settings.models.config.modalities.in.name": "Accepts",
  "settings.models.config.modalities.in.desc": "What you can send this model.",
  "settings.models.config.modalities.out.name": "Produces",
  "settings.models.config.modalities.out.desc": "What this model can return.",
  "settings.models.config.modality.text": "Text",
  "settings.models.config.modality.image": "Image",
  "settings.models.config.modality.audio": "Audio",
  "settings.models.config.preset.default": "Default",
  "settings.models.config.preset.custom": "Custom",
  "settings.models.config.preset.off": "Off",
  "settings.models.config.preset.disabled": "Disabled — no budget",
  "settings.models.config.preset.briefThought": "Brief — answer sooner",
  "settings.models.config.preset.thoroughThought": "Thorough — think before acting",
  "settings.models.config.preset.exhaustiveThought": "Exhaustive — hardest problems",
  "settings.models.config.preset.precise": "Precise",
  "settings.models.config.preset.focused": "Focused",
  "settings.models.config.preset.balanced": "Balanced",
  "settings.models.config.preset.creative": "Creative",
  "settings.models.config.preset.wild": "Wild",
  "settings.models.config.preset.diverse": "Diverse",
  "settings.models.config.preset.tight": "Tight",
  "settings.models.config.preset.wide": "Wide",
  "settings.models.config.preset.gentle": "Gentle",
  "settings.models.config.preset.light": "Light",
  "settings.models.config.preset.moderate": "Moderate",
  "settings.models.config.preset.strong": "Strong",
  "settings.models.config.preset.once": "Try once",
  "settings.models.config.preset.quickRecovery": "Quick recovery",
  "settings.models.config.preset.patientRecovery": "Patient recovery",
  "settings.models.config.preset.persistentRecovery": "Persistent recovery",
  "settings.models.config.toast.saved": "Model settings saved",
  "settings.models.config.toast.failed": "Couldn't save model settings",
  "settings.models.new.open": "Add models",
  "settings.models.new.title": "Add models",
  "settings.models.new.description": "Pick where your models come from.",
  "settings.models.new.custom.name": "Custom endpoint",
  "settings.models.new.custom.description": "Any OpenAI-compatible server — vLLM, SGLang, or the bundled llama.cpp.",
  "settings.models.new.connect.title": "Connect to {{name}}",
  "settings.models.new.connect.description":
    "NovaClaw checks the connection and lists the models it serves, so you can pick which to add.",
  "settings.models.new.getKey": "Get an API key",
  "settings.models.new.keyHint": "Your key is stored on this instance and only ever sent to this provider.",
  "settings.models.new.field.apiKey.keep": "A key is already saved — leave empty to keep it",
  "settings.models.new.back": "Back",
  "settings.models.new.field.baseURL.label": "Endpoint URL",
  "settings.models.new.field.baseURL.placeholder": "http://localhost:8000/v1",
  "settings.models.new.field.apiKey.label": "API key (optional)",
  "settings.models.new.field.apiKey.placeholder": "Leave blank if the endpoint needs no key",
  "settings.models.new.discover": "Find models",
  "settings.models.new.discovering": "Checking…",
  "settings.models.new.noModels": "Connected, but this endpoint didn't list any models.",
  "settings.models.new.pick": "Pick models to add — {{count}} found",
  "settings.models.new.preset": "{{family}} defaults",
  "settings.models.new.limits.reported": "Server-reported: {{context}} context · {{output}} max response",
  "settings.models.new.limits.contextOnly":
    "Server reports {{context}} context, but no response limit. Nova will start at {{output}}; review it in Configure.",
  "settings.models.new.limits.outputOnly":
    "Server reports {{output}} max response, but no context limit. Nova will start at {{context}}; review it in Configure.",
  "settings.models.new.limits.unknown":
    "Limits not reported. Nova will start at {{context}} context and {{output}} response; review them in Configure before long tasks.",
  "settings.models.new.add": "Add selected",
  "settings.models.new.toast.added": "Models added",
  "settings.models.new.refreshMissing":
    "The model was saved, but it is not visible in the refreshed model list yet. Keep this window open and try again.",
  // S0 — the local-runtime probe. A model server the user ALREADY runs is the shortest path out of
  // the zero-provider first-run state, so it is offered above the presets instead of behind a form.
  // ⚠️ The wording is careful on purpose (ruling 2): we verified an endpoint, not a vendor, so the
  // card asserts the address and only HINTS at the program that usually answers there. And
  // "couldn't check" is a separate string from "nothing here" — they are different facts.
  "settings.models.new.local.checking": "Looking for a model server on this machine…",
  "settings.models.new.local.title": "Already on this machine",
  "settings.models.new.local.models": "{{count}} ready to use",
  "settings.models.new.local.needsKey": "Needs an API key",
  "settings.models.new.local.usually": "usually {{runtime}}",
  "settings.models.new.local.unavailable": "Couldn't check this machine for a model server.",
  "settings.models.new.managed.name": "Local Model",
  "settings.models.new.managed.card": "Let Nova install a tested private model that loads only when you prompt it.",
  "settings.models.new.managed.title": "Run a model on this computer",
  "settings.models.new.managed.description":
    "Nova downloads a verified model and AI engine, checks that they fit, and loads it only when a prompt needs it.",
  "settings.models.new.managed.checking": "Checking what this computer can run…",
  "settings.models.new.managed.unsupported":
    "Managed local models currently support Windows x64. This instance reports {{platform}}.",
  "settings.models.new.managed.download": "{{size}} download",
  "settings.models.new.managed.memory": "{{size}} memory minimum",
  "settings.models.new.managed.context": "{{count}} context",
  "settings.models.new.managed.contextChoice": "Context",
  "settings.models.new.managed.recommended": "recommended for this computer",
  "settings.models.new.managed.progress": "{{percent}}% downloaded",
  "settings.models.new.managed.install": "Download and add",
  "settings.models.new.managed.working": "Working…",
  "settings.models.new.managed.cancel": "Stop / cancel",
  "settings.models.new.managed.use": "Use this model",
  "settings.models.clone.action": "Clone",
  "settings.models.clone.toast.done": "Created {{model}}",
  "settings.models.clone.toast.failed": "Could not clone that model",
  "settings.models.remove.confirm.title": "Remove {{model}}?",
  "settings.models.remove.confirm.description":
    "This removes the model from your list here. It doesn't delete anything on the model server, and you can add it back later.",
  "settings.models.remove.confirm.action": "Remove",
  "settings.models.remove.toast.failed": "Could not remove {{model}}",
  "settings.messengers.title": "Messengers",
  "settings.messengers.description":
    "Connect NovaClaw to your messaging apps — the agent can answer chats while you're away, and you can drive NovaClaw from your phone.",
  // How the operator actually USES a connected account from their phone. Without this the §0.1.5
  // address rule is invisible: an unaddressed message is silently ignored (by design — your notes to
  // self must stay yours), which is indistinguishable from a broken account.
  "settings.messengers.consoleHint":
    'To give NovaClaw a task from your phone, message YOURSELF — "Message Yourself" on WhatsApp, "Saved Messages" on Telegram — and start the message with "{{address}}, ". For example: "{{address}}, what\'s on my calendar today?"',
  "settings.messengers.consoleHintWhy":
    "Messages there that don't start with that are ignored, so your own notes to self stay private. The first one you send links that chat to a new session automatically.",
  "settings.messengers.add": "Add account",
  "settings.messengers.addThenLogin": "Add & log in",
  "settings.messengers.empty": "No messenger accounts yet. Add one to let NovaClaw talk where you talk.",
  "settings.messengers.airgapped":
    "Messengers are off while NovaClaw is offline or airgapped — nothing connects until you go back online.",
  "settings.messengers.enabled": "Enabled",
  "settings.messengers.login": "Log in",
  "settings.messengers.pair": "Pair",
  "settings.messengers.secret": "Access token",
  "settings.messengers.label": "Name",
  "settings.messengers.pickDriver": "Which messenger?",
  "settings.messengers.setup.title": "How to get this",
  "settings.messengers.setup.open": "Open the setup page",
  "settings.messengers.auth.login":
    "NovaClaw signs into your own account and answers as you while you're away. You stay in control — flip the responder any time.",
  "settings.messengers.auth.key": "Uses a bot or app token you paste — a separate identity from your own account.",
  "settings.messengers.auth.none": "Connects with just the settings below — no credentials needed.",
  "settings.messengers.toast.failed": "Messenger action failed",
  "settings.messengers.status.connected": "Connected",
  "settings.messengers.status.connecting": "Connecting…",
  "settings.messengers.status.backoff": "Reconnecting",
  "settings.messengers.status.challenge": "Needs your attention",
  "settings.messengers.status.error": "Error",
  "settings.messengers.status.disabled": "Off",
  "settings.messengers.status.airgapped": "Off (airgapped)",
  "settings.messengers.remove.confirm.title": "Remove {{label}}?",
  "settings.messengers.remove.confirm.description":
    "This disconnects the account and forgets its stored credential. Nothing is deleted on the messenger's side.",
  "settings.messengers.remove.confirm.action": "Remove",
  "settings.messengers.login.title": "Log in — {{label}}",
  "settings.messengers.login.sendCode": "Send code",
  "settings.messengers.login.sending": "Contacting…",
  "settings.messengers.login.codePlaceholder": "12345",
  "settings.messengers.login.finish": "Finish login",
  "settings.messengers.login.checking": "Checking…",
  "settings.messengers.login.done": "Logged in — the account is connecting.",
  "settings.messengers.pair.title": "Pair your phone — {{label}}",
  "settings.messengers.pair.instructions":
    "From the phone you want to control NovaClaw with, send this message to the connected account:",
  "settings.messengers.pair.expiry": "The code works once and expires in 10 minutes.",
  "settings.messengers.speed": "Speed",
  "settings.messengers.speed.title": "Typing speed — {{label}}",
  "settings.messengers.speed.description":
    "NovaClaw types replies at a human pace, across all chats at once, so this account is never flagged as a bot. This sets how fast it types, in characters per second.",
  "settings.messengers.speed.unit": "characters / second",
  "settings.messengers.speed.human":
    "A person types around {{default}}/s. Lower is safer; higher is faster but riskier.",
  "settings.messengers.speed.warning":
    "⚠️ This is faster than a human types. Messaging providers watch for bot-like speed and may flag or BAN your account for posting too fast. Only go this high if you accept that risk.",
  "settings.quality.title": "Quality",
  "settings.quality.description":
    "Quality Enforcement: your provisioned checks run automatically at write and turn boundaries; a failure steers the agent to fix it and re-run — a change doesn't count as done until the checks pass.",
  "settings.quality.toast.failed": "Saving quality settings failed",
  "settings.quality.row.enabled.title": "Enable quality enforcement",
  "settings.quality.row.enabled.description": "Run the provisioned checks on every change this server makes",
  "settings.quality.row.cadence.title": "Typecheck cadence",
  "settings.quality.row.cadence.description": "Run the whole-module typecheck every N writes",
  "settings.quality.row.testTimeout.title": "Test timeout (minutes)",
  "settings.quality.row.testTimeout.description": "Hard limit for the test gate — a hung test counts as a failure",
  "settings.quality.commands.title": "Provisioned commands",
  "settings.quality.detect.action": "Detect from this project",
  "settings.quality.detect.running": "Detecting…",
  "settings.quality.detect.description":
    "Reads this project’s own manifests and fills the empty rows below. Nothing is run and nothing you have typed is replaced.",
  "settings.quality.detect.filled.one": "Filled {{count}} command from this project.",
  "settings.quality.detect.filled.other": "Filled {{count}} commands from this project.",
  "settings.quality.detect.nothing": "Nothing new to fill — every command this project declares is already set.",
  "settings.quality.detect.empty": "The server answered without a proposal.",
  "settings.quality.detect.failed": "Could not read this project’s manifests",
  "settings.quality.commands.description":
    "Empty = the step is skipped. {file} is replaced with the path of the file that was written (quoted). An agent can fill these in for you with the quality_provision tool.",
  "settings.quality.command.syntax.title": "Syntax check",
  "settings.quality.command.syntax.description": "Per-file parse on every write",
  "settings.quality.command.check.title": "Incremental verify",
  "settings.quality.command.check.description": "Per-file verifier on every write",
  "settings.quality.command.typecheck.title": "Typecheck",
  "settings.quality.command.typecheck.description": "Whole-module compile/type check, cadence-gated",
  "settings.quality.command.test.title": "Test gate",
  "settings.quality.command.test.description": "Runs once per completed turn that wrote files",
  "settings.quality.command.lint.title": "Structural pass",
  "settings.quality.command.lint.description": "Lint/structure check at the same turn-end gate",
  "settings.systemPrompt.title": "System Prompt",
  "settings.systemPrompt.description":
    "The assistant's composed prompt, in layers: the persona baseline and project instructions. The shipped base is never forked — clearing a field restores the default.",
  "settings.systemPrompt.toast.failed": "Saving system-prompt settings failed",
  "settings.systemPrompt.persona.title": "Persona",
  "settings.systemPrompt.persona.enabled.title": "Persona baseline",
  "settings.systemPrompt.persona.enabled.description": "Add the persona to the start of every agent's system prompt.",
  "settings.systemPrompt.persona.enabled.description.more":
    "So its behaviour stays consistent even when you switch models.",
  "settings.systemPrompt.persona.prompt.title": "Persona prompt",
  "settings.systemPrompt.persona.prompt.description":
    "Replaces the canonical persona wholesale. Leave empty to use the default shown below.",
  "settings.systemPrompt.instructions.title": "Project instructions",
  "settings.systemPrompt.instructions.description":
    "Paths or URLs of instruction files loaded into every session (one per line). AGENTS.md files are discovered automatically.",
  "settings.systemPrompt.instructions.placeholder": "docs/style-guide.md",
  "settings.profile.title": "Profile",
  "settings.profile.description":
    "Tell the assistant who you are. When enabled, it can look your profile up on demand through a tool — your name and background stay out of every prompt until it actually needs them.",
  "settings.profile.toast.failed": "Saving your profile failed",
  "settings.profile.enabled.title": "Share my profile with the assistant",
  "settings.profile.enabled.description": "Let the assistant read the details below on demand.",
  "settings.profile.enabled.description.more":
    "On when you've filled in your profile: the assistant can call a tool to read them. Turn it off to keep them private.",
  "settings.profile.name.title": "Your name",
  "settings.profile.name.description": "What the assistant should call you",
  "settings.profile.name.placeholder": "e.g. Nancy",
  "settings.profile.about.title": "About you",
  "settings.profile.about.description":
    "Anything worth knowing: your role, expertise, the projects you work on, how you like answers.",
  "settings.profile.about.placeholder":
    "e.g. systems programmer building a local-LLM agent OS; prefers concise, direct answers",
  "settings.memory.title": "Memory",
  "settings.memory.description":
    "What NovaClaw remembers about you and your work. It learns as you chat — nothing to set up. Your memory stays on this device.",
  "settings.memory.enabled.title": "Remember across chats",
  "settings.memory.enabled.description": "Let NovaClaw learn and recall things about you and your work as you chat.",
  "settings.memory.enabled.description.more":
    "Turn off to stop all recall and saving — what's already stored stays until you clear it.",
  "settings.memory.io.hint":
    "Export a backup to keep or move to another instance, restore one here, or clear everything for a fresh start.",
  "settings.memory.export.action": "Export",
  "settings.memory.export.toast": "Memory backup download started",
  "settings.memory.export.empty": "Nothing to back up yet",
  "settings.memory.import.action": "Import",
  "settings.memory.ingest.action": "Add document",
  "settings.memory.ingest.toast": "Added {{count}} passages from {{name}} to memory",
  "settings.memory.ingest.already": "{{name}} is already in memory",
  "settings.memory.import.toast": "Restored {{count}} memories",
  "settings.memory.import.empty": "That backup has no memories",
  "settings.memory.import.none": "Nothing could be restored",
  "settings.memory.import.invalid.title": "That doesn’t look like a memory backup",
  "settings.memory.import.invalid.description": "Pick a memory backup file exported from NovaClaw.",
  "settings.memory.import.invalid.version": "This backup is from a newer version of NovaClaw. Update to import it.",
  "settings.memory.import.confirm.title": "Restore memory?",
  "settings.memory.import.confirm.description":
    "Add {{count}} remembered things back into NovaClaw. Your existing memories are kept.",
  "settings.memory.import.confirm.action": "Restore",
  "settings.memory.clearAll.action": "Clear all",
  "settings.memory.clearAll.confirm.title": "Clear all memory?",
  "settings.memory.clearAll.confirm.description":
    "NovaClaw will forget everything it has learned, across every chat. A complete backup download starts first so you can restore it. This can’t be undone.",
  "settings.memory.clearAll.confirm.action": "Clear everything",
  "settings.memory.clearAll.empty": "There was nothing to clear",
  "settings.memory.clearAll.toast": "Cleared {{count}} memories",
  "settings.memory.clearAll.toastBackup": "Cleared {{count}} memories. Backup download started",
  "settings.memory.clearChat.action": "Clear this chat",
  "settings.memory.clearChat.confirm.title": "Clear this chat’s memory?",
  "settings.memory.clearChat.confirm.description":
    "Forget what NovaClaw learned in this chat. Memory from other chats, and everything it remembers for good, are kept.",
  "settings.memory.clearChat.confirm.action": "Clear this chat",
  "settings.memory.clearChat.toast": "This chat’s memory was cleared",
  "settings.memory.list.title": "Remembered ({{count}})",
  "settings.memory.list.titleEmpty": "Remembered",
  "settings.memory.list.sourceHidden":
    "{{count}} source passages from ingested documents are not listed here — open Graph to browse them.",
  "settings.memory.list.empty": "Nothing remembered yet. NovaClaw learns as you chat — no setup needed.",
  // 🔴 The unavailable state must never borrow the empty-state copy: "nothing remembered yet" and
  // "no setup needed" are both FALSE when the store cannot open, and the two states look identical
  // to the user otherwise. Measured 2026-08-12 by fault injection.
  "settings.memory.unavailable.title": "Memory is not working",
  "settings.memory.unavailable.body":
    "NovaClaw cannot open its memory store, so nothing is being remembered and saved memories cannot be read. This is not an empty memory — it is a fault.",
  "settings.memory.unavailable.retry": "Retry",
  "settings.memory.unavailable.retrying": "Retrying…",
  "settings.memory.scope.global": "Always",
  "settings.memory.scope.chat": "This chat",
  "settings.memory.scope.otherChat": "Another chat",
  "settings.memory.embedding.title": "Semantic search (advanced)",
  "settings.memory.embedding.description":
    "Point NovaClaw at a local embedding model and memory search also matches by MEANING, not just wording — it can find “favourite programming language” when you ask about a “coding tongue”. Leave blank to match on keywords only.",
  "settings.memory.embedding.url.title": "Embedding server",
  "settings.memory.embedding.url.description":
    "Address of an OpenAI-compatible embeddings server on your machine or network. Stays local.",
  "settings.memory.embedding.model.title": "Embedding model",
  "settings.memory.embedding.model.description": "The model id that server serves.",
  "settings.memory.embedding.none": "Not set — keyword matching only",
  "settings.memory.embedding.typed": "Type it myself…",
  "settings.memory.forget.action": "Forget this",
  // The confirm that replaced the expertise gate on forgetting (owner, 2026-08-20: the Memory
  // app "has no way to remove memories" — the control existed and their level hid it). The
  // memory's own text is the dialog body, so the question names what is about to go.
  "memory.forget.confirm.title": "Forget this?",
  // Batch removal from the Memory app itself (owner, 2026-08-20). The two scopes are asked as
  // different questions because they are: one clears what this chat learned, the other clears
  // everything Nova knows.
  "memory.forgetAll.confirm.title": "Forget everything Nova has learned?",
  "memory.forgetChat.confirm.title": "Forget what this chat taught Nova?",
  "memory.forgetAll.confirm.action": "Forget them",
  "memory.clearScope.shared": "Shared with everyone",
  "memory.protection.retry": "Retry protection status",
  "memory.protection.saving": "Saving protection…",
  "memory.protection.loading": "Checking protection…",
  "memory.clearScope.action": "Clear memory: {{owner}}",
  "memory.clearScope.title": "Clear memory for {{owner}}?",
  "memory.clearScope.description": "Remove every memory in {{owner}}. Other memory is kept. This cannot be undone.",
  "settings.memory.toast.failed": "Something went wrong with memory",
  "settings.about.author": "by Nancy Sadkov",
  "settings.about.credits.title": "Built with open-source software",
  "settings.about.credits.description":
    "NovaClaw stands on these projects, used under their respective licenses. Thank you to their authors.",
  "settings.about.more":
    "…and many other open-source packages, each under its own license — see the NOTICE file for the full list.",
  "settings.introspection.title": "Introspection",
  "settings.introspection.description":
    "A judge model periodically checks whether a running session is stuck and, when it is, injects a course-correcting note.",
  "settings.introspection.toast.failed": "Saving introspection settings failed",
  "settings.introspection.row.enabled.title": "Enable introspection",
  "settings.introspection.row.enabled.description": "Ask the judge model during long turns whether the agent is stuck.",
  "settings.introspection.row.cadence.title": "Cadence",
  "settings.introspection.row.cadence.description": "Judge every N continuation steps within a turn.",
  "settings.introspection.row.model.title": "Judge model",
  "settings.introspection.row.model.description":
    "Model that judges, as provider/model. Empty = same as the session's model.",
  "settings.introspection.row.model.placeholder": "same as active model",
  "settings.introspection.row.model.custom": "Type a model id…",
  "settings.introspection.row.generate.title": "Generate the interjection",
  "settings.introspection.row.generate.description":
    "Let the judge model write the interjection from context instead of using the fixed text below.",
  "settings.introspection.row.prompt.title": "Introspection prompt",
  "settings.introspection.row.prompt.description":
    "The question the judge is asked about the recent context. Empty = the default stuck/looping check.",
  "settings.introspection.row.interjection.title": "Interjection",
  "settings.introspection.row.interjection.description":
    "Text injected into the session when the judge answers YES. Empty = the default redirect.",
  "settings.affective.title": "Affective",
  // ⚠️ The visible line keeps "around the model's baseline": a user reading only the short form must
  // not think this replaces their sampling settings. The inputs to the mood and the unattended-only
  // redirect are the mechanism, and move behind the disclosure.
  "settings.affective.description":
    "Emotion-modulated sampling: a per-session mood nudges temperature around the model's baseline.",
  "settings.affective.description.more":
    "The mood is derived from tool errors, repeated actions and time-on-task, and it moves temperature and related sampling parameters. Unattended agent runs additionally get a redirect nudge when frustration or urgency runs high — attended chats never do.",
  "settings.affective.toast.failed": "Saving affective settings failed",
  "settings.affective.row.enabled.title": "Enable affective mode",
  "settings.affective.row.enabled.description":
    "Modulate sampling by session mood; unattended agent runs also get a nudge on frustration/urgency.",
  "settings.affective.row.temperature.title": "Baseline temperature",
  "settings.affective.row.temperature.description":
    "Calm-state temperature used when the model config sets none. Empty = 0.7.",
  "settings.affective.row.extended.title": "Extended parameters",
  "settings.affective.row.extended.description":
    "Also modulate top_k — for local engines (vLLM, llama.cpp) that accept it.",
  "settings.strict.title": "Strict mode",
  // The line says what Strict IS; how it works and what it buys are one gesture away.
  "settings.strict.description":
    "The training-wheels harness for small local models, applied to Strict-harness sessions.",
  "settings.strict.description.more":
    "Instead of trusting the model to plan a long task, the system breaks work into tiny steps, verifies each one by actually compiling and running things, and recovers from mistakes automatically — so a modest model on your own hardware can finish jobs that normally need a frontier model.",
  "settings.strict.toast.failed": "Saving Strict-mode settings failed",
  "settings.strict.row.enabled.title": "Enable Strict mode",
  "settings.strict.row.enabled.description": "Run tasks under the Strict harness: plan, act, verify each step.",
  "settings.strict.row.enabled.description.more":
    "A verified checkpoint follows every action. Because it builds and runs things on its own, a chat also needs its permission mode set to Bypass (or Yolo) — below that, the chat explains and answers normally.",
  "settings.strict.row.verification.title": "Verification gates",
  "settings.strict.row.verification.description":
    "Track what each build produced and re-run the kept tests after every edit — a change that silently breaks something verified is caught immediately.",
  "settings.strict.row.recovery.title": "Recovery & keep-best",
  "settings.strict.row.recovery.description":
    "Snapshot the best result so far and restore it if later edits make things worse (including at the very end); undo runs of build-breaking edits automatically.",
  "settings.strict.row.editingAids.title": "Editing aids",
  "settings.strict.row.editingAids.description":
    "Show files with line numbers, reject edits that would not compile, and require line-number edits when the model keeps mis-quoting a file.",
  "settings.strict.row.budgetSteering.title": "Time-budget steering",
  "settings.strict.row.budgetSteering.description":
    "At 50% and 75% of the time budget, calmly steer the model to simplify and land an end-to-end result.",
  "settings.strict.row.attempts.title": "Parallel attempts (race)",
  // 377 characters under one control. The line is what the setting does and how to turn it off; the
  // trade and the size limit are on demand — and the limit is kept WORD FOR WORD, because "~5000
  // files / 256 MB" is a fact a user plans around and a paraphrase would promise more than the code.
  "settings.strict.row.attempts.description":
    "Race several isolated attempts and keep the first that verifiably succeeds. Empty or 1 = off.",
  "settings.strict.row.attempts.description.more":
    "Each attempt runs on its own copy of your project, so a lost race leaves your folder untouched. More attempts = better odds and more compute; your local hardware runs them nearly in parallel. Works for folders up to ~5000 files / 256 MB (larger ones fall back to a single attempt).",
  "settings.strict.budget.off": "Off",
  "settings.strict.budget.tight": "Tight",
  "settings.strict.budget.standard": "Standard",
  "settings.strict.budget.roomy": "Roomy",
  "settings.strict.budget.custom": "Custom…",
  "settings.strict.row.wallMinutes.title": "Time budget (minutes)",
  "settings.strict.row.wallMinutes.description":
    "Wall-clock budget per Strict task; at exhaustion the best verified state is delivered. Empty = 45.",
  "settings.strict.row.executionTokens.title": "Execution budget (tokens)",
  "settings.strict.row.executionTokens.description": "Room each working step gets to write its answer.",
  "settings.strict.row.executionTokens.description.more":
    "File edits, commands, and the like. A step that runs out mid-file is wasted work, so leave headroom: one non-trivial source file already runs to 13–15k tokens. Empty = 24576.",
  "settings.strict.row.reasoningTokens.title": "Reasoning budget (tokens)",
  "settings.strict.row.reasoningTokens.description": "Room for the model to think a step through before it acts.",
  "settings.strict.row.reasoningTokens.description.more":
    "Reasoning is all-or-nothing: a model cut off mid-thought returns nothing at all, so this needs to be generous — 24576 works, 8192 returns empty. Costs an extra call on the steps that plan and recover. Empty or 0 = off.",
  "settings.webSearch.title": "Web Search",
  "settings.webSearch.description":
    "Web search just works out of the box — NovaClaw searches free engines in-process, no setup. Point it at your own SearXNG for richer results, or turn a built-in engine off if it starts misbehaving.",
  "settings.webSearch.status": "Right now",
  "settings.webSearch.status.builtin": "Using NovaClaw's built-in search (DuckDuckGo + Wikipedia).",
  "settings.webSearch.status.searxng": "Using your SearXNG instance.",
  "settings.webSearch.status.airgapped": "Web search is off while Offline mode is on.",
  "settings.webSearch.row.searxng.title": "Your SearXNG instance",
  "settings.webSearch.row.searxng.description":
    "A SearXNG URL to use instead of the built-in engines. Leave empty to use the built-in search.",
  "settings.webSearch.builtin.title": "Built-in engines",
  "settings.webSearch.builtin.description":
    "NovaClaw asks these free engines directly and merges the results. Turn one off if it starts failing.",
  "settings.webSearch.builtin.overridden": "Your SearXNG instance is handling search, so the built-in engines are off.",
  "settings.webSearch.builtin.engineHint": "Included in built-in search",
  "settings.webSearch.toast.failed": "Couldn't save web search settings",
  "settings.webSearch.throttle.title": "Traffic limits",
  "settings.webSearch.throttle.description":
    "How fast NovaClaw reads from the web. These apply to every web read — searches and articles alike. The defaults imitate a person reading, which is what keeps sites treating you as one.",
  "settings.webSearch.throttle.warning":
    "⚠️ Changing these can get you blocked. Sites judge you by your traffic, and reads come from your own connection — so a faster, heavier setting risks your IP being rate-limited or banned, for you and for anything else on your network. Leave a field empty to use its default.",
  "settings.webSearch.throttle.interval": "Delay between reads of one site",
  "settings.webSearch.throttle.interval.hint":
    "Seconds to wait before reading the same site again. Lower looks more like a bot.",
  "settings.webSearch.throttle.burst": "Reads allowed back-to-back",
  "settings.webSearch.throttle.burst.hint":
    "How many quick reads of one site before the delay kicks in — like opening a few tabs at once.",
  "settings.webSearch.throttle.concurrency": "Simultaneous reads per site",
  "settings.webSearch.throttle.concurrency.hint":
    "Keep at 1. Reading one site on several connections at once is the fastest way to get blocked.",
  "settings.webSearch.throttle.daily": "Reads per site per day",
  "settings.webSearch.throttle.daily.hint":
    "A daily ceiling per site, so a stuck agent can't spend all day hammering one server.",
  "settings.webSearch.throttle.sameUrl": "Same-page retry limit",
  "settings.webSearch.throttle.sameUrl.hint":
    "Refuse to fetch one page more times than this in a session — catches an agent stuck in a loop.",
  "settings.computer.title": "Computer Use",
  "settings.computer.description":
    "Let the agent see a screen and click on it, and decide how much it may do before asking you.",
  "settings.computer.display.name": "Display",
  "settings.computer.windows.description": "On Windows, NovaClaw drives one application at a time, not a whole screen.",
  "settings.computer.windows.description.more":
    "The agent names the program it wants (for example dosbox-x.exe) and you approve it when it asks. There is no display to set here.",
  "settings.computer.windows.value": "Per app, on request",

  "settings.computer.display.description": "The X display the agent observes and clicks, for example :99.",
  "settings.computer.display.description.more":
    "Leave it empty and computer use stays off — a display is never picked up from the environment, because that would either fail on a server or quietly drive your own screen.",
  "settings.computer.screenshot.name": "Screenshot path",
  "settings.computer.screenshot.description":
    "Where screenshots are written on the machine serving the display. Defaults to a temporary file.",
  "settings.computer.permission.name": "Ask before acting",
  "settings.computer.permission.description":
    "What happens when the agent wants to look at the screen or click something.",
  "settings.computer.permission.ask": "Ask me every time",
  "settings.computer.permission.allow": "Let it act on its own",
  "settings.computer.permission.deny": "Never allow",
  "settings.computer.unset": "No display is set, so computer use is off. The agent will say so if it tries.",
  "settings.computer.save.failed": "Could not save the computer-use settings",
  "settings.tools.title": "Tools",
  "settings.tools.description":
    "Ad-hoc tool recipes: a name, a one-line description the model sees in its prompt, and a manual it pulls on demand (the API shape plus a curl example). The model runs them from the shell — no MCP server to set up.",
  "settings.tools.empty": "No ad-hoc tools defined yet.",
  "settings.tools.add": "Add tool",
  "settings.tools.edit": "Edit",
  "settings.tools.delete": "Delete",
  "settings.tools.save": "Save",
  "settings.tools.cancel": "Cancel",
  "settings.tools.toast.failed": "Saving tools failed",
  "settings.tools.field.name": "name (lowercase slug, e.g. searxng)",
  "settings.tools.field.description": "One-line description (what it does; the model decides from this alone)",
  "settings.tools.field.manual": "Manual: the API shape + 1-2 curl/shell examples the model follows",
  "settings.tools.error.name": "Name must be a lowercase slug (a-z, 0-9, -, _), max 64 chars.",
  "settings.tools.error.description": "Description is required, max 300 chars.",
  "settings.tools.error.manual": "Manual is required, max 8192 chars.",
  "settings.tools.error.duplicate": "A tool with this name already exists.",
  "settings.tools.error.saveFailed":
    "Saving failed — nothing was written. The editor is still open and everything you typed is still here.",

  "settings.permissions.tool.read.title": "Read",
  "settings.permissions.tool.read.description": "Read a file",
  "settings.permissions.tool.edit.title": "Edit",
  "settings.permissions.tool.edit.description": "Change part of an existing file",
  "settings.permissions.tool.write.title": "Overwrite",
  "settings.permissions.tool.write.description": "Replace everything in an existing file",
  "settings.permissions.tool.create.title": "Create",
  "settings.permissions.tool.create.description": "Create a new file",
  "settings.permissions.tool.explore.title": "Explore",
  "settings.permissions.tool.explore.description": "List and search through your files",
  "settings.permissions.tool.bash.title": "Bash",
  "settings.permissions.tool.bash.description": "Run shell commands",
  "settings.permissions.tool.task.title": "Task",
  "settings.permissions.tool.task.description": "Start helper agents to work on part of the task",
  "settings.permissions.tool.skill.title": "Skill",
  "settings.permissions.tool.skill.description": "Load a skill by name",
  "settings.permissions.tool.todowrite.title": "Todo Write",
  "settings.permissions.tool.todowrite.description": "Update the todo list",
  "settings.permissions.tool.webfetch.title": "Web Fetch",
  "settings.permissions.tool.webfetch.description": "Fetch content from a URL",
  "settings.permissions.tool.websearch.title": "Web Search",
  "settings.permissions.tool.websearch.description": "Search the web",
  "settings.permissions.tool.trash.title": "Move to Trash",
  "settings.permissions.tool.trash.description": "Delete a file into a restorable Trash instead of erasing it",
  "settings.permissions.tool.js.title": "Run JavaScript",
  "settings.permissions.tool.js.description": "Evaluate a snippet of JavaScript and return its result",
  "settings.permissions.tool.computer.title": "Use the Computer",
  "settings.permissions.tool.computer.description": "Move the pointer, type, and read what is on screen",
  "settings.permissions.tool.wait.title": "Wait for a Job",
  "settings.permissions.tool.wait.description": "Wait for something it started in the background to finish",
  "settings.permissions.tool.resource_status.title": "Resource Status",
  "settings.permissions.tool.resource_status.description": "Read this machine's memory, disk and model load",
  "settings.permissions.tool.chat_upgrade.title": "Upgrade the Chat",
  "settings.permissions.tool.chat_upgrade.description": "Ask to turn a quick chat into a full session with tools",
  "settings.permissions.tool.kb.title": "Knowledge Base",
  "settings.permissions.tool.kb.description": "Read and write the knowledge base",
  "settings.permissions.tool.recipe.title": "Recipes",
  "settings.permissions.tool.recipe.description": "List and cook a recipe folder's instructions",
  "settings.permissions.tool.revert.title": "Undo Changes",
  "settings.permissions.tool.revert.description": "Roll recent file changes back",
  "settings.permissions.tool.provision.title": "Set Up the Toolchain",
  "settings.permissions.tool.provision.description": "Work out and record how to check, test and lint this project",
  "settings.permissions.tool.define_tool.title": "Define a Tool",
  "settings.permissions.tool.define_tool.description": "Create a new tool for itself while it works",
  "settings.permissions.tool.register-app.title": "Add an App",
  "settings.permissions.tool.register-app.description": "Put a new tile on the Home launcher",
  "settings.permissions.tool.spawn.title": "Start a Sub-agent",
  "settings.permissions.tool.spawn.description": "Hand part of the task to a helper it creates",
  "settings.permissions.tool.colleague.title": "Hand Off to a Colleague",
  "settings.permissions.tool.colleague.description": "Give work to another named agent on the roster",
  "settings.permissions.tool.community_ask.title": "Ask the Community",
  "settings.permissions.tool.community_ask.description": "Ask another user's Nova a question",
  "settings.permissions.tool.community_say.title": "Answer the Community",
  "settings.permissions.tool.community_say.description": "Answer a question another user's Nova asked",
  "settings.permissions.tool.messenger.connect.title": "Connect a Messenger",
  "settings.permissions.tool.messenger.connect.description": "Link one of your messaging accounts",
  "settings.permissions.tool.messenger.initiate.title": "Start a Conversation",
  "settings.permissions.tool.messenger.initiate.description": "Message someone who has not written first",
  "settings.permissions.tool.messenger.moderate.title": "Moderate a Chat",
  "settings.permissions.tool.messenger.moderate.description": "Act on other people's messages in a group",
  "settings.permissions.tool.messenger.send.title": "Send a Message",
  "settings.permissions.tool.messenger.send.description": "Reply in a conversation someone else started",
  "settings.permissions.tool.plan_enter.title": "Enter Analyze Mode",
  "settings.permissions.tool.plan_enter.description": "Switch to read-only planning",
  "settings.permissions.tool.plan_exit.title": "Leave Analyze Mode",
  "settings.permissions.tool.plan_exit.description": "Switch back from read-only planning",
  "settings.permissions.tool.external_directory_read.title": "Read External Directory",
  "settings.permissions.tool.external_directory_read.description":
    "Read host-readable files outside the project directory; available in every permission mode and never grants writes there",
  "settings.permissions.tool.external_directory_write.title": "Write External Directory",
  "settings.permissions.tool.external_directory_write.description":
    "Modify, create, or delete files outside the project directory",

  "session.gone.title": "This chat was deleted or has expired",
  "session.gone.body":
    "It may have been removed from another window or cleaned up automatically. Its tab has been closed.",
  "session.gone.action": "Back to Home",
  "session.delete.failed.title": "Couldn't delete chat",
  "session.delete.title": "Delete chat",
  "session.delete.confirm": 'Delete chat "{{name}}"?',
  "session.delete.description":
    "The whole conversation and its history are removed permanently. Files in your project folder are not touched.",
  "session.delete.button": "Delete chat",

  "workspace.new": "New workspace",
  "workspace.type.local": "local",
  "workspace.type.sandbox": "sandbox",
  "workspace.error.stillPreparing": "Workspace is still preparing",

  // Throwing an agent-contributed tile away (right-click, or drag it onto Trash). ⚠️ NOT under
  // `home.app.*`: that namespace is `home.app.<id>.{name,subtitle}` and `app-label.test.ts` fails on
  // any key in it that does not name a built-in tile — `home.app.delete.title` would read as a tile
  // called "delete".
  "home.launcher.delete.title": "Remove {{app}}?",
  "home.launcher.delete.description":
    "The tile goes away and the app is deregistered from this instance. Anything it created — chats, files, notes — is untouched, and an agent can add it back.",
  "home.launcher.delete.confirm": "Remove",
  "home.launcher.delete.done": "{{app}} removed",
  "home.launcher.delete.failed": "Could not remove {{app}}",

  // Home launcher tiles. `home.app.<id>.name` / `.subtitle`, resolved by `apps/app-label.ts`.
  // Built-in tiles have a key here; plugin and agent-contributed apps do not, and keep their own
  // label — a contributed app is never required to have a key, and never renders one.
  "home.app.contacts.name": "Contacts",
  "home.app.contacts.subtitle": "The colleagues this NovaClaw employs, and what each one remembers",
  "home.app.contacts.stat.running": "running",
  "home.app.contacts.stat.throughput": "t/s",
  "home.app.contacts.stat.memory": "memory",
  "home.app.notes.name": "Notes",
  "home.app.notes.subtitle": "Everyday notes, shared with your agents",
  "home.app.calendar.name": "Calendar",
  "home.app.calendar.subtitle": "Schedule agents to run on a repeating date",
  "home.app.recipes.name": "Recipes",
  "home.app.recipes.subtitle": "Ready-made prompts your agents can cook",
  "home.app.files.name": "Files",
  "home.app.files.subtitle": "Browse folders and ask AI to work on them",
  "home.app.terminal.name": "Terminal",
  "home.app.terminal.subtitle": "A shell, for when you want one",
  "home.app.registry.name": "Registry",
  "home.app.registry.subtitle": "The instance database, editable — handle with care",
  "home.app.debug.name": "Debug",
  "home.app.debug.subtitle": "Connection, error log, sessions — under the hood",
  "agentConfig.close": "Close",
  "contacts.paused": "Paused",
  "contacts.hiddenCount": "Hidden ({{count}})",
  "agentConfig.pause": "Pause",
  "agentConfig.resume": "Resume",
  "agentConfig.pausing": "Saving…",
  "agentConfig.pauseFailed": "Could not change whether this colleague is paused",
  "contacts.pausedHint": "Set aside. Keeps its chat, its memories and its name, but will not act until resumed.",
  "agentConfig.back": "Back",
  "agentConfig.clearChat": "Clear chat",
  "agentConfig.clearing": "Clearing…",
  "agentConfig.clearedTitle": "Chat cleared — the next one starts fresh",
  "agentConfig.clearNothing": "There is no chat to clear yet",
  "agentConfig.clearFailed": "Could not clear this chat",
  // Confirm-gated like Retire, and for the same reason: the conversation is archived rather than
  // deleted, but no surface the user has can bring it back. What SURVIVES is said out loud, because
  // "clear" next to a colleague reads like it might take the colleague with it.
  "agentConfig.clear.confirm.title": "Clear your chat with {{name}}?",
  "agentConfig.clear.confirm.description":
    "These messages are deleted and a fresh chat opens in their place. {{name}} stays on your roster and keeps its brief and its memories — only the messages go.",
  "agentConfig.clear.confirm.action": "Clear chat",
  "agentConfig.clone": "Clone",
  "agentConfig.cloning": "Cloning…",
  "agentConfig.clonedTitle": "Hired {{name}} — same brief, its own memory",
  "agentConfig.cloneFailed": "Could not clone this colleague",
  "agentConfig.cloneNovaTitle": "One Nova per NovaClaw",
  "agentConfig.cloneNovaDescription":
    "Nova is this instance's single CEO. If you want another Nova, deploy a separate NovaClaw instance.",
  "agentConfig.retire": "Retire",
  "agentConfig.retiring": "Retiring…",
  // The door into ONE colleague's cabinet, opened from that colleague. Two spellings because a count
  // is only worth showing once there is something to count — "remembers 0 things" reads as a fault,
  // and a new hire that has learned nothing yet is not faulty.
  "agentConfig.memoryOpen": "See what {{name}} remembers",
  "agentConfig.memoryOpenCount": "See what {{name}} remembers ({{count}})",
  "agentConfig.retire.confirm.title": "Retire {{name}}?",
  // Names what is DESTROYED, in the order it will be missed — role, chat AND private memories.
  // ⚠️ If this control's blast radius grows again, this sentence grows with it: a control that
  // quietly grew teeth is worse than one that never had them.
  "agentConfig.retire.confirm.description":
    "Their chat is archived and everything they remember is set aside, so no future colleague inherits it. The name goes back into the pool.",
  "agentConfig.retire.confirm.action": "Retire",
  "agentConfig.retiredTitle": "{{name}} has been retired",
  "agentConfig.retireFailed": "Could not retire this colleague",
  "agentConfig.cancel": "Cancel",
  "agentConfig.save": "Save",
  "agentConfig.saving": "Saving…",
  "agentConfig.saveFailed": "Could not save this colleague's profile",
  "agentConfig.noTitle": "No job title yet",
  "agentConfig.who": "Who this colleague is",
  "agentConfig.name": "Name",
  "agentConfig.jobTitle": "Job title",
  "agentConfig.jobTitlePlaceholder": "Talent Scout, Expense Manager, Dungeon Master…",
  "agentConfig.personality": "Personality and standing instructions",
  "agentConfig.personalityPlaceholder": "How it should speak, what it should always do, what it must never do.",
  "agentConfig.portrait": "Portrait",
  "agentConfig.portraitHint":
    "Stored on this NovaClaw and shown to the model when it looks at its colleagues. PNG, JPEG, GIF or WebP, up to 5 MB.",
  "agentConfig.portraitRemove": "Remove uploaded portrait",
  "agentConfig.memory": "What it remembers",
  "agentConfig.mind": "Model it thinks with",
  // ── How colleagues work ─────────────────────────────────────────────────────────────────────────
  // Behind one Help button, and written about the MODEL rather than this dialog's fields: a help
  // page that narrates the form goes stale the day a control moves, one that explains the ideas is
  // still true afterwards.
  // The composer's project button. "No project" is a STATE, not an empty value: a colleague without
  // one works in its own workspace, which is a real place and not a missing setting.
  "prompt.agent.project.none": "No project",
  "prompt.agent.project.own": "Works in its own workspace",
  "prompt.agent.project.pick": "Choose this colleague's project folder",
  "agentHelp.title": "How colleagues work",
  "agentHelp.back": "Back",
  "agentHelp.close": "Close",
  "agentHelp.colleague.title": "A colleague",
  "agentHelp.colleague.body":
    "Each colleague is someone you keep, not a chat you start. It has a name, a job, and a brief you write — and it stays itself between conversations. Renaming one changes nothing else about it: everything it remembers stays with it. Nova is the exception, and cannot be renamed or retired, because it is the one that hires and briefs the others.",
  "agentHelp.memory.title": "What it remembers",
  "agentHelp.memory.body":
    "A colleague set to remember keeps its own private notes, which survive every conversation and are never summarised away. What it learns is its own — the household facts everyone can see are separate, and shared with every colleague on purpose. Set a colleague to remember nothing and it becomes a throwaway: useful when you want no trace kept.",
  "agentHelp.project.title": "What it works on",
  "agentHelp.project.body":
    "Give a colleague a project folder and that is where it works. Leave it without one and it uses its own workspace — a private folder it can always write to, which is where its notes, drafts and scratch files go. Change the project and the colleague is told, so it does not carry on thinking it works on the old one.",
  "agentHelp.model.title": "What it thinks with",
  "agentHelp.model.body":
    "A colleague has one mind. Pick a model for it and every conversation uses that one; leave it inheriting and it follows the model set in Settings. Choosing per chat instead would make the same colleague clever in one conversation and poor in the next, for reasons you could not see.",
  "agentHelp.chat.title": "Its chat",
  "agentHelp.chat.body":
    "A colleague has exactly one conversation, so there is no list to lose things in. Clearing it puts the conversation away and starts fresh — the colleague, its brief and its memories all stay. When a chat gets long it is summarised to keep going, and by default the older part is kept in the colleague's memory so it can still look things up.",
  "agentConfig.modelInherit": "Whatever this NovaClaw uses by default",
  "agentConfig.reasoningBudget": "Reasoning budget",
  "agentConfig.reasoningBudgetModel": "Model default",
  "agentConfig.reasoningBudgetDefault": "Uses the selected model's reasoning budget.",
  "agentConfig.reasoningBudgetOff": "Reasoning is off — answer directly.",
  "agentConfig.reasoningBudgetCustom": "Wrap up reasoning after about {{tokens}} tokens, then answer.",
  "agentConfig.superior": "Superior",
  "agentConfig.superiorNova": "Nova — CEO (default)",
  "agentConfig.superiorDescription":
    "This colleague asks its superior to resolve overlapping work and conflicts. Reporting lines cannot form a loop.",
  "agentConfig.needsTier": "This job needs at least",
  "agentConfig.needsTierNone": "No requirement — any model is fine",
  "agentConfig.needsTierBelow":
    "The model chosen above is below this. Nothing is blocked, and they will say so themselves.",
  "agentConfig.tier.micro": "Micro — very small local model",
  "agentConfig.tier.tiny": "Tiny",
  "agentConfig.tier.small": "Small",
  "agentConfig.tier.medium": "Medium",
  "agentConfig.tier.large": "Large",
  "agentConfig.tier.frontier": "Frontier — the strongest available",
  "agentConfig.modelTooSmall":
    "This colleague has a long standing brief for a model this small — it may lose the end of its own instructions. It will still try.",
  // The colleague's PROJECT. Named for the relationship ("works on"), not for the mechanism ("cwd"):
  // the user is assigning a person to a job, and the folder is how that is expressed.
  // The standing WORK choices — how this colleague operates, every time. Moved off the composer
  // 2026-08-21: re-choosing per chat is a question asked again for a decision that never changes.
  "agentConfig.work": "How it works",
  "agentConfig.posture": "Mode",
  "agentConfig.strict": "Strict — verify each step, and retry a step that fails",
  "agentConfig.reground": "Double-check the request before finishing",
  "agentConfig.regroundDescription":
    "On by default. Turn this off when this colleague should stop without Nova's final acceptance-check reminder.",
  "agentConfig.folder": "What it works on",
  "agentConfig.folderScratch": "Its own workspace",
  "agentConfig.folderOwn": "Back to its own",
  // Browsing the colleague's own workspace (owner, 2026-08-22). Worded as a place belonging to
  // SOMEBODY — "Open workspace" would read as a generic folder, and the whole point is that this one
  // is Theron's and nobody else's.
  "agentConfig.browseWorkspace": "Browse {{name}}'s workspace",
  "agentConfig.folderPick": "Choose the folder this colleague works on",
  "agentConfig.archive": "When the chat gets long",
  "agentConfig.archiveKeep": "Keep the older conversation in memory.",
  "agentConfig.archiveThrowaway": "A throwaway keeps nothing, so there is nothing to archive.",
  "agentConfig.governingLocked": "Nova's profile is fixed.",
  "agentConfig.thisChat": "How this chat runs",
  // The household row at the foot of the roster — everything every colleague can read. Named for WHO
  // can see it, not for where it is stored: "shared" is the fact a user needs before they write
  // something into it.
  "contacts.shared": "Shared with everyone",
  "contacts.sharedHint": "What every colleague can read — your household's facts, not any one agent's",
  "contacts.search": "Search by name or job",
  "contacts.hire": "Hire",
  "contacts.hiring": "Hiring…",
  "contacts.hireFailed": "Could not hire a colleague",
  "contacts.empty": "No colleagues yet. Ask Nova for one — say what you need done and it will hire for the job.",
  "contacts.noMatch": "No colleague matches that.",
  "contacts.loading": "Reading the roster…",
  "contacts.loadFailed":
    "Could not read the roster from this instance. Your colleagues are still there — this view could not reach them.",
  "contacts.retry": "Try again",
  "contacts.governing": "CEO",
  "contacts.noTitle": "No job title yet",
  "contacts.startFailed": "Could not start a chat with this colleague",
  "contacts.spend": "Tokens this colleague and its helpers have produced",
  "contacts.rate": "{{tokens}}/min",
  // The row's live line. Each is a WORD, not a sentence: four facts share one line, so anything
  // longer than a label pushes the others off the row it exists to inform.
  "contacts.noTask": "No task",
  // The tilde is load-bearing: a true rate needs each model'''s own tokenisation, so this is an
  // estimate that is about right across models rather than exact for one. It says the model and the
  // agent are alive and working — it is not a benchmark, and must not read like one.
  "contacts.perSecond": "~{{tokens}} tok/s",
  // Three words, matching what the scheduler actually knows. "Error" is the reachability case — a
  // provider being retried — because a colleague that cannot run must not read as a healthy pause.
  "contacts.state.idle": "Idle",
  "contacts.state.paused": "Paused safely",
  "contacts.state.working": "Working",
  "contacts.state.error": "Error",
  "contacts.rateTitle": "Tokens produced per minute, averaged over the last {{window}} minutes",
  "contacts.configure": "Configure this colleague",
  "contacts.clone": "Clone {{name}}",
  "contacts.workers.count.one": "{{count}} worker",
  "contacts.workers.count.other": "{{count}} workers",
  "contacts.workers.title": "{{name}}'s workers",
  "contacts.workers.open": "Open worker chat",
  "contacts.workers.openAll": "See {{name}}'s workers",
  "contacts.workers.untitled": "Worker {{number}}",
  "contacts.memory.own": "Remembers its own chats, privately.",
  "contacts.memory.none": "Remembers nothing — a throwaway.",
  "contacts.memory.shared": "Shares this machine, its files and your household facts with every colleague.",
  "home.app.trash.name": "Trash",
  "home.app.trash.subtitle": "Restore safely deleted files before their retention period ends",
  "home.app.social.name": "Community",
  "home.app.social.subtitle": "Discord, Reddit and the website — other people who run NovaClaw",
  "home.app.help.name": "Help",
  "home.app.help.subtitle": "A short tour of what NovaClaw can do",
  "home.app.settings.name": "Settings",
  "home.app.settings.subtitle": "Providers, models, servers, recovery",
  "home.app.skills.name": "Skills",
  "home.app.skills.subtitle": "Extra instructions your agents can follow, and who wrote each one",
  "command.session.previous.unseen": "Previous unread chat",
  "command.session.next.unseen": "Next unread chat",
  // ── Community: the consent screen ────────────────────────────────────────────────────────────
  //
  // 🔴 The whole panel was outside i18n — 91 hard-coded English strings and no `t()` call — so a
  // German user CONSENTED IN ENGLISH (review 1.15). Of everything in the panel this screen is the
  // part where that is a real harm rather than an inconvenience: it is the screen whose only job is
  // that a person understands what they are accepting, and it was legible to one language's readers.
  "community.title": "Your own community",
  "community.consent.intro":
    "NovaClaw instances can talk to each other directly — yours and other people's. It is off until you turn it on, and there are four things to know first.",
  "community.consent.moderation.title": "Nobody moderates this.",
  "community.consent.moderation.body":
    "There is no company in the middle, which also means there is no one to delete what a stranger writes or to appeal to. You may see things you find offensive or upsetting. You can block people, and that is the only power anyone has here.",
  "community.consent.ip.title": "Other people will see your IP address.",
  "community.consent.ip.body":
    "Because there is no central server, your machine connects directly to theirs — so anyone you talk to learns roughly where you are, in the way any direct connection reveals.",
  "community.consent.address.title": "Your address spreads to the people you meet.",
  "community.consent.address.body":
    "Peers pass addresses to each other so strangers can find the network without anyone running a server — so an address you use can reach people you never spoke to. Listing yourself in the public directory, where anyone can find you without ever talking to you, is a separate switch that stays off until you set an address yourself.",
  "community.consent.notes.title": "Your instance keeps notes about people.",
  "community.consent.notes.body":
    "When it deals with someone — asks them something, is answered or refused — it records how that went, in its own words, so it can judge who is worth listening to later. The notes are written by the AI, they are about identifiable people, and nothing here sends them anywhere: no peer can ask for them. Your own agent does read them, because that is what they are for. Forgetting someone deletes theirs.",
  "community.consent.reversible": "You can turn it off again at any time, here in Community settings.",
  "community.consent.accept": "I understand — turn it on",
  "community.off.body": "Community is turned off. Nothing goes in or out, and other instances cannot reach yours.",
  "community.off.turnOn": "Turn it back on",
  "community.airgap.body":
    "Offline mode is on, so the community is off regardless of this setting. Turn off offline mode in Settings to use it.",
  // ── Community: the joined panel ──────────────────────────────────────────────────────────────
  //
  // The rest of review 1.15's i18n half. Same rule as the consent keys above: `en` is the source and
  // every other locale falls back key by key, so these land untranslated and are counted as backlog
  // rather than failing the parity ratchet.
  "community.turnOff": "Turn off",
  "community.key.title": "Your key",
  "community.key.explain": "Share it so someone can add you. The address behind it can change; this cannot.",
  "community.contacts.empty":
    "Nobody yet. Paste someone's key below — one person is enough to reach everyone they know.",
  "community.contacts.message": "Message",
  "community.contacts.forget": "Forget",
  "community.contacts.addPlaceholder": "Address (my-box:4096) — or paste a key",
  "community.contacts.namePlaceholder": "Name them (optional)",
  "community.find.explain": "Looks on this network, then asks whoever answers who else they know.",
  "community.announce.placeholder": "your-address:4096",
  "community.announce.publish": "Publish this address",
  "community.announce.stop": "Stop publishing",
  "community.doorman.label": "Trust the address above:",
  "community.offers.title": "Model servers",
  "community.offers.empty": "Nobody you can reach is offering one yet.",
  "community.offers.copyPayment": "Copy payment address",
  "community.offers.use": "Use this",
  "community.offers.copyAddress": "Copy address",
  "community.offers.mineEmpty": "You are not offering anything.",
  "community.offers.mineTitle": "Offer your own:",
  "community.offers.publish": "Offer",
  "community.offers.withdraw": "Withdraw",
  "community.offers.endpointPlaceholder": "Address, e.g. https://my-box:8010/v1",
  "community.offers.modelsPlaceholder": "Models, comma separated",
  "community.offers.pricePlaceholder": "Terms in your own words — e.g. free, or 500 sats a request",
  "community.offers.payToPlaceholder": "Lightning address, if you want paying (optional)",
  "community.dm.title": "Direct messages",
  "community.channels.leave": "Leave",
  "community.filters.title": "Hide messages containing:",
  "community.filters.placeholder": "A word you would rather not read",
  "community.channels.nearby": "Channels the instances you can reach say they are in:",
  "community.channels.archived": "You left these, and still have what was said in them:",
  "community.channels.joinPlaceholder": "Join a channel by name, e.g. #recipes",
  // ── Community: the sentences that carry numbers ──────────────────────────────────────────────
  //
  // ⚠️ Plurals as `.one`/`.other` SIBLING keys chosen at the call site, which is this codebase's
  // existing idiom (`session.revertDock.summary.*`). The English `n === 1` test does not travel —
  // Polish and Russian have three forms and Japanese has one — so the choice belongs to the caller
  // and the dictionary carries whatever forms a language needs.
  "community.empty.online": "No messages yet.",
  "community.empty.airgap":
    "Offline mode is on, so nothing goes in or out. Your key and the people you know are saved; turn it off in Settings to reach them.",
  "community.empty.notJoined":
    "You have not joined the community yet. Your key is already saved; turning it on above is all that is left.",
  "community.empty.noPeers":
    "Nothing here yet — this instance knows nobody to talk to. Add someone's address, or use Find to look on your network and in the public directory.",
  "community.status.checking": "Checking…",
  "community.status.connecting": "Connecting…",
  "community.status.airgap": "Offline mode is on — nothing goes in or out",
  "community.status.noPeers": "Ready — add someone with an address to reach anybody",
  "community.status.ready.one": "Ready — {{count}} peer known",
  "community.status.ready.other": "Ready — {{count}} peers known",
  "community.find.reachable.one": "{{count}} instance reachable",
  "community.find.reachable.other": "{{count}} instances reachable",
  "community.find.newlyDiscovered": " — {{count}} newly discovered",
  "community.offers.needProject": "Open a project first — the check that this endpoint works runs against one.",
  "community.offers.offered": "Offered. Peers see it next time they look.",
  "community.offers.withdrawn": "Withdrawn. Peers that already copied it keep theirs until they look again.",
  "community.contacts.savedNoAddress":
    "Saved. You have no address for them yet — find them first, or ask them for one.",
  "community.contacts.savedUnreachable": "Saved to your copy. They could not be reached just now.",
  "community.find.refusedAirgap": "Offline mode is on, so nothing was looked for. Turn it off in Settings to search.",
  "community.find.refusedOff":
    "Community is off on this instance, so nothing was looked for. Turn it on above to search.",
  "community.contacts.nothingAnswered": "Nothing answered there, so nobody was added. Check the address and try again.",
  "community.channels.savedLocally":
    "Saved to your own copy — no peer was reachable just now, so it will go out when one is.",
  "community.answers.stop": "Stop answering peers",
  "community.answers.start": "Answer peers' questions",
  "community.answers.off":
    "Off. Other instances can ask this one questions; answering spends your tokens, so it stays off until you say otherwise.",
  "community.channels.listed": "Listed — others can find you here",
  "community.find.noSeeds":
    "Found nobody on this network. Paste someone's address above — one is enough to reach everyone they know. NovaClaw runs no directory of its own, so there is nobody to ask for a starting point unless you name a zone in Settings.",
  "community.find.seedsEmpty":
    "Found nobody on this network, and the zone you named published no addresses. Paste someone's address above — one is enough to reach everyone they know.",
  "community.find.seedsTried.one":
    "Found nobody yet: {{count}} starting address was tried and none answered. Paste someone's address above if you have one.",
  "community.find.seedsTried.other":
    "Found nobody yet: {{count}} starting addresses were tried and none answered. Paste someone's address above if you have one.",
  "community.doorman.added": "Added as a doorman you trust {{trust}} of 5.",
  "community.contacts.trusted": "trusted {{trust}}/5",
  "community.answers.today":
    "{{today}} of {{total}} answered today. Each reply is signed by this instance and costs its tokens.",
  "community.announce.published":
    "Published as {{address}}. Anyone reading the public directory can see it, and it stays there for a while after you stop — we can stop renewing it, but nobody can recall the copies already out there.",
  "community.announce.noSidecar":
    "Not published — this build has no directory helper, so nothing on this machine can publish to the public directory. Everything else works: people still find you on your network, from addresses you give them, and through peers you both know.",
  "community.announce.refused":
    "Not published yet — the directory did not accept {{address}} on the last try. It will be attempted again; if it keeps failing, check that this address really reaches you from the internet.",
  "community.announce.pending":
    "Set to {{address}}. It is announced the next time this instance looks for peers, and this line will say whether the directory took it.",
  "community.announce.malformed":
    "That is not an address this can publish. It needs a host and a port, like my-box:4096 or 203.0.113.5:4096 — no https:// and no path.",
  "community.dm.writeTo": "Write to {{name}}",
  "community.channels.sayIn": "Say something in {{channel}}",
  "community.channels.showingRecent": "Showing the most recent {{shown}} of {{held}} messages this room holds.",
  "community.channels.hiddenByFilters.one": "{{count}} message hidden by your words below.",
  "community.channels.hiddenByFilters.other": "{{count}} messages hidden by your words below.",
  "community.channels.archivedEntry.one": "{{name}} — {{count}} message",
  "community.channels.archivedEntry.other": "{{name}} — {{count}} messages",

  // ─── The Skills app (`pages/skills.tsx`, logic in `apps/skills.ts`) ───────────────────────────
  // ⚠️ The wording here IS the safety surface, so read the rules before editing a line:
  //   · "Where it came from" is the only section stating something NovaClaw looked at. Every other
  //     section is the skill describing itself, and `skills.what.authorship` says so out loud.
  //   · `skills.capabilities.undeclared` and `skills.compatibility.undeclared` say the FORMAT has no
  //     such field. They must never shorten to "none declared", which a reader hears as "harmless".
  //   · `skills.mentions.*` describes a word search. It must never be phrased as a finding about
  //     what the skill does — in either direction, which is why the empty case says so too.
  "skills.title": "Skills",
  "skills.tagline": "Instructions someone wrote for your agents. Read one before you let it be followed.",
  "skills.action.refresh": "Refresh",
  "skills.search.placeholder": "Search skills",
  "skills.empty.none": "No skills yet. NovaClaw looks for them in the places listed below.",
  "skills.empty.filtered": "No skill matches that search.",
  "skills.loading": "Loading…",
  // An unavailable subsystem names itself instead of rendering empty — and it says which of the two
  // it is, because "no skills" and "could not ask" send a person to entirely different remedies.
  "skills.loadFailed":
    "Could not read the skill list. Your skills are still installed — this page could not reach them.",
  "skills.intro.pick": "Pick a skill on the left to see who wrote it and what it tells your agent to do.",
  "skills.badge.slash": "Slash command",

  "skills.what.title": "What this changes",
  "skills.what.mechanism":
    "A skill is a page of instructions someone wrote. Your agent is shown every skill's name and one-line summary while it works; when it decides one fits the job, it reads the whole page and follows it.",
  "skills.what.powers":
    "Following a skill does not hand your agent new powers — but it changes what your agent decides to do with the powers it already has, and the instructions may tell it to run programs, change your files, or go online. A skill's folder can also hold scripts it may run.",
  "skills.what.authorship":
    "Everything on this page except “Where it came from” was written by whoever made the skill. NovaClaw has not checked any of it, and a skill can claim anything about itself.",

  "skills.origin.title": "Where it came from",
  "skills.origin.downloaded.badge": "Downloaded",
  "skills.origin.downloaded.text":
    "NovaClaw downloaded this skill from the web and keeps its copy in the download folder. Someone outside this computer wrote it.",
  "skills.origin.downloaded.candidates": "It came from one of the web addresses on your list:",
  "skills.origin.downloaded.noCandidates":
    "No web address is on your list any more, so this is a leftover copy from a source you have since removed.",
  "skills.origin.instance.badge": "NovaClaw's folder",
  "skills.origin.instance.text":
    "This skill sits in NovaClaw's own skills folder on this computer. Anything placed in that folder is picked up, so being here is not a sign that you wrote it.",
  "skills.origin.configured.badge": "Added folder",
  "skills.origin.configured.text": "This skill sits in a folder you added to the places NovaClaw looks.",
  "skills.origin.configured.source": "The folder you added: {{source}}",
  "skills.origin.local.badge": "On this computer",
  "skills.origin.local.text":
    "This skill sits in a folder on this computer that is not on your list — usually a skills folder inside the project you have open.",
  "skills.origin.folder": "Its folder",
  "skills.origin.folderNote": "Open this folder to read the file yourself and see anything shipped beside it.",

  "skills.description.title": "What it says about itself",
  "skills.description.none":
    "This skill does not describe itself. Your agent is given only its name, so it has to guess from that when to use it.",
  "skills.description.none.short": "No description",
  "skills.description.note": "The author wrote this line, and NovaClaw shows it to your agents on every message.",

  "skills.capabilities.title": "What it is allowed to do",
  "skills.capabilities.undeclared":
    "Skills have no way to declare what they can do, so there is no list here to check and nothing to hold the author to. The instructions below are the only description of this skill's behaviour, which is why they are shown in full.",

  "skills.mentions.title": "Words found in the instructions",
  "skills.mentions.none":
    "None of the words we look for appear. That is not a sign the skill is limited — it can do any of these things without naming them.",
  "skills.mentions.caveat":
    "This is a plain search for a fixed list of words in the text below. It is not a check of what the skill does: a skill can do any of these without mentioning them, and mentioning one is not proof that it does it.",
  "skills.mentions.topic.run": "Running programs",
  "skills.mentions.topic.modify": "Changing or deleting things",
  "skills.mentions.topic.install": "Installing software",
  "skills.mentions.topic.network": "Going online",
  "skills.mentions.topic.secrets": "Passwords and keys",

  "skills.compatibility.title": "Does it fit this NovaClaw?",
  "skills.compatibility.undeclared":
    "Unknown. Skills carry no version and no list of what they need, so there is nothing to check in advance. If a skill does not fit, you find out when your agent tries to follow it.",

  "skills.enablement.title": "Who can use it",
  "skills.enablement.open": "All {{allow}} of your agents can open this skill without asking you first.",
  // ⚠️ `asks` and `mixed` name all three counts on purpose. Measured live 2026-08-18: a stock
  // instance has 4 visible agents, three at "ask" and `explore` carrying a catch-all deny — so the
  // shorter wording ("the rest may open it") was reporting an ask as an open door on the very first
  // instance anyone will look at.
  "skills.enablement.asks":
    "No agent of yours refuses this skill. {{ask}} will ask you before opening it; {{allow}} can open it without asking.",
  "skills.enablement.mixed":
    "Your agents disagree: {{deny}} refuse this skill, {{ask}} would ask you first, {{allow}} can open it without asking.",
  "skills.enablement.blocked":
    "Every one of your agents refuses this skill. It is loaded, but none of them will open it.",
  "skills.enablement.unknown": "NovaClaw could not read your agent list, so it cannot say who may open this skill.",
  // ⚠️ **This sentence describes the switches below it and must change WITH them** (AGENTS.md
  // principle 12). It has been wrong once already, telling readers there was no per-skill switch
  // while one sat underneath it — a fixed control under a sentence describing the old one leaves
  // the reader following an instruction the product no longer needs.
  "skills.enablement.noSwitch":
    "This is the whole permission picture. The switch below changes one part of it — whether your agents are offered this skill at all. Removing the skill entirely is still a matter of taking its folder off the list of places NovaClaw looks.",

  "skills.invocation.title": "How it gets used",
  // AGENTS.md principle 12(d): say what is in force RIGHT NOW, before any control.
  "skills.invocation.inForce.everywhere":
    "Right now: Nova may pick this skill by itself, and it is in your slash menu for you to run.",
  "skills.invocation.inForce.onlyWhenIChoose":
    "Right now: only when you choose it. Nova will never pick this skill by itself; it stays in your slash menu for you.",
  "skills.invocation.inForce.onlyNova":
    "Right now: Nova may pick this skill by itself, and it is kept out of your slash menu.",
  "skills.invocation.inForce.nowhere":
    "Right now: neither. Nova will not pick it and it is not in your slash menu. It stays installed, and you can still read it here.",
  "skills.invocation.independent":
    "Two separate switches, not one setting with three positions. Keep a skill for yourself, keep it for Nova, or keep it for both — whichever you leave alone stays where it is.",
  "skills.invocation.nova.label": "Nova may choose this",
  "skills.invocation.nova.help":
    "On, your agents are told this skill exists and may open it when a task matches. Off writes one permission rule: the skill is no longer mentioned to them at all, and it is refused if an agent names it anyway.",
  "skills.invocation.me.label": "Show it for me to run",
  "skills.invocation.me.help":
    "On, it appears in the slash menu in the message box. Off, it does not. This is your own menu rather than a lock — if you type its exact name it still runs.",
  "skills.invocation.preset.onlyWhenIChoose": "Only when I choose it",
  "skills.invocation.preset.help":
    "A shortcut that sets both switches at once: “Nova may choose this” off, “Show it for me to run” on.",
  "skills.invocation.preset.applied": "Both switches are already set that way.",
  // The THIRD layer, and the three sentences below are deliberately different from one another:
  // "this folder hides it" is fixed by editing a file in the repository, "you hid it" is fixed by
  // the switch on this screen, and "your agents may not choose it" is a permission rule. A user who
  // cannot tell which one is in force cannot fix any of them (AGENTS.md principle 12d).
  // ⚠️ These two sentences describe the control below them and must change WITH it (principle 12).
  // The visible half is the FACT plus the one control that answers it; the law about what a folder
  // may and may not do is on demand. Named and unnamed keep their own line because "which file" is
  // the actionable part — the fix is editing that file.
  "skills.invocation.project.hidden":
    "This folder keeps this skill out of your slash menu — the folder switch below can bring it back.",
  "skills.invocation.project.hiddenNamed":
    "{{file}} keeps this skill out of your slash menu — the folder switch below can bring it back.",
  "skills.invocation.project.detail":
    "That comes from the folder's own novaclaw.json rather than from you, so the “Show it for me to run” switch cannot bring it back. Nothing here changes what your agents may do: a folder can take a skill off your menu, and it can never put one back on it.",
  // ── The folder control. `apps/project-skills.ts` owns the law these sentences describe. ──
  "skills.invocation.project.hide.label": "Hide it in this folder",
  "skills.invocation.project.hide.help":
    "Saves “show: false” for this skill into this folder's novaclaw.json, so it stays out of your slash menu while you are working here. It travels with the folder: anyone who clones the repository gets the same menu.",
  "skills.invocation.project.hide.law":
    "One direction only. A folder can take a skill off your menu and can never put one back on it, so turning this off simply removes the folder's line — your own switch above decides again. Nothing a folder writes changes what your agents may choose.",
  "skills.invocation.project.hide.refused":
    "Your file also asked to SHOW: {{ids}}. Those lines were removed rather than kept, because a folder may only ever hide — NovaClaw was already ignoring them.",
  "skills.invocation.project.hide.error":
    "That did not save. This folder's novaclaw.json is unchanged; the switch above shows what is really in the file.",
  "skills.invocation.project.write.creates": "There is no novaclaw.json here yet. Saving creates one in this folder.",
  "skills.invocation.project.write.updates": "Saving edits {{file}}.",
  "skills.invocation.project.write.shadowed":
    "This folder is governed by {{file}}, which sits above it. Writing a novaclaw.json here would take that whole file out of force — its permission rules, its Tune and its excluded-path list — so this switch is not offered here.",
  "skills.invocation.project.write.invalid":
    "This folder's novaclaw.json ({{file}}) cannot be read, so nothing can be saved into it. Settings → Project says what is wrong with it.",
  "skills.invocation.project.write.unknown": "NovaClaw has not been told which folder this is yet.",
  "skills.invocation.project.write.withheld":
    "Edit the file named above, or use Settings → Project, which is the screen whose subject is that file.",
  "skills.invocation.project.overrides":
    "Your own answer is “show it”, and it still is — this folder is overriding it while you work here.",
  "skills.invocation.blockedElsewhere":
    "Careful: another permission rule of yours already refuses this skill, so leaving this switch on changes nothing until that rule does. “Who can use it” above shows what your agents actually do.",
  "skills.invocation.locked.title": "These switches are unavailable for this skill",
  "skills.invocation.locked.empty":
    "This skill's name is empty once the invisible characters are removed, so there is no name to save a choice against. Ask whoever wrote it for a real name.",
  "skills.invocation.locked.tooLong":
    "This skill's name is too long to save a choice against ({{max}} characters at most). Shortening it in the skill's own file makes these switches work.",
  "skills.invocation.locked.invisible":
    "This skill's name contains characters you cannot see — the kind that make a name read as something other than what it is. NovaClaw will not save a setting against a name it cannot show you truthfully.",
  "skills.invocation.locked.wildcard":
    "This skill's name contains * or ?, which are the “match anything” characters in a permission rule. A rule written for this name would also cover other skills, so NovaClaw refuses to write one.",
  "skills.invocation.locked.unnormalized":
    "This skill's name is spelled with combining accents rather than the ordinary single letters, so two names that look identical would be saved as two different ones. NovaClaw refuses rather than guess which you meant.",
  // Split under uix.md §1.4 (*teach on demand, state on sight*): the line is what is in force, the
  // caveat is one tap away.
  "skills.invocation.unknowns": "These switches decide when the skill is offered — not whether it is safe.",
  "skills.invocation.unknowns.detail":
    "NovaClaw cannot tell you what a skill is allowed to do, whether it fits this version, or who really wrote it: the skill format has nowhere to say any of it. What is above — where the file came from, what it says about itself, and the words in its instructions — is everything NovaClaw actually knows.",
  "skills.invocation.orphans.title": "Saved choices for skills that are not here",
  "skills.invocation.orphans.text":
    "You decided something about these, and NovaClaw no longer finds a skill by that name. They are kept in case the skill comes back — a source can be offline, or a folder temporarily moved.",
  "skills.invocation.orphans.forget": "Forget",
  "skills.invocation.error":
    "That change could not be saved. Nothing was altered — your agents and your menu are as they were.",

  "skills.instructions.title": "The instructions themselves",
  "skills.instructions.note": "This is the text your agent is given, word for word, when it opens this skill.",
  "skills.instructions.empty": "(this skill's instructions are empty)",

  // Shown only when the user HAS extra sources, folded behind a summary (owner, 2026-08-20). There
  // is deliberately NO empty state: a person who has added nothing does not need to be told so on
  // every visit.
  "skills.sources.title": "Extra sources",
  "skills.sources.note":
    "This list decides which skills exist at all; each skill's own switches decide when it is offered.",

  // The composer, when a read it depends on did not answer. Each of these replaces a sentence that
  // would otherwise be false: an empty message box that looks like "you had no draft", and a
  // messenger section that says "you have no accounts" over a request that never landed.
  "prompt.draft.unavailable":
    "Your saved draft for this chat could not be read, so the box starts empty. Anything you type here is still saved as usual.",
  "prompt.remote.unavailable":
    "NovaClaw could not reach the messenger service, so it cannot say which chat drives this one. Nothing has changed — try again in a moment.",
  "prompt.remote.checking": "Checking your messenger accounts…",

  // ── Debug page — keyed 2026-09-03; these strings shipped as literals until then. ──
  "debug.page.filterText": "filter text…",
  "debug.page.filterTheErrorLogByText": "Filter the error log by text",
  "debug.page.filterTheInstanceLogBySubsystem": "Filter the instance log by subsystem",
  "debug.page.textInTheLinePressEnter": "text in the line… (press Enter)",
  "debug.page.filterTheInstanceLogByText": "Filter the instance log by text",
  "debug.page.sseStreamStatusPerConfiguredServer": "SSE stream status per configured server",
  "debug.page.optionalCapabilities": "Optional capabilities",
  "debug.page.tryAgain": "Try again",
  "debug.page.technicalDetail": "Technical detail",
  "debug.page.contextFindings": "Context findings",
  "debug.page.noDuplicateOrDominantToolOutput": "No duplicate or dominant tool output found.",
  "debug.page.errorLog": "Error log",
  "debug.page.instanceLog": "Instance log",
  "debug.page.fullDetail": "Full detail",
  "debug.page.readyToSendOnward": "Ready to send onward",
  "debug.page.configSnapshot": "Config snapshot",
  "debug.page.connection": "Connection",
  "debug.page.refresh": "Refresh",
  "debug.page.scheduler": "Scheduler",
  "debug.page.copy": "Copy",
  "debug.page.clear": "Clear",
  "debug.page.sessions": "Sessions",
  "debug.page.retry": "Retry",
  "debug.page.stop": "Stop",
  "debug.page.models": "Models",

  // ── Recipes page — keyed 2026-09-03; these strings shipped as literals until then. ──
  "recipes.page.searchRecipes": "Search recipes",
  "recipes.page.recipeName": "Recipe name",
  "recipes.page.cookUnderTheStrictHarnessThe":
    "Cook under the Strict harness: the run is decomposed into small steps, each verified before the next. Slower, and it can race several attempts.",
  "recipes.page.deleteRecipe": "Delete recipe",
  "recipes.page.reportMdChartHtml": "report.md, chart.html",
  "recipes.page.oneLineDescriptionOptional": "One-line description (optional)",
  "recipes.page.thePromptThisIsTheRecipe":
    "The prompt. This IS the recipe — describe what you want cooked, precisely enough that an agent can do it without you.",
  "recipes.page.newRecipe": "New recipe",
  "recipes.page.pickARecipeOnTheLeft": "Pick a recipe on the left, make a new one, or import one somebody sent you.",
  "recipes.page.whatRunningThisActuallyDoes": "What running this actually does",
  "recipes.page.beforeYouRun": "Before you run",
  "recipes.page.whatAFinishedRunShouldLeave": "What a finished run should leave behind",
  "recipes.page.saveFileNames": "Save file names",
  "recipes.page.didItWork": "Did it work?",
  "recipes.page.theRecipe": "The recipe",
  "recipes.page.unsavedChanges": "Unsaved changes",
  "recipes.page.filesThatTravelWithIt": "Files that travel with it",
  "recipes.page.importARecipe": "Import a recipe",
  "recipes.page.completeRecipeFolder": "Complete recipe folder",
  "recipes.page.importFolder": "Import folder",
  "recipes.page.pasteRecipeMdOnly": "Paste recipe.md only",
  "recipes.page.whatThisFileSays": "What this file says",
  "recipes.page.importPastedMarkdownNoAssets": "Import pasted markdown (no assets)",
  "recipes.page.import": "Import…",
  "recipes.page.couldNotReadYourRecipesYour":
    "Could not read your recipes. Your shelf is intact — this page could not reach it.",
  "recipes.page.loadingYourRecipes": "Loading your recipes…",
  "recipes.page.run": "Run",
  "recipes.page.runIn": "Run in…",
  "recipes.page.copy": "Copy",
  "recipes.page.export": "Export",
  "recipes.page.justFileNamesSeparatedByCommas":
    "Just file names, separated by commas — no commands. Saving this changes one line of the recipe and nothing else in the file.",
  "recipes.page.checkAFolder": "Check a folder…",
  "recipes.page.thisOneShippedWithNovaclawEdit":
    "This one shipped with NovaClaw. Edit it freely — your version is kept on upgrade, and deleting it brings the original back on next start.",
  "recipes.page.theTextBelowIsWhoeverWrote":
    "The text below is whoever wrote this recipe speaking, not NovaClaw. If somebody sent it to you, read it before you run it.",
  "recipes.page.carefulThisRecipeSOwnText":
    "Careful: this recipe's own text contains invisible characters — the kind that can make a name or a filename read differently than it really is. The boxes below show it exactly as it is stored, so what you see here may not match what you saw in the list.",
  "recipes.page.copiedIntoTheWorkFolderAlongside":
    "Copied into the work folder alongside the prompt when you run it. Export includes this complete nested asset tree in the recipe ZIP.",
  "recipes.page.aRecipeIsAFolderChoose":
    "A recipe is a folder. Choose its ZIP to bring across recipe.md and every nested file, including binary assets, exactly as they were sent.",
  "recipes.page.useThisForAProseOnly":
    "Use this for a prose-only recipe copied from a message. Paste carries recipe.md only — no assets can travel with it.",
  "recipes.page.somebodyElseWroteThisNothingIn":
    "Somebody else wrote this. Nothing in the file can grant it any permission — the prompt below is all it is. Read it before you run it.",
  "recipes.page.cancel": "Cancel",
  "recipes.page.importingNeverReplacesARecipeYou":
    "Importing never replaces a recipe you already have — a name that is taken gets the next free one.",

  // ── Calendar page — keyed 2026-09-03; these strings shipped as literals until then. ──
  "calendar.page.editTask": "Edit task",
  "calendar.page.deleteTask": "Delete task",
  "calendar.page.titleEGNewYearGreeting": "Title (e.g. New Year greeting)",
  "calendar.page.promptTheAgentRunsEG":
    "Prompt the agent runs — e.g. Congratulate our clients with the New Year and unobtrusively promote our product.",
  "calendar.page.runOnceAt": "Run once at",
  "calendar.page.runAt": "Run at",
  "calendar.page.dayOfMonth": "Day of month",
  "calendar.page.overrideTheModelForThisOne":
    "Override the model for this one task — blank = whatever the colleague thinks with",
  "calendar.page.overrideTheFolderForThisOne":
    "Override the folder for this one task — blank = wherever the responsible colleague works",
  "calendar.page.nextRun": "Next run",
  "calendar.page.noUpcomingRunsScheduled": "No upcoming runs scheduled.",
  "calendar.page.scheduledTasks": "Scheduled tasks",
  "calendar.page.couldNotReadTheRecentRun": "Could not read the recent-run history.",
  "calendar.page.recentRuns": "Recent runs",
  "calendar.page.timesAreInYourLocalTimezone": "Times are in your local timezone.",
  "calendar.page.now": "Now",
  "calendar.page.loadingYourScheduledTasks": "Loading your scheduled tasks…",
  "calendar.page.couldNotReadYourScheduledTasks":
    "Could not read your scheduled tasks. They are still on the instance and still running — only this list failed to arrive, so there is nothing here to add again.",
  "calendar.page.noTasksYetAddOneBelow": "No tasks yet — add one below.",
  "calendar.page.edit": "Edit",
  "calendar.page.cancel": "Cancel",
  "calendar.page.repeat": "Repeat",
  "calendar.page.responsible": "Responsible",
  "calendar.page.model": "Model",
  "calendar.page.folder": "Folder",
  "calendar.page.browse": "Browse…",
  "calendar.page.permissions": "Permissions",
  "calendar.page.runsUnattendedAskStallsWithNo": "Runs unattended — “Ask” stalls with no one to approve.",

  // ── Memory graph page — keyed 2026-09-03; these strings shipped as literals until then. ──
  "memoryGraph.page.searchMemories": "Search memories",
  "memoryGraph.page.showEverythingAgain": "Show everything again",
  "memoryGraph.page.resetView": "Reset view",
  "memoryGraph.page.connectedTo": "Connected to",
  "memoryGraph.page.itsOwn": "Its own",
  "memoryGraph.page.oneChat": "One chat",
  "memoryGraph.page.memoryIsUnavailableRightNow": "Memory is unavailable right now.",
  "memoryGraph.page.recordedBy": "Recorded by",
  "memoryGraph.page.noRecallHasEverReturnedThis": "No recall has ever returned this one.",
  "memoryGraph.page.noLinks": "No links.",
  "memoryGraph.page.home": "Home",
  "memoryGraph.page.memory": "Memory",
  "memoryGraph.page.whose": "Whose",
  "memoryGraph.page.shared": "Shared",
  "memoryGraph.page.loadingTheMemoryGraph": "Loading the memory graph…",
  "memoryGraph.page.retry": "Retry",
  "memoryGraph.page.nothingRememberedYetTheGraphFills": "Nothing remembered yet — the graph fills as you chat.",
  "memoryGraph.page.group": "Group",
  "memoryGraph.page.noIdentityNothingCanCorrectThis": "No identity — nothing can correct this later, only forget it.",
  "memoryGraph.page.identity": "Identity:",
  "memoryGraph.page.timeline": "Timeline",
  "memoryGraph.page.askingTheLedger": "Asking the ledger…",
  "memoryGraph.page.thisInstanceCouldNotAnswerIt":
    "This instance could not answer — it may not be recording which memories get recalled.",
  "memoryGraph.page.replacedByANewerAnswerRecord": "Replaced by a newer answer — record a new claim to change it back.",
  "memoryGraph.page.links": "Links",
}
