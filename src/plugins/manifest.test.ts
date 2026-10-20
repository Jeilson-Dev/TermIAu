import { describe, expect, it } from "vitest";
import type { Manifest, SettingContribution } from "./api";
import {
  compareVersions,
  displayKeybinding,
  localize,
  regionProblems,
  settingProblems,
  settingValue,
  sortStatusBar,
} from "./manifest";

const base: Manifest = { id: "termiau.radio", name: "Radio", version: "1.0.0", main: "main.js" };

describe("localize", () => {
  it("picks the language and falls back to English", () => {
    expect(localize("Radio", "pt")).toBe("Radio");
    expect(localize({ en: "Radio", pt: "Rádio" }, "pt")).toBe("Rádio");
    expect(localize({ en: "Radio", pt: "Rádio" }, "en")).toBe("Radio");
    expect(localize({ en: "Radio" }, "pt")).toBe("Radio");
  });
});

describe("regionProblems", () => {
  it("accepts the footer", () => {
    const m = { ...base, contributes: { regions: [{ region: "statusBar" as const, id: "radio" }] } };
    expect(regionProblems(m)).toEqual([]);
  });

  it("refuses regions that don't exist yet and duplicates", () => {
    const m: Manifest = {
      ...base,
      contributes: {
        regions: [
          { region: "sidebar", id: "a" },
          { region: "statusBar", id: "b" },
          { region: "statusBar", id: "b" },
        ],
      },
    };
    expect(regionProblems(m)).toEqual([
      'region "sidebar" is not supported yet',
      'region "statusBar:b" declared twice',
    ]);
  });
});

describe("sortStatusBar", () => {
  it("puts higher priority first, ties by plugin id", () => {
    const sorted = sortStatusBar([
      { plugin: "b", region: { region: "statusBar", id: "x" } },
      { plugin: "a", region: { region: "statusBar", id: "x" } },
      { plugin: "c", region: { region: "statusBar", id: "x", priority: 100 } },
    ]);
    expect(sorted.map((e) => e.plugin)).toEqual(["c", "a", "b"]);
  });
});

describe("compareVersions", () => {
  it("compares number by number", () => {
    expect(compareVersions("1.10.0", "1.9.2")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0", "1.0.1")).toBe(-1);
    expect(compareVersions("2.0.0-beta", "1.9.9")).toBe(1);
  });
});

describe("displayKeybinding", () => {
  it("writes the accelerator the macOS way", () => {
    expect(displayKeybinding("CmdOrCtrl+Shift+P")).toBe("⌘⇧P");
    expect(displayKeybinding("Shift+Alt+Ctrl+k")).toBe("⌃⌥⇧K");
    expect(displayKeybinding("CmdOrCtrl+Enter")).toBe("⌘↩");
    expect(displayKeybinding("F5")).toBe("F5");
  });
});

describe("settings", () => {
  const language: SettingContribution = {
    key: "language",
    title: "Language",
    type: "enum",
    options: [
      { value: "pt", label: "Português" },
      { value: "en", label: "English" },
    ],
    default: "pt",
  };
  const sound: SettingContribution = { key: "sound", title: "Sound", type: "boolean", default: true };

  it("accepts enums and booleans", () => {
    expect(settingProblems({ ...base, contributes: { configuration: [language, sound] } })).toEqual([]);
  });

  it("refuses a default that isn't an option, duplicates and unknown types", () => {
    const m = {
      ...base,
      contributes: {
        configuration: [{ ...language, default: "fr" }, sound, sound, { key: "n", title: "N", type: "number", default: 1 }],
      },
    } as unknown as Manifest;
    expect(settingProblems(m)).toEqual([
      'setting "language": the default isn\'t an option',
      'setting "sound" declared twice',
      'setting "n": type "number" is not supported',
    ]);
  });

  it("reads the stored value while it is still valid", () => {
    expect(settingValue(language, null)).toBe("pt");
    expect(settingValue(language, '"en"')).toBe("en");
    // An option a plugin update dropped, or junk, falls back to the default.
    expect(settingValue(language, '"fr"')).toBe("pt");
    expect(settingValue(language, "{")).toBe("pt");
    expect(settingValue(sound, "false")).toBe(false);
    expect(settingValue(sound, '"no"')).toBe(true);
  });
});
