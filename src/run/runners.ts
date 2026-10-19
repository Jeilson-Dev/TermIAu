// What the play button knows how to run, one module per launch.json `type`. Each one turns the
// configuration into a terminal command and says what can be done with the app running
// (Flutter's hot reload, for example). Supporting a new language means adding a
// module here: the bar and the run don't change.

import { resolver, type ConfigLaunch, type Context } from "./launch";
import { word } from "./shell";
import { T } from "../i18n/terminal";

/** A bar button while the app runs: a key sent to the program. */
export interface Action {
  label: string;
  icon: string;
  keyOf: string;
}

/** The command ready for the panel. */
export interface Plan {
  /** What runs, for messages: "Flutter", "Node"... */
  label: string;
  cwd: string;
  env: Record<string, string>;
  argv: string[];
  actions?: Action[];
  /** Key that quits gracefully (flutter run's `q`). Without it, stop sends Ctrl+C. */
  quit?: string;
}

export interface RunnerContext extends Context {
  /** Whether the Dart project in this folder is Flutter (the pubspec depends on the SDK). */
  isFlutter(folder: string): Promise<boolean>;
}

export interface Runner {
  /** The `type` values this module handles. */
  kinds: string[];
  /** Throws an Error with the reason when the configuration asks for something it can't do. */
  build(cfg: ConfigLaunch, ctx: RunnerContext): Promise<Plan>;
}

const text = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
const list = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** What every configuration has in common: cwd, env and only `request: "launch"`. */
function base(cfg: ConfigLaunch, ctx: Context) {
  if ((cfg.request ?? "launch") !== "launch") {
    throw new Error(T.unsupportedRequest(String(cfg.request)));
  }
  const r = (v: string) => resolver(v, ctx);
  const dir = r(text(cfg.cwd) ?? ctx.folder);
  const cwd = dir.startsWith("/") ? dir : `${ctx.folder}/${dir}`;
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
  kinds: ["dart"],
  async build(cfg, ctx) {
    const { r, cwd, env } = base(cfg, ctx);
    const program = text(cfg.program) && r(text(cfg.program)!);
    const args = list(cfg.args).map(r);
    const toolArgs = list(cfg.toolArgs).map(r);
    const flutter =
      text(cfg.flutterMode) !== undefined || text(cfg.deviceId) !== undefined || (await ctx.isFlutter(cwd));

    if (!flutter) {
      return { label: "Dart", cwd, env, argv: ["dart", "run", ...toolArgs, ...(program ? [program] : []), ...args] };
    }

    const argv = ["flutter", "run"];
    const device = text(cfg.deviceId);
    if (device) argv.push("-d", r(device));
    const mode = text(cfg.flutterMode);
    if (mode && mode !== "debug") argv.push(`--${mode}`);
    argv.push(...toolArgs);
    if (program) argv.push("-t", program);
    // In a Flutter app, the Dart extension sends the `args` to flutter run itself:
    // it is where launch.json files put `--dart-define=ENV=dev` and `--flavor`. Making them
    // app arguments would make it run in the default environment, without warning.
    argv.push(...args);
    return {
      label: "Flutter",
      cwd,
      env,
      argv,
      quit: "q",
      actions: [
        { label: "Hot reload", icon: "⚡", keyOf: "r" },
        { label: "Hot restart", icon: "↻", keyOf: "R" },
      ],
    };
  },
};

const node: Runner = {
  kinds: ["node", "pwa-node"],
  async build(cfg, ctx) {
    const { r, cwd, env } = base(cfg, ctx);
    const exe = text(cfg.runtimeExecutable);
    const program = text(cfg.program);
    if (!exe && !program) throw new Error(T.missingProgramOrExecutable);
    const argv = [
      exe ? r(exe) : "node",
      ...list(cfg.runtimeArgs).map(r),
      ...(program ? [r(program)] : []),
      ...list(cfg.args).map(r),
    ];
    return { label: "Node", cwd, env, argv };
  },
};

const python: Runner = {
  kinds: ["python", "debugpy"],
  async build(cfg, ctx) {
    const { r, cwd, env } = base(cfg, ctx);
    const exe = r(text(cfg.python) ?? "python3");
    const args = list(cfg.args).map(r);
    const modulo = text(cfg.module);
    const program = text(cfg.program);
    if (modulo) return { label: "Python", cwd, env, argv: [exe, "-m", r(modulo), ...args] };
    if (program) return { label: "Python", cwd, env, argv: [exe, r(program), ...args] };
    throw new Error(T.missingProgramOrModule);
  },
};

const go: Runner = {
  kinds: ["go"],
  async build(cfg, ctx) {
    const { r, cwd, env } = base(cfg, ctx);
    const program = r(text(cfg.program) ?? ctx.folder);
    const args = list(cfg.args).map(r);
    const sub = cfg.mode === "test" ? "test" : "run";
    return { label: "Go", cwd, env, argv: ["go", sub, program, ...args] };
  },
};

const RUNNERS: Runner[] = [dart, node, python, go];

export function runnerFor(kind: string): Runner | undefined {
  return RUNNERS.find((r) => r.kinds.includes(kind));
}

/** The line the panel gets: `VAR=value program args`, after the task, if any. */
export function commandLine(plan: Plan, before: string | null): string {
  const env = Object.entries(plan.env)
    .filter(([k]) => /^[A-Za-z_]\w*$/.test(k))
    .map(([k, v]) => `${k}=${word(v)}`);
  const command = [...env, ...plan.argv.map(word)].join(" ");
  return before ? `${before} && ${command}` : command;
}
