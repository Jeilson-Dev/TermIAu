import { describe, expect, it } from "vitest";
import { autoCompactLimit, contextLevel } from "./limits";

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
