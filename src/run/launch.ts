// O .vscode/launch.json, e o tasks.json que ele cita, lidos sem o VS Code.

import { palavra } from "./shell";

/** Uma entrada de `configurations`. Além destes campos, cada `type` tem os seus. */
export interface ConfigLaunch {
  name: string;
  type: string;
  request?: string;
  [campo: string]: unknown;
}

/** Uma entrada de `tasks` no tasks.json, só com o que o play sabe rodar. */
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

/** O que as variáveis `${...}` precisam saber. */
export interface Contexto {
  /** A pasta que tem o `.vscode`: o `${workspaceFolder}`. */
  pasta: string;
  home: string;
}

const ehObjeto = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Índice das aspas que fecham a string aberta em `inicio`. */
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
      i = fim < 0 ? texto.length : fim - 1; // a quebra de linha fica
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

/** JSON com comentários e vírgula sobrando: o formato que o VS Code aceita nesses arquivos. */
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

/** O que o play oferece: as configurações que ele roda e a lista com os títulos de grupo. */
export interface ListaDoPlay {
  configs: ConfigLaunch[];
  /** Na ordem do launch.json; uma string é o título do grupo que vem embaixo. */
  menu: (ConfigLaunch | string)[];
}

/**
 * O launch.json como o play o mostra. Fica de fora a configuração com `codeLens`,
 * que a extensão do Dart só usa nos links "Run | Debug" em cima dos testes — no
 * play ela rodaria o app com `--update-goldens`. E o separador, como um
 * `──── DEV ────` apontando para um arquivo que não existe, o truque para agrupar
 * a lista do VS Code, vira título de grupo em vez de algo que o play rodaria.
 */
export function listaDoPlay(configs: ConfigLaunch[]): ListaDoPlay {
  const menu: (ConfigLaunch | string)[] = [];
  // Um grupo sem nada embaixo (só tinha configurações de CodeLens) não aparece.
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

/** "──── DEV ────" -> "DEV". Nulo quando o nome não tem traços nas duas pontas. */
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
 * Troca as variáveis do VS Code. `${env:X}` passa intacta: quem a expande é o shell
 * (ver `palavra`). As que dependem do editor (`${file}`, `${input:...}`) não têm
 * resposta aqui e param a execução com o nome delas.
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
    throw new Error(`a variável ${todo} ainda não é suportada`);
  });
}

/**
 * O `preLaunchTask` da configuração, como linha de shell que vem antes do app
 * (`tarefa && app`). Nulo quando não há. Tarefas que o play ainda não sabe rodar
 * param a execução dizendo por quê, em vez de rodar o app sem ela.
 */
export function tarefaAntes(cfg: ConfigLaunch, tarefas: Tarefa[], ctx: Contexto): string | null {
  const nome = cfg.preLaunchTask;
  if (typeof nome !== "string" || !nome) return null;
  const tarefa =
    tarefas.find((t) => t.label === nome) ??
    // Tarefas do npm detectadas pelo VS Code se chamam "npm: <script>".
    tarefas.find((t) => t.type === "npm" && `npm: ${t.script}` === nome);
  if (!tarefa) throw new Error(`a tarefa "${nome}" não está no tasks.json`);
  if (tarefa.dependsOn) throw new Error(`a tarefa "${nome}" usa dependsOn, que ainda não é suportado`);
  if (tarefa.isBackground) {
    throw new Error(`a tarefa "${nome}" roda em segundo plano, o que ainda não é suportado`);
  }

  const r = (v: string) => resolver(v, ctx);
  const args = (tarefa.args ?? []).filter((a): a is string => typeof a === "string").map((a) => palavra(r(a)));
  let comando: string;
  if (tarefa.type === "npm" && tarefa.script) {
    comando = ["npm", "run", palavra(tarefa.script), ...args].join(" ");
  } else if (tarefa.type === "shell" && tarefa.command) {
    // O `command` de uma tarefa shell já é linha de shell: vai como está.
    comando = [r(tarefa.command).replace(/\$\{env:(\w+)\}/g, "${$1}"), ...args].join(" ");
  } else if (tarefa.type === "process" && tarefa.command) {
    comando = [palavra(r(tarefa.command)), ...args].join(" ");
  } else {
    throw new Error(`a tarefa "${nome}" é do tipo "${tarefa.type}", que ainda não é suportado`);
  }
  const cwd = tarefa.options?.cwd;
  return cwd ? `(cd ${palavra(r(cwd))} && ${comando})` : comando;
}
