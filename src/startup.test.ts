import { describe, expect, it } from "vitest";
import { start, type Steps } from "./startup";

/// Steps that only record the order. `fonts` can be swapped to simulate the
/// stuck page.
function steps(done: string[], extra: Partial<Steps> = {}): Steps {
  return {
    fonts: async () => void done.push("fonts"),
    connect: async () => void done.push("connect"),
    openTabs: async () => void done.push("openTabs"),
    after: () => void done.push("after"),
    activatePlugins: () => void done.push("activatePlugins"),
    ...extra,
  };
}

describe("start", () => {
  it("starts in order: fonts, events, tabs, the rest and the plugins last", async () => {
    const done: string[] = [];
    await start(steps(done));
    expect(done).toEqual(["fonts", "connect", "openTabs", "after", "activatePlugins"]);
  });

  it("plugins don't hold the tabs: fonts are only ready with no stream loading on the page", async () => {
    // The bug: a loading stream holds the page's `load`, and
    // `document.fonts.ready` never resolves. Here, the fonts only become
    // ready if no plugin (the radio, resuming) has started yet.
    const done: string[] = [];
    let plugins = false;
    const p = steps(done, {
      fonts: () => (plugins ? new Promise(() => {}) : Promise.resolve()),
      activatePlugins: () => {
        plugins = true;
        done.push("activatePlugins");
      },
    });
    await start(p);
    expect(done).toContain("openTabs");
    expect(done.indexOf("openTabs")).toBeLessThan(done.indexOf("activatePlugins"));
  });

  it("waits for each async step to finish before the next", async () => {
    const done: string[] = [];
    const slow = (name: string) => () =>
      new Promise<void>((ok) => setTimeout(() => (done.push(name), ok()), 5));
    await start(steps(done, { fonts: slow("fonts"), connect: slow("connect"), openTabs: slow("openTabs") }));
    expect(done).toEqual(["fonts", "connect", "openTabs", "after", "activatePlugins"]);
  });

  it("no tabs, no plugins: a failure opening the tabs stops the startup", async () => {
    const done: string[] = [];
    const p = steps(done, { openTabs: () => Promise.reject(new Error("pty")) });
    await expect(start(p)).rejects.toThrow("pty");
    expect(done).toEqual(["fonts", "connect"]);
  });
});
