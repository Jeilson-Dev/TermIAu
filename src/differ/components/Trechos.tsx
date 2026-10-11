import type { Trecho } from "../../i18n/differ";

/** A dictionary text with code in it: each `{ codigo }` becomes a `<code>`. */
export function Trechos({ de }: { de: Trecho[] }) {
  return (
    <>
      {de.map((t, i) =>
        typeof t === "string" ? (
          t
        ) : (
          <code key={i} className={t.branch ? "branch-name" : undefined}>
            {t.codigo}
          </code>
        ),
      )}
    </>
  );
}
