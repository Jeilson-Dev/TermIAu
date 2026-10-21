/// The part that runs inside the diff tab (see the differ's lib/extensions.ts): the
/// tool that opens a question on a passage, and the question boxes under the lines.
import type { DifferExtension } from "../../../src/differ/lib/extensions";
import { AskBox } from "./AskBox";
import * as asks from "./asks";
import css from "./differ.css?inline";
import { T } from "./i18n";

export function activate(): DifferExtension {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.append(style);
  return {
    tools: [
      {
        id: "claude-ask",
        icon: "sparkle",
        label: T.ask,
        titles: { bookmark: T.askAboutSnippet, note: T.askBeforeHint, selection: T.askSelection },
        run: (passage, text) => asks.open(passage, text),
      },
    ],
    boxes: {
      of: asks.boxesOf,
      subscribe: asks.subscribe,
      render(box, ctx) {
        const ask = asks.get(box.key);
        if (!ask) return null;
        // The decision becomes the bookmark — or rewrites the one the question came from.
        const decide = async (note: string) => {
          await ctx.bookmark(note);
          asks.close(ask.id);
        };
        return <AskBox root={ctx.root} file={ctx.file} ask={ask} onDecide={decide} />;
      },
    },
    dispose() {
      asks.closeAll();
      style.remove();
    },
  };
}
