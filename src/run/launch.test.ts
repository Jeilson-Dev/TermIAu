import { describe, expect, it } from "vitest";
import { configsDe, lerJsonc, listaDoPlay, resolver, tarefaAntes, type Tarefa } from "./launch";

const ctx = { pasta: "/w/app", home: "/Users/eu" };

describe("lerJsonc", () => {
  it("accepts comments and trailing commas, leaving strings alone", () => {
    const json = lerJsonc(`{
      // comentário
      "url": "http://x//y", /* bloco */
      "texto": "a, ]",
      "lista": [1, 2,],
    }`);
    expect(json).toEqual({ url: "http://x//y", texto: "a, ]", lista: [1, 2] });
  });
});

describe("configsDe", () => {
  it("keeps only configurations with a name and a type", () => {
    const configs = configsDe(`{ "configurations": [
      { "name": "app", "type": "dart", "request": "launch" },
      { "type": "node" },
      "lixo"
    ] }`);
    expect(configs.map((c) => c.name)).toEqual(["app"]);
  });
});

describe("listaDoPlay", () => {
  it("turns separators into group titles and drops CodeLens-only configurations", () => {
    const configs = configsDe(`{ "configurations": [
      { "name": "──── DEV ────", "type": "node", "program": "\${workspaceFolder}/.vscode/does-not-exist.js" },
      { "name": "Assessor (Chrome Dev)", "type": "dart" },
      { "name": "──── TESTS ────", "type": "node" },
      { "name": " ---> Update Golden <---", "type": "dart", "codeLens": { "for": ["run-test"] } },
      { "name": "(local)", "type": "dart", "codeLens": { "for": ["run-test"] }, },
      { "name": "──── PROD ────", "type": "node" },
      { "name": "Assessor (Chrome Production)", "type": "dart" },
    ] }`);
    const { configs: rodaveis, menu } = listaDoPlay(configs);
    expect(rodaveis.map((c) => c.name)).toEqual(["Assessor (Chrome Dev)", "Assessor (Chrome Production)"]);
    expect(menu.map((m) => (typeof m === "string" ? `# ${m}` : m.name))).toEqual([
      "# DEV",
      "Assessor (Chrome Dev)",
      "# PROD",
      "Assessor (Chrome Production)",
    ]);
  });
});

describe("resolver", () => {
  it("replaces workspace variables and leaves env ones to the shell", () => {
    expect(resolver("${workspaceFolder}/lib", ctx)).toBe("/w/app/lib");
    expect(resolver("${workspaceFolderBasename}:${userHome}", ctx)).toBe("app:/Users/eu");
    expect(resolver("${env:HOME}/x", ctx)).toBe("${env:HOME}/x");
  });

  it("stops on variables that need the editor", () => {
    expect(() => resolver("${input:device}", ctx)).toThrow(/input:device/);
  });
});

describe("tarefaAntes", () => {
  const tarefas: Tarefa[] = [
    { label: "gerar", type: "shell", command: "dart run build_runner build", args: ["--delete-conflicting-outputs"] },
    { type: "npm", script: "build" },
    { label: "longe", type: "process", command: "make", options: { cwd: "${workspaceFolder}/native" } },
    { label: "vigia", type: "shell", command: "tsc -w", isBackground: true },
    { label: "flutter", type: "flutter", command: "flutter" },
  ];
  const com = (preLaunchTask?: string) => tarefaAntes({ name: "x", type: "dart", preLaunchTask }, tarefas, ctx);

  it("turns supported tasks into a shell line", () => {
    expect(com()).toBeNull();
    expect(com("gerar")).toBe("dart run build_runner build --delete-conflicting-outputs");
    expect(com("npm: build")).toBe("npm run build");
    expect(com("longe")).toBe("(cd /w/app/native && make)");
  });

  it("refuses what it can't run", () => {
    expect(() => com("nenhuma")).toThrow(/não está/);
    expect(() => com("vigia")).toThrow(/segundo plano/);
    expect(() => com("flutter")).toThrow(/tipo "flutter"/);
  });
});
