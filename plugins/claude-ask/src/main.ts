/// Asking Claude about a passage of the diff tab: a `claude -p` with the passage and
/// the file's diff as context, or a request sent to a session open in a panel. All of
/// it runs inside the diff tab (`differ.tsx`); the questions go through the Claude Code
/// plugin's services.
import type { PluginContext } from "../../../src/plugins/api";

export function activate(ctx: PluginContext) {
  ctx.differ.extend("differ.js");
}
