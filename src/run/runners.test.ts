import { describe, expect, it } from "vitest";
import type { ConfigLaunch } from "./launch";
import { commandLine, runnerFor } from "./runners";
import { word } from "./shell";

const ctx = (flutter: boolean) => ({ folder: "/w/app", home: "/Users/eu", isFlutter: async () => flutter });

function build(cfg: { type: string; [campo: string]: unknown }, flutter = true) {
  const runner = runnerFor(cfg.type);
  if (!runner) throw new Error(`sem runner para ${cfg.type}`);
  const complete: ConfigLaunch = { name: "x", request: "launch", ...cfg };
  return runner.build(complete, ctx(flutter));
}

describe("dart", () => {
  it("runs Flutter with device, mode, tool args and app args", async () => {
    const plan = await build({
      type: "dart",
      program: "lib/main.dart",
      deviceId: "emulator-5554",
      flutterMode: "profile",
      toolArgs: ["--flavor", "dev"],
      args: ["--dart-define=ENV=dev"],
    });
    expect(plan.argv).toEqual([
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
    expect(plan.cwd).toBe("/w/app");
    expect(plan.quit).toBe("q");
    expect(plan.actions?.map((a) => a.keyOf)).toEqual(["r", "R"]);
  });

  it("runs plain Dart outside Flutter projects", async () => {
    const plan = await build({ type: "dart", program: "bin/main.dart", args: ["a"] }, false);
    expect(plan.argv).toEqual(["dart", "run", "bin/main.dart", "a"]);
    expect(plan.actions).toBeUndefined();
  });
});

describe("node, python, go", () => {
  it("builds node commands with runtime, cwd and env", async () => {
    const plan = await build({
      type: "node",
      runtimeExecutable: "npm",
      runtimeArgs: ["run", "dev"],
      cwd: "web",
      env: { PORT: 3000 },
    });
    expect(plan.argv).toEqual(["npm", "run", "dev"]);
    expect(plan.cwd).toBe("/w/app/web");
    expect(plan.env).toEqual({ PORT: "3000" });
  });

  it("builds python modules and go programs", async () => {
    expect((await build({ type: "debugpy", module: "app", args: ["-v"] })).argv).toEqual(["python3", "-m", "app", "-v"]);
    expect((await build({ type: "go", program: "${workspaceFolder}/cmd/api" })).argv).toEqual([
      "go",
      "run",
      "/w/app/cmd/api",
    ]);
  });

  it("refuses attach and unknown types", async () => {
    await expect(build({ type: "node", request: "attach", program: "a.js" })).rejects.toThrow(/attach/);
    expect(runnerFor("chrome")).toBeUndefined();
  });
});

describe("commandLine", () => {
  it("quotes words, leaves env expansion to the shell and chains the task", () => {
    const plan = {
      label: "Flutter",
      cwd: "/w/app",
      env: { API: "${env:HOME}/x", "NÃO-VALE": "1" },
      argv: ["flutter", "run", "-t", "lib/my main.dart"],
    };
    expect(commandLine(plan, null)).toBe('API="${HOME}"/x flutter run -t lib/my\\ main.dart');
    expect(commandLine(plan, "npm run build")).toMatch(/^npm run build && API=/);
    expect(word("")).toBe("''");
  });
});
