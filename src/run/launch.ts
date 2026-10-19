// The .vscode/launch.json, and the tasks.json it references, read without VS Code.

import { word } from "./shell";
import { T } from "../i18n/terminal";

/** An entry in `configurations`. Besides these fields, each `type` has its own. */
export interface ConfigLaunch {
  name: string;
  type: string;
  request?: string;
  [campo: string]: unknown;
}

/** An entry in tasks.json's `tasks`, with only what the play button can run. */
export interface Task {
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
export interface Context {
  /** The folder holding `.vscode`: the `${workspaceFolder}`. */
  folder: string;
  home: string;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

/** Index of the quote that closes the string opened at `beginning`. */
function stringEnd(text: string, beginning: number): number {
  let i = beginning + 1;
  while (i < text.length && text[i] !== '"') i += text[i] === "\\" ? 2 : 1;
  return i;
}

function noComments(text: string): string {
  let output = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = stringEnd(text, i);
      output += text.slice(i, end + 1);
      i = end;
    } else if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end - 1; // the newline stays
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      output += c;
    }
  }
  return output;
}

function noTrailingCommas(text: string): string {
  let output = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      const end = stringEnd(text, i);
      output += text.slice(i, end + 1);
      i = end;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (/\s/.test(text[j] ?? "")) j++;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    output += c;
  }
  return output;
}

/** JSON with comments and trailing commas: the format VS Code accepts in these files. */
export function readJsonc(text: string): unknown {
  return JSON.parse(noTrailingCommas(noComments(text)));
}

export function configsOf(text: string): ConfigLaunch[] {
  const json = readJsonc(text);
  const list = isObject(json) && Array.isArray(json.configurations) ? json.configurations : [];
  return list.filter(
    (c): c is ConfigLaunch => isObject(c) && typeof c.name === "string" && typeof c.type === "string",
  );
}

/** What the play button offers: the configurations it runs and the list with group titles. */
export interface PlayList {
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
export function playList(configs: ConfigLaunch[]): PlayList {
  const menu: (ConfigLaunch | string)[] = [];
  // A group with nothing below it (it only had CodeLens configurations) doesn't show.
  const noEmptyGroup = () => {
    if (typeof menu[menu.length - 1] === "string") menu.pop();
  };
  for (const c of configs) {
    if (isObject(c.codeLens)) continue;
    const group = separatorTitle(c.name);
    if (group === null) {
      menu.push(c);
    } else {
      noEmptyGroup();
      menu.push(group);
    }
  }
  noEmptyGroup();
  return { configs: menu.filter((m): m is ConfigLaunch => typeof m !== "string"), menu };
}

/** "──── DEV ────" -> "DEV". Null when the name doesn't have dashes at both ends. */
function separatorTitle(name: string): string | null {
  if (!/^\s*[─━═—–=-]{3,}/.test(name) || !/[─━═—–=-]{3,}\s*$/.test(name)) return null;
  return name.replace(/[─━═—–=<>-]{2,}/g, "").trim();
}

export function tasksOf(text: string): Task[] {
  const json = readJsonc(text);
  const list = isObject(json) && Array.isArray(json.tasks) ? json.tasks : [];
  return list.filter(isObject) as Task[];
}

/**
 * Replaces VS Code's variables. `${env:X}` passes intact: the shell expands it
 * (see `word`). Those that depend on the editor (`${file}`, `${input:...}`) have no
 * answer here and stop the run with their name.
 */
export function resolver(valor: string, ctx: Context): string {
  return valor.replace(/\$\{([^}]+)\}/g, (todo, name: string) => {
    switch (name) {
      case "workspaceFolder":
      case "workspaceRoot":
      case "cwd":
        return ctx.folder;
      case "workspaceFolderBasename":
        return ctx.folder.split("/").filter(Boolean).pop() ?? "";
      case "userHome":
        return ctx.home;
      case "pathSeparator":
      case "/":
        return "/";
    }
    if (name.startsWith("env:")) return todo;
    throw new Error(T.unsupportedVariable(todo));
  });
}

/**
 * The configuration's `preLaunchTask`, as a shell line that comes before the app
 * (`task && app`). Null when there is none. Tasks the play button can't run yet
 * stop the run saying why, instead of running the app without it.
 */
export function taskBefore(cfg: ConfigLaunch, tasks: Task[], ctx: Context): string | null {
  const name = cfg.preLaunchTask;
  if (typeof name !== "string" || !name) return null;
  const task =
    tasks.find((t) => t.label === name) ??
    // npm tasks detected by VS Code are named "npm: <script>".
    tasks.find((t) => t.type === "npm" && `npm: ${t.script}` === name);
  if (!task) throw new Error(T.taskMissing(name));
  if (task.dependsOn) throw new Error(T.taskDependsOn(name));
  if (task.isBackground) {
    throw new Error(T.backgroundTask(name));
  }

  const r = (v: string) => resolver(v, ctx);
  const args = (task.args ?? []).filter((a): a is string => typeof a === "string").map((a) => word(r(a)));
  let command: string;
  if (task.type === "npm" && task.script) {
    command = ["npm", "run", word(task.script), ...args].join(" ");
  } else if (task.type === "shell" && task.command) {
    // A shell task's `command` is already a shell line: it goes as is.
    command = [r(task.command).replace(/\$\{env:(\w+)\}/g, "${$1}"), ...args].join(" ");
  } else if (task.type === "process" && task.command) {
    command = [word(r(task.command)), ...args].join(" ");
  } else {
    throw new Error(T.taskType(name, String(task.type)));
  }
  const cwd = task.options?.cwd;
  return cwd ? `(cd ${word(r(cwd))} && ${command})` : command;
}
