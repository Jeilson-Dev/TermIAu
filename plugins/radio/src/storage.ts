/// Where the radio keeps what it remembers, and the move from the keys it had
/// while it was part of the app.
import type { PluginStorage } from "../../../src/plugins/api";

/// The current station is stored by its address, not its index: the list is
/// redone on every probe, and the index would start pointing at another.
export const KEY_STATION = "currentStation";
/// A number from 0 to 100.
export const KEY_VOLUME = "volume";
/// Whether the radio was on air when the app closed: it starts playing again on launch.
export const KEY_PLAYING = "playing";

/// The keys from before the radio was a plugin, and where each one goes. Same
/// webview origin, so they are still in localStorage.
const LEGACY: [string, string][] = [
  ["termiau:radio:atual", KEY_STATION],
  ["termiau:lofi:volume", KEY_VOLUME],
  ["termiau:radio:tocando", KEY_PLAYING],
];

/// Copies each old key that has a value and no new one yet, then deletes the old. Once
/// done there is nothing left to move, so running it on every activation is free.
export function migrateLegacyKeys(storage: PluginStorage, legacy: Pick<Storage, "getItem" | "removeItem">) {
  for (const [old, key] of LEGACY) {
    const value = legacy.getItem(old);
    if (value === null) continue;
    if (storage.get(key) === null) storage.set(key, value);
    legacy.removeItem(old);
  }
}
