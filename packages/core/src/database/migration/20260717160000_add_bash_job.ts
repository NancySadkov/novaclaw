import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

// 1H durable jobs (small-tails T6): the bash_job table — persistent job status + captured
// output so a serve restart reports `interrupted` with output instead of forgetting the job.
export default {
  id: "20260717160000_add_bash_job",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`bash_job\` (
          \`id\` text PRIMARY KEY,
          \`owner\` text NOT NULL,
          \`command\` text NOT NULL,
          \`status\` text NOT NULL,
          \`exit\` integer,
          \`output\` text DEFAULT '' NOT NULL,
          \`truncated\` integer DEFAULT false NOT NULL,
          \`time_started\` integer NOT NULL,
          \`time_done\` integer
        );
      `)
      yield* tx.run(`CREATE INDEX \`bash_job_owner_idx\` ON \`bash_job\` (\`owner\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
