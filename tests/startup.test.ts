import { describe, it, expect, vi } from "vitest";

describe("Worker startup and global scope checks", () => {
  it("does not register any global timers at module evaluation time", async () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const appModule = await import("../src/index");
    expect(appModule.app).toBeDefined();

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    setIntervalSpy.mockRestore();
    setTimeoutSpy.mockRestore();
  });
});
