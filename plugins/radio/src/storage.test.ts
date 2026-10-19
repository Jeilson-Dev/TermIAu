import { describe, expect, it } from "vitest";
import type { PluginStorage } from "../../../src/plugins/api";
import { KEY_PLAYING, KEY_STATION, KEY_VOLUME, migrateLegacyKeys } from "./storage";

function memory(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const storage: PluginStorage = {
    get: (k) => data.get(k) ?? null,
    set: (k, v) => void data.set(k, v),
    remove: (k) => void data.delete(k),
  };
  const legacy = {
    getItem: (k: string) => data.get(k) ?? null,
    removeItem: (k: string) => void data.delete(k),
  };
  return { data, storage, legacy };
}

describe("migrateLegacyKeys", () => {
  it("moves the keys from when the radio was part of the app", () => {
    const m = memory({
      "termiau:radio:atual": "https://example.com/stream",
      "termiau:lofi:volume": "75",
      "termiau:radio:tocando": "1",
    });
    migrateLegacyKeys(m.storage, m.legacy);
    expect(m.storage.get(KEY_STATION)).toBe("https://example.com/stream");
    expect(m.storage.get(KEY_VOLUME)).toBe("75");
    expect(m.storage.get(KEY_PLAYING)).toBe("1");
    expect(m.legacy.getItem("termiau:radio:atual")).toBeNull();
  });

  it("doesn't overwrite what the plugin already has", () => {
    const m = memory({ "termiau:lofi:volume": "75", [KEY_VOLUME]: "25" });
    migrateLegacyKeys(m.storage, m.legacy);
    expect(m.storage.get(KEY_VOLUME)).toBe("25");
    expect(m.legacy.getItem("termiau:lofi:volume")).toBeNull();
  });

  it("with nothing to move, does nothing", () => {
    const m = memory();
    migrateLegacyKeys(m.storage, m.legacy);
    expect(m.data.size).toBe(0);
  });
});
