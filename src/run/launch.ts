// The .vscode/launch.json, and the tasks.json it references, read without VS Code.

import { palavra } from "./shell";
import { T } from "../i18n/terminal";

/** An entry in `configurations`. Besides these fields, each `type` has its own. */
export interface ConfigLaunch {
  name: string;
  type: string;
  request?: string;
  [campo: string]: unknown;
}

/** An entry in tasks.json's `tasks`, with only what the play button can run. */
export interface Tarefa {
  label?: string;
  type?: string;
  command?: string;
  args?: unknown[];
  script?: string;
  isBackground?: boolean;
  dependsOn?: unknown;
  options?: { cwd?: string };
}

/** What the `${...}` variables need to know. */
export interface Contexto {
  /** The folder holding `.vscode`: the `${workspaceFolder}`. */
  pasta: string;
  home: string;
}

const ehObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Index of the quote that closes the string opened at `inicio`. */
function fimDaString(texto: string, inicio: number): number {
  let i = inicio + 1;
  while (i < texto.length && texto[i] !== '"') i += texto[i] === "\\" ? 2 : 1;
  return i;
}

function semComentarios(texto: string): string {
  let saida = "";
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (c === '"') {
      const fim = fimDaString(texto, i);
      saida += texto.slice(i, fim + 1);
      i = fim;
    } else if (c === "/" && texto[i + 1] === "/") {
      const fim = texto.indexOf("\n", i);
      i = fim < 0 ? texto.length : fim - 1; // the newline stays
    } else if (c === "/" && texto[i + 1] === "*") {
      const fim = texto.indexOf("*/", i + 2);
      i = fim < 0 ? texto.length : fim + 1;
    } else {
      saida += c;
    }
  }
  return saida;
}

function semVirgulasSobrando(texto: string): string {
  let saida = "";
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (c === '"') {
      const fim = fimDaString(texto, i);
      saida += texto.slice(i, fim + 1);
      i = fim;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (/\s/.test(texto[j] ?? "")) j++;
      if (texto[j] === "}" || texto[j] === "]") continue;
    }
    saida += c;
  }
  return saida;
}

/** JSON with comments and trailing commas: the format VS Code accepts in these files. */
export function lerJsonc(texto: string): unknown {
  return JSON.parse(semVirgulasSobrando(semComentarios(texto)));
}

export function configsDe(texto: string): ConfigLaunch[] {
  const json = lerJsonc(texto);
  const lista = ehObjeto(json) && Array.isArray(json.configurations) ? json.configurations : [];
  return lista.filter(
    (c): c is ConfigLaunch => ehObjeto(c) && typeof c.name === "string" && typeof c.type === "string",
  );
}

/** What the play button offers: the configurations it runs and the list with group titles. */
export interface ListaDoPlay {
  configs: ConfigLaunch[];
  /** In launch.json order; a string is the title of the group below it. */
  menu: (ConfigLaunch | string)[];
}

/**
 * launch.json as the play button shows it. Left out is the configuration with `codeLens`,
 * which the Dart extension only uses in the "Run | Debug" links above tests — in the
 * play button it would run the app with `--update-goldens`. And the separator, like a
 * `──── DEV ────` pointing to a file that doesn't exist, the trick for grouping
 * VS Code's list, becomes a group title instead of something the play button would run.
 */
export function listaDoPlay(configs: ConfigLaunch[]): ListaDoPlay {
  const menu: (ConfigLaunch | string)[] = [];
  // A group with nothing below it (it only had CodeLens configurations) doesn't show.
  const semGrupoVazio = () => {
    if (typeof menu[menu.length - 1] === "string") menu.pop();
  };
  for (const c of configs) {
    if (ehObjeto(c.codeLens)) continue;
    const grupo = tituloDeSeparador(c.name);
    if (grupo === null) {
      menu.push(c);
    } else {
      semGrupoVazio();
      menu.push(grupo);
    }
  }
  semGrupoVazio();
  return { configs: menu.filter((m): m is ConfigLaunch => typeof m !== "string"), menu };
}

/** "──── DEV ────" -> "DEV". Null when the name doesn't have dashes at both ends. */
function tituloDeSeparador(nome: string): string | null {
  if (!/^\s*[─━═—–=-]{3,}/.test(nome) || !/[─━═—–=-]{3,}\s*$/.test(nome)) return null;
  return nome.replace(/[─━═—–=<>-]{2,}/g, "").trim();
}

export function tarefasDe(texto: string): Tarefa[] {
  const json = lerJsonc(texto);
  const lista = ehObjeto(json) && Array.isArray(json.tasks) ? json.tasks : [];
  return lista.filter(ehObjeto) as Tarefa[];
}

/**
 * Replaces VS Code's variables. `${env:X}` passes intact: the shell expands it
 * (see `palavra`). Those that depend on the editor (`${file}`, `${input:...}`) have no
 * answer here and stop the run with their name.
 */
export function resolver(valor: string, ctx: Contexto): string {
  return valor.replace(/\$\{([^}]+)\}/g, (todo, nome: string) => {
    switch (nome) {
      case "workspaceFolder":
      case "workspaceRoot":
      case "cwd":
        return ctx.pasta;
      case "workspaceFolderBasename":
        return ctx.pasta.split("/").filter(Boolean).pop() ?? "";
      case "userHome":
        return ctx.home;
      case "pathSeparator":
      case "/":
        return "/";
    }
    if (nome.startsWith("env:")) return todo;
    throw new Error(T.variavelNaoSuportada(todo));
  });
}

/**
 * The configuration's `preLaunchTask`, as a shell line that comes before the app
 * (`task && app`). Null when there is none. Tasks the play button can't run yet
 * stop the run saying why, instead of running the app without it.
 */
export function tarefaAntes(cfg: ConfigLaunch, tarefas: Tarefa[], ctx: Contexto): string | null {
  const nome = cfg.preLaunchTask;
  if (typeof nome !== "string" || !nome) return null;
  const tarefa =
    tarefas.find((t) => t.label === nome) ??
    // npm tasks detected by VS Code are named "npm: <script>".
    tarefas.find((t) => t.type === "npm" && `npm: ${t.script}` === nome);
  if (!tarefa) throw new Error(T.tarefaAusente(nome));
  if (tarefa.dependsOn) throw new Error(T.tarefaDependsOn(nome));
  if (tarefa.isBackground) {
    throw new Error(T.tarefaSegundoPlano(nome));
  }

  const r = (v: string) => resolver(v, ctx);
  const args = (tarefa.args ?? []).filter((a): a is string => typeof a === "string").map((a) => palavra(r(a)));
  let comando: string;
  if (tarefa.type === "npm" && tarefa.script) {
    comando = ["npm", "run", palavra(tarefa.script), ...args].join(" ");
  } else if (tarefa.type === "shell" && tarefa.command) {
    // A shell task's `command` is already a shell line: it goes as is.
    comando = [r(tarefa.command).replace(/\$\{env:(\w+)\}/g, "${$1}"), ...args].join(" ");
  } else if (tarefa.type === "process" && tarefa.command) {
    comando = [palavra(r(tarefa.command)), ...args].join(" ");
  } else {
    throw new Error(T.tarefaTipo(nome, String(tarefa.type)));
  }
  const cwd = tarefa.options?.cwd;
  return cwd ? `(cd ${palavra(r(cwd))} && ${comando})` : comando;
}
