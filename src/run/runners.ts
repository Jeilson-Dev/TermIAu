// What the play button knows how to run, one module per launch.json `type`. Each one turns the
// configuration into a terminal command and says what can be done with the app running
// (Flutter's hot reload, for example). Supporting a new language means adding a
// module here: the bar and the run don't change.

import { resolver, type ConfigLaunch, type Contexto } from "./launch";
import { palavra } from "./shell";
import { T } from "../i18n/terminal";

/** A bar button while the app runs: a key sent to the program. */
export interface Acao {
  rotulo: string;
  icone: string;
  tecla: string;
}

/** The command ready for the panel. */
export interface Plano {
  /** What runs, for messages: "Flutter", "Node"... */
  rotulo: string;
  cwd: string;
  env: Record<string, string>;
  argv: string[];
  acoes?: Acao[];
  /** Key that quits gracefully (flutter run's `q`). Without it, stop sends Ctrl+C. */
  sair?: string;
}

export interface ContextoRunner extends Contexto {
  /** Whether the Dart project in this folder is Flutter (the pubspec depends on the SDK). */
  ehFlutter(pasta: string): Promise<boolean>;
}

export interface Runner {
  /** The `type` values this module handles. */
  tipos: string[];
  /** Throws an Error with the reason when the configuration asks for something it can't do. */
  montar(cfg: ConfigLaunch, ctx: ContextoRunner): Promise<Plano>;
}

const texto = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const lista = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** What every configuration has in common: cwd, env and only `request: "launch"`. */
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
      // `"RELEASE_MODE": false` works too: the Dart extension accepts it and turns it into text.
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
    // In a Flutter app, the Dart extension sends the `args` to flutter run itself:
    // it is where launch.json files put `--dart-define=ENV=dev` and `--flavor`. Making them
    // app arguments would make it run in the default environment, without warning.
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

/** The line the panel gets: `VAR=value program args`, after the task, if any. */
export function linhaDeComando(plano: Plano, antes: string | null): string {
  const env = Object.entries(plano.env)
    .filter(([k]) => /^[A-Za-z_]\w*$/.test(k))
    .map(([k, v]) => `${k}=${palavra(v)}`);
  const comando = [...env, ...plano.argv.map(palavra)].join(" ");
  return antes ? `${antes} && ${comando}` : comando;
}
