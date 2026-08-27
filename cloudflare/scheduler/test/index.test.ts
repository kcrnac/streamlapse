import { describe, expect, it, vi } from "vitest";
import {
  dispatchCapture,
  getScheduleDecision,
  GitHubDispatchError,
  handleScheduled,
} from "../src/index";

function zagrebInstant(localIso: string, utcOffset: "+01:00" | "+02:00"): number {
  return Date.parse(`${localIso}${utcOffset}`);
}

function scheduledController(scheduledTime: number) {
  return {
    scheduledTime,
    cron: "*/15 * * * MON-SAT",
    noRetry: vi.fn(),
  } satisfies ScheduledController;
}

describe("Europe/Zagreb schedule", () => {
  it.each([
    ["Monday 05:59", "2026-01-05T05:59:00", "+01:00", false],
    ["Monday 06:00", "2026-01-05T06:00:00", "+01:00", true],
    ["Saturday 12:00", "2026-01-10T12:00:00", "+01:00", true],
    ["Saturday 18:00", "2026-01-10T18:00:00", "+01:00", true],
    ["Saturday 18:01", "2026-01-10T18:01:00", "+01:00", false],
    ["Sunday 12:00", "2026-01-11T12:00:00", "+01:00", false],
  ] as const)("handles %s", (_name, localIso, offset, expected) => {
    expect(getScheduleDecision(zagrebInstant(localIso, offset)).shouldDispatch).toBe(expected);
  });

  it("uses CEST after the spring DST transition", () => {
    expect(getScheduleDecision(Date.parse("2026-03-30T04:00:00Z"))).toMatchObject({
      shouldDispatch: true,
      localTime: "Mon 06:00",
    });
  });

  it("uses CET after the autumn DST transition", () => {
    expect(getScheduleDecision(Date.parse("2026-10-26T05:00:00Z"))).toMatchObject({
      shouldDispatch: true,
      localTime: "Mon 06:00",
    });
  });
});

describe("GitHub workflow dispatch", () => {
  it("dispatches capture.yml on main with force=true", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );

    await dispatchCapture("test-token", fetcher as typeof fetch);

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(
      "https://api.github.com/repos/kcrnac/streamlapse/actions/workflows/capture.yml/dispatches",
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      ref: "main",
      inputs: { force: "true" },
    });
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token");
  });

  it("fails visibly when GitHub rejects the dispatch", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 403 }),
    );

    await expect(dispatchCapture("test-token", fetcher as typeof fetch)).rejects.toEqual(
      new GitHubDispatchError(403),
    );
  });

  it("does not call GitHub outside the local schedule", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );
    const controller = scheduledController(zagrebInstant("2026-01-11T12:00:00", "+01:00"));

    await expect(
      handleScheduled(controller, { GITHUB_TOKEN: "test-token" }, fetcher as typeof fetch),
    ).resolves.toBe("skipped");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("disables retries for a permanent GitHub client error", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 401 }),
    );
    const controller = scheduledController(zagrebInstant("2026-01-05T06:00:00", "+01:00"));

    await expect(
      handleScheduled(controller, { GITHUB_TOKEN: "test-token" }, fetcher as typeof fetch),
    ).rejects.toBeInstanceOf(GitHubDispatchError);
    expect(controller.noRetry).toHaveBeenCalledOnce();
  });
});
