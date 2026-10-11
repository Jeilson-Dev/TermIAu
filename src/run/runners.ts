// O que o play sabe rodar, um módulo por `type` do launch.json. Cada um traduz a
// configuração num comando de terminal e diz o que dá para fazer com o app no ar
// (o hot reload do Flutter, por exemplo). Suportar uma linguagem nova é somar um
// módulo aqui: a barra e a execução não mudam.

import { resolver, type ConfigLaunch, type Contexto } from "./launch";
import { palavra } from "./shell";
import { T } from "../i18n/terminal";

/** Um botão da barra enquanto o app roda: uma tecla mandada ao programa. */
export interface Acao {
  rotulo: string;
  icone: string;
  tecla: string;
}

/** O comando pronto para o painel. */
export interface Plano {
  /** O que roda, para mensagens: "Flutter", "Node"... */
  rotulo: string;
  cwd: string;
  env: Record<string, string>;
  argv: string[];
  acoes?: Acao[];
  /** Tecla que encerra com calma (o `q` do flutter run). Sem ela, o stop manda Ctrl+C. */
  sair?: string;
}

export interface ContextoRunner extends Contexto {
  /** Se o projeto Dart nesta pasta é Flutter (o pubspec depende do SDK). */
  ehFlutter(pasta: string): Promise<boolean>;
}

export interface Runner {
  /** Os valores de `type` que este módulo atende. */
  tipos: string[];
  /** Lança Error com o motivo quando a configuração pede algo que ele não sabe fazer. */
  montar(cfg: ConfigLaunch, ctx: ContextoRunner): Promise<Plano>;
}

const texto = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const lista = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** O que toda configuração tem igual: cwd, env e só `request: "launch"`. */
function base(cfg: ConfigLaunch, ctx: Contexto) {
  if ((cfg.request ?? "launch") !== "launch") {
    throw new Error(T.requestNaoSuportado(String(cfg.request)));
  }
  const r = (v: string) => resolver(v, ctx);
  const dir = r(texto(cfg.cwd) ?? ctx.pasta);
  const cwd = dir.startsWith("/") ? dir : `${ctx.pasta}/${dir}`;
  const env: Record<string, string> = {};
  if (typeof cfg.env === "object" && cfg.env !== null) {
    for (const [k, v] of Object.entries(cfg.env)) {
      // `"RELEASE_MODE": false` também vale: a extensão do Dart aceita e vira texto.
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") env[k] = r(String(v));
    }
  }
  return { r, cwd, env };
}

const dart: Runner = {
  tipos: ["dart"],
  async montar(cfg, ctx) {
    const { r, cwd, env } = base(cfg, ctx);
    const program = texto(cfg.program) && r(texto(cfg.program)!);
    const args = lista(cfg.args).map(r);
    const toolArgs = lista(cfg.toolArgs).map(r);
    const flutter =
      texto(cfg.flutterMode) !== undefined || texto(cfg.deviceId) !== undefined || (await ctx.ehFlutter(cwd));

    if (!flutter) {
      return { rotulo: "Dart", cwd, env, argv: ["dart", "run", ...toolArgs, ...(program ? [program] : []), ...args] };
    }

    const argv = ["flutter", "run"];
    const device = texto(cfg.deviceId);
    if (device) argv.push("-d", r(device));
    const modo = texto(cfg.flutterMode);
    if (modo && modo !== "debug") argv.push(`--${modo}`);
    argv.push(...toolArgs);
    if (program) argv.push("-t", program);
    // Num app Flutter, a extensão do Dart manda os `args` ao próprio flutter run:
    // é onde os launch.json põem `--dart-define=ENV=dev` e `--flavor`. Virar
    // argumento do app faria ele rodar no ambiente padrão, sem aviso.
    argv.push(...args);
    return {
      rotulo: "Flutter",
      cwd,
      env,
      argv,
      sair: "q",
      acoes: [
        { rotulo: "Hot reload", icone: "⚡", tecla: "r" },
        { rotulo: "Hot restart", icone: "↻", tecla: "R" },
      ],
    };
  },
};

const node: Runner = {
  tipos: ["node", "pwa-node"],
  async montar(cfg, ctx) {
    const { r, cwd, env } = base(cfg, ctx);
    const exe = texto(cfg.runtimeExecutable);
    const program = texto(cfg.program);
    if (!exe && !program) throw new Error(T.faltaProgramOuExecutable);
    const argv = [
      exe ? r(exe) : "node",
      ...lista(cfg.runtimeArgs).map(r),
      ...(program ? [r(program)] : []),
      ...lista(cfg.args).map(r),
    ];
    return { rotulo: "Node", cwd, env, argv };
  },
};

const python: Runner = {
  tipos: ["python", "debugpy"],
  async montar(cfg, ctx) {
    const { r, cwd, env } = base(cfg, ctx);
    const exe = r(texto(cfg.python) ?? "python3");
    const args = lista(cfg.args).map(r);
    const modulo = texto(cfg.module);
    const program = texto(cfg.program);
    if (modulo) return { rotulo: "Python", cwd, env, argv: [exe, "-m", r(modulo), ...args] };
    if (program) return { rotulo: "Python", cwd, env, argv: [exe, r(program), ...args] };
    throw new Error(T.faltaProgramOuModule);
  },
};

const go: Runner = {
  tipos: ["go"],
  async montar(cfg, ctx) {
    const { r, cwd, env } = base(cfg, ctx);
    const program = r(texto(cfg.program) ?? ctx.pasta);
    const args = lista(cfg.args).map(r);
    const sub = cfg.mode === "test" ? "test" : "run";
    return { rotulo: "Go", cwd, env, argv: ["go", sub, program, ...args] };
  },
};

const RUNNERS: Runner[] = [dart, node, python, go];

export function runnerPara(tipo: string): Runner | undefined {
  return RUNNERS.find((r) => r.tipos.includes(tipo));
}

/** A linha que o painel recebe: `VAR=valor programa args`, depois da tarefa, se houver. */
export function linhaDeComando(plano: Plano, antes: string | null): string {
  const env = Object.entries(plano.env)
    .filter(([k]) => /^[A-Za-z_]\w*$/.test(k))
    .map(([k, v]) => `${k}=${palavra(v)}`);
  const comando = [...env, ...plano.argv.map(palavra)].join(" ");
  return antes ? `${antes} && ${comando}` : comando;
}
