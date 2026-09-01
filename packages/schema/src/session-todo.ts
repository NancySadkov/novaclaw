export * as SessionTodo from "./session-todo"

import { Schema } from "effect"
import { define, inventory } from "./event"
import { SessionID } from "./session-id"

// 🔴 `status` and `priority` are OPEN strings on purpose, and these descriptions ship — they
// reach the OpenAPI reference, the SDK's doc comments and the `todowrite` tool schema the model
// reads. They used to read "Current status of the task: pending, in_progress, completed, cancelled"
// as if that were the whole set, which invites a client to write an exhaustive `switch` the server
// then falls out of. It is not the whole set: `Schema.String` accepts anything, and
// `test/contract-hygiene.test.ts` pins that ("waiting"/"urgent" decode unchanged).
//
// Keeping it open is the harness thesis, not laxity: `todowrite` takes this same struct as its
// INPUT, so a small model that answers "doing" instead of "in_progress" must not have its whole
// tool call rejected over a synonym. Consumers order by the canonical values and degrade for the
// rest (`session/runner/todo-reminder.ts`'s `STATUS_ORDER`), which is the shape to copy.
// If this ever becomes closed, it becomes `Schema.Literals([...])` and the hygiene test changes
// with it — never a description that claims a constraint the type does not carry.
//
// ⚠️ **Kept SHORT deliberately, and there is a ratchet behind it.** These two strings are resident
// in every full agent's `todowrite` schema, so they are paid on every turn of every working session
// — twice each, because the struct appears twice in the tool's shape. The first version of this
// correction spelled the openness out in prose and cost **400 bytes**, which put
// `location-layer.test.ts`'s resident-tool budget over its ceiling (34,948 against 34,700). The
// meaning survives the trim intact: *any string*, and the canonical set by name. **Say it in the
// fewest bytes that still say it** — that budget's own rule is to trim before asking to raise it.
export const Info = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.String.annotate({
    description: "Task status; any string. Canonical: pending, in_progress, completed, cancelled.",
  }),
  priority: Schema.String.annotate({
    description: "Task priority; any string. Canonical: high, medium, low.",
  }),
}).annotate({ identifier: "Todo" })
export interface Info extends Schema.Schema.Type<typeof Info> {}

const Updated = define({
  type: "todo.updated",
  schema: {
    sessionID: SessionID,
    todos: Schema.Array(Info),
  },
})
export const Event = { Updated, Definitions: inventory(Updated) }
