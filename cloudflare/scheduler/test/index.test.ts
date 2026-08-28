import { describe, expect, it, vi } from "vitest";
import {
  dispatchCapture,
  getGitHubRepository,
  getScheduleConfig,
  getScheduleDecision,
  GitHubDispatchError,
  handleScheduled,
} from "../src/index";

const REPOSITORY = {
  owner: "kcrnac",
  repo: "streamlapse",
  ref: "main",
} as const;

const WORKER_ENV: Env = {
  GITHUB_TOKEN: "test-token",
  GITHUB_OWNER: REPOSITORY.owner,
  GITHUB_REPO: REPOSITORY.repo,
  GITHUB_REF: REPOSITORY.ref,
  SCHEDULE_TIME_ZONE: "Europe/Zagreb",
  SCHEDULE_START: "06:30",
  SCHEDULE_END: "18:00",
};

const SCHEDULE = getScheduleConfig(WORKER_ENV);

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

describe("Wrangler schedule variables", () => {
  it("reads and validates the schedule", () => {
    expect(SCHEDULE).toEqual({
      timeZone: "Europe/Zagreb",
      startMinute: 390,
      endMinute: 1080,
    });
  });

  it("rejects invalid clocks and overnight windows", () => {
    expect(() => getScheduleConfig({ ...WORKER_ENV, SCHEDULE_START: "6:30" })).toThrow(
      "SCHEDULE_START must use 24-hour HH:MM format",
    );
    expect(() => getScheduleConfig({ ...WORKER_ENV, SCHEDULE_START: "19:00" })).toThrow(
      "Overnight capture windows are not supported",
    );
  });
});

describe("Europe/Zagreb capture window", () => {
  it.each([
    ["06:29", "2026-01-05T06:29:00", "+01:00", false],
    ["06:30", "2026-01-05T06:30:00", "+01:00", true],
    ["06:45", "2026-01-05T06:45:00", "+01:00", true],
    ["18:00", "2026-01-05T18:00:00", "+01:00", true],
    ["18:01", "2026-01-05T18:01:00", "+01:00", false],
  ] as const)("handles %s", (_name, localIso, offset, expected) => {
    expect(getScheduleDecision(zagrebInstant(localIso, offset), SCHEDULE)).toMatchObject({
      shouldDispatch: expected,
    });
  });

  it("uses CEST after the spring DST transition", () => {
    expect(getScheduleDecision(Date.parse("2026-03-30T04:30:00Z"), SCHEDULE)).toEqual({
      shouldDispatch: true,
      localTime: "06:30",
    });
  });

  it("uses CET after the autumn DST transition", () => {
    expect(getScheduleDecision(Date.parse("2026-10-26T05:30:00Z"), SCHEDULE)).toEqual({
      shouldDispatch: true,
      localTime: "06:30",
    });
  });
});

describe("GitHub workflow dispatch", () => {
  it("reads repository targeting from Worker variables", () => {
    expect(getGitHubRepository(WORKER_ENV)).toEqual(REPOSITORY);
  });

  it("dispatches capture.yml with the configured timezone", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 204 }),
    );

    await dispatchCapture(
      "test-token",
      REPOSITORY,
      "Europe/Zagreb",
      fetcher as typeof fetch,
    );

    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(
      "https://api.github.com/repos/kcrnac/streamlapse/actions/workflows/capture.yml/dispatches",
    );
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      ref: "main",
      inputs: { timezone: "Europe/Zagreb" },
    });
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-token");
  });

  it("does not make a network request outside the configured window", async () => {
    const fetcher = vi.fn();
    const controller = scheduledController(zagrebInstant("2026-01-05T18:15:00", "+01:00"));

    await expect(
      handleScheduled(controller, WORKER_ENV, fetcher as typeof fetch),
    ).resolves.toBe("skipped");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("dispatches with one network request inside the configured window", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    const controller = scheduledController(zagrebInstant("2026-01-05T06:30:00", "+01:00"));

    await expect(
      handleScheduled(controller, WORKER_ENV, fetcher as typeof fetch),
    ).resolves.toBe("dispatched");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("disables retries for a permanent GitHub client error", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 401 }));
    const controller = scheduledController(zagrebInstant("2026-01-05T06:30:00", "+01:00"));

    await expect(
      handleScheduled(controller, WORKER_ENV, fetcher as typeof fetch),
    ).rejects.toBeInstanceOf(GitHubDispatchError);
    expect(controller.noRetry).toHaveBeenCalledOnce();
  });
});
