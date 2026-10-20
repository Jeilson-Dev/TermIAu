import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLanguage, language } from "./i18n";
import { missingFor, remainingFraction, windowNow, autoCompactLimit, paceLevel, contextLevel, usageLevel, statusLineUsage } from "./usage";

// The texts expected here are the English ones.
const initial = language();
beforeEach(() => setLanguage("en"));
afterEach(() => setLanguage(initial));

const now = Date.parse("2026-10-09T12:00:00Z");
const fromHere = (min: number) => new Date(now + min * 60_000).toISOString();

describe("usage", () => {
  it("measures how much of the window is left", () => {
    expect(remainingFraction(fromHere(150), 300, now)).toBe(0.5);
    expect(remainingFraction(fromHere(-5), 300, now)).toBe(0);
    expect(remainingFraction(null, 300, now)).toBe(1);
  });

  it("lights up by pace, not by usage", () => {
    // 60% spent with 60% of the window gone: on pace.
    expect(paceLevel(60, 0.4)).toBe("");
    // 60% spent with 20% gone: it will run out early.
    expect(paceLevel(60, 0.8)).toBe("danger");
    expect(paceLevel(60, 0.6)).toBe("attention");
    expect(paceLevel(40, 1)).toBe("");
  });

  it("for the week, by usage", () => {
    expect(usageLevel(74)).toBe("");
    expect(usageLevel(80)).toBe("attention");
    expect(usageLevel(95)).toBe("danger");
  });

  it("says how long is left, briefly", () => {
    expect(missingFor(fromHere(113), now)).toBe("1h53");
    expect(missingFor(fromHere(42), now)).toBe("42min");
    expect(missingFor(fromHere(60 * 76), now)).toBe("3d4h");
    expect(missingFor(fromHere(-1), now)).toBe("now");
  });
});

describe("statusLineUsage", () => {
  it("reads the limits Claude Code sends", () => {
    const u = statusLineUsage({
      five_hour: { used_percentage: 42, resets_at: now / 1000 + 3600 },
      seven_day: { used_percentage: 18 },
    });
    expect(u?.session).toEqual({ usage: 42, renews: fromHere(60) });
    expect(u?.week).toEqual({ usage: 18, renews: null });
  });

  it("no limits, nothing", () => {
    expect(statusLineUsage(undefined)).toBeUndefined();
    expect(statusLineUsage({ five_hour: null })).toBeUndefined();
  });

  it("a window that already renewed comes back at zero", () => {
    expect(windowNow({ usage: 80, renews: fromHere(-1) }, now)).toEqual({ usage: 0, renews: null });
    expect(windowNow({ usage: 80, renews: fromHere(5) }, now)).toEqual({ usage: 80, renews: fromHere(5) });
  });
});

describe("contextLevel", () => {
  it("yellow and red by the limits", () => {
    expect(contextLevel(59)).toBe("");
    expect(contextLevel(60)).toBe("attention");
    expect(contextLevel(75)).toBe("danger");
    expect(contextLevel(50, { attention: 40, danger: 50 })).toBe("danger");
    expect(contextLevel(45, { attention: 40, danger: 50 })).toBe("attention");
  });

  it("an invalid limit gets the default", () => {
    expect(contextLevel(70, { attention: 0, danger: Number.NaN })).toBe("attention");
    expect(contextLevel(80, { danger: 200 })).toBe("danger");
  });

  it("red wins when the limits cross", () => {
    expect(contextLevel(70, { attention: 80, danger: 70 })).toBe("danger");
  });
});

describe("autoCompactLimit", () => {
  it("off has no limit", () => {
    expect(autoCompactLimit()).toBeNull();
    expect(autoCompactLimit({ autoCompact: false, autoCompactAt: 80 })).toBeNull();
  });

  it("on uses the value, or the default of 76", () => {
    expect(autoCompactLimit({ autoCompact: true })).toBe(76);
    expect(autoCompactLimit({ autoCompact: true, autoCompactAt: 90 })).toBe(90);
  });

  it("must exceed red", () => {
    expect(autoCompactLimit({ autoCompact: true, danger: 75, autoCompactAt: 70 })).toBe(76);
    expect(autoCompactLimit({ autoCompact: true, danger: 85, autoCompactAt: 76 })).toBe(86);
    expect(autoCompactLimit({ autoCompact: true, danger: 100, autoCompactAt: 90 })).toBe(100);
  });
});
