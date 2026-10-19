/// What versions from before the English rename saved — the session file,
/// localStorage, the differ's settings — has Portuguese keys and values. It is
/// read through here into today's names; the next save already writes those.

/// Old key → new key, anywhere in the tree; and, per (new) key, old value → new value.
export type LegacyNames = { keys: Record<string, string>; values?: Record<string, Record<string, string>> };

export function fromLegacy(value: unknown, names: LegacyNames): unknown {
  if (Array.isArray(value)) return value.map((v) => fromLegacy(v, names));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const key = names.keys[k] ?? k;
    // A key already in today's name wins over its old twin.
    if (key !== k && key in value) continue;
    const renamed = typeof v === "string" ? (names.values?.[key]?.[v] ?? v) : fromLegacy(v, names);
    out[key] = renamed;
  }
  return out;
}

export const LEGACY_SESSION: LegacyNames = {
  keys: {
    versao: "version",
    abas: "tabs",
    ativa: "active",
    fechadas: "closed",
    raiz: "root",
    foco: "focus",
    tipo: "kind",
    eixo: "axis",
    fracao: "fraction",
    filhos: "children",
    aba: "tab",
    painel: "panel",
  },
  values: {
    kind: { folha: "leaf", divisao: "split" },
    axis: { lado: "side", abaixo: "below" },
  },
};

export const LEGACY_VIEWER_PREF: LegacyNames = {
  keys: { arranjo: "layout", fatia: "share" },
  values: { layout: { lado: "side", abaixo: "below", sobre: "over" } },
};

export const LEGACY_USAGE: LegacyNames = {
  keys: { sessao: "session", semana: "week", uso: "usage", renova: "renews" },
};

export const LEGACY_SETTINGS: LegacyNames = {
  keys: { contextoAtencao: "contextAttention", contextoPerigo: "contextDanger", autoCompactEm: "autoCompactAt" },
};
