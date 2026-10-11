import type { Trecho } from "../../i18n/differ";

/** Um texto do dicionário com código no meio: cada `{ codigo }` vira um `<code>`. */
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
