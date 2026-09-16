import { describe, expect, it } from "vitest";
import type { ConfigLaunch } from "./launch";
import { linhaDeComando, runnerPara } from "./runners";
import { palavra } from "./shell";

const ctx = (flutter: boolean) => ({ pasta: "/w/app", home: "/Users/eu", ehFlutter: async () => flutter });

function montar(cfg: { type: string; [campo: string]: unknown }, flutter = true) {
  const runner = runnerPara(cfg.type);
  if (!runner) throw new Error(`sem runner para ${cfg.type}`);
  const completa: ConfigLaunch = { name: "x", request: "launch", ...cfg };
  return runner.montar(completa, ctx(flutter));
}

describe("dart", () => {
  it("runs Flutter with device, mode, tool args and app args", async () => {
    const plano = await montar({
      type: "dart",
      program: "lib/main.dart",
      deviceId: "emulator-5554",
      flutterMode: "profile",
      toolArgs: ["--flavor", "dev"],
      args: ["--dart-define=ENV=dev"],
    });
    expect(plano.argv).toEqual([
      "flutter",
      "run",
      "-d",
      "emulator-5554",
      "--profile",
      "--flavor",
      "dev",
      "-t",
      "lib/main.dart",
      "--dart-define=ENV=dev",
    ]);
    expect(plano.cwd).toBe("/w/app");
    expect(plano.sair).toBe("q");
    expect(plano.acoes?.map((a) => a.tecla)).toEqual(["r", "R"]);
  });

  it("runs plain Dart outside Flutter projects", async () => {
    const plano = await montar({ type: "dart", program: "bin/main.dart", args: ["a"] }, false);
    expect(plano.argv).toEqual(["dart", "run", "bin/main.dart", "a"]);
    expect(plano.acoes).toBeUndefined();
  });
});

describe("node, python, go", () => {
  it("builds node commands with runtime, cwd and env", async () => {
    const plano = await montar({
      type: "node",
      runtimeExecutable: "npm",
      runtimeArgs: ["run", "dev"],
      cwd: "web",
      env: { PORT: 3000 },
    });
    expect(plano.argv).toEqual(["npm", "run", "dev"]);
    expect(plano.cwd).toBe("/w/app/web");
    expect(plano.env).toEqual({ PORT: "3000" });
  });

  it("builds python modules and go programs", async () => {
    expect((await montar({ type: "debugpy", module: "app", args: ["-v"] })).argv).toEqual(["python3", "-m", "app", "-v"]);
    expect((await montar({ type: "go", program: "${workspaceFolder}/cmd/api" })).argv).toEqual([
      "go",
      "run",
      "/w/app/cmd/api",
    ]);
  });

  it("refuses attach and unknown types", async () => {
    await expect(montar({ type: "node", request: "attach", program: "a.js" })).rejects.toThrow(/attach/);
    expect(runnerPara("chrome")).toBeUndefined();
  });
});

describe("linhaDeComando", () => {
  it("quotes words, leaves env expansion to the shell and chains the task", () => {
    const plano = {
      rotulo: "Flutter",
      cwd: "/w/app",
      env: { API: "${env:HOME}/x", "NÃO-VALE": "1" },
      argv: ["flutter", "run", "-t", "lib/my main.dart"],
    };
    expect(linhaDeComando(plano, null)).toBe('API="${HOME}"/x flutter run -t lib/my\\ main.dart');
    expect(linhaDeComando(plano, "npm run build")).toMatch(/^npm run build && API=/);
    expect(palavra("")).toBe("''");
  });
});
