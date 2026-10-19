import type { Snippet } from "../../i18n/differ";

/** A dictionary text with code in it: each `{ code }` becomes a `<code>`. */
export function Snippets({ from }: { from: Snippet[] }) {
  return (
    <>
      {from.map((t, i) =>
        typeof t === "string" ? (
          t
        ) : (
          <code key={i} className={t.branch ? "branch-name" : undefined}>
            {t.code}
          </code>
        ),
      )}
    </>
  );
}
