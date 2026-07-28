// Outbound links the UI hands a user when they need a human.
//
// The invite string lives HERE and nowhere else in the renderer. Three surfaces resolve to it — the
// crash screen, the sidebar Help button and the Community panel — so the invite can be rotated in one
// edit, and no copy of it can quietly go stale while the others still work. `links.test.ts` asserts
// the literal appears exactly once in the tree.
//
// ⚠️ Whatever these point at MUST be live. The crash screen and the Help button are the surfaces a
// user reaches when the product is *already broken* (todo.md standing decision 3: an unavailable
// subsystem names itself, and a fault is never described falsely — but on a last-resort surface even a
// named dead end is a dead end). Until 2026-07-28 all three pointed at `novaclaw.app/desktop-feedback`,
// which has 404'd since v0.1.0: the one link offered to someone whose UI had just crashed went nowhere.
// `links.test.ts` now enforces mechanically that a last-resort surface can only reach a URL declared
// live in its ledger.
export const DISCORD_INVITE_URL = "https://discord.gg/QShqKW56JM"
