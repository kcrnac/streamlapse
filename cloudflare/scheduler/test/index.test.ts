import { describe, expect, it, vi } from "vitest";
import {
  dispatchCapture,
  getScheduleDecision,
  GitHubDispatchError,
  handleScheduled,
  loadScheduleConfig,
  parseScheduleConfig,
} from "../src/index";

const CONFIG_YAML = `
schedule:
  timezone: Europe/Zagreb
  work_days: [Mon, Tue, Wed, Thu, Fri, Sat]
  work_hours:
    start: '06:00'
    end: '18:00'
`;

const SCHEDULE = parseScheduleConfig(CONFIG_YAML);

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

function schedulerFetcher(dispatchStatus = 204) {
  return vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    if (String(input).includes("raw.githubusercontent.com")) {
      return new Response(CONFIG_YAML, { status: 200 });
    }
    return new Response(null, { status: dispatchStatus });
  });
}

describe("schedule config", () => {
  it("parses the repository schedule", () => {
    expect(SCHEDULE).toMatchObject({
      timeZone: "Europe/Zagreb",
      startMinute: 360,
      endMinute: 1080,
    });
    expect(SCHEDULE.workDays).not.toContain("Sun");
  });

  it("fails visibly when config.yml cannot be loaded", async () => {
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(null, { status: 503 }),
    );

    await expect(loadScheduleConfig(fetcher as typeof fetch)).rejects.toThrow(
      "Could not load config.yml: HTTP 503",
    );
  });
});

describe("Europe/Zagreb schedule", () => {
  it.each([
    ["Monday 05:59", "2026-01-05T05:59:00", "+01:00", false, "outside-window"],
    ["Monday 06:00", "2026-01-05T06:00:00", "+01:00", true, "eligible"],
    ["Monday 06:15", "2026-01-05T06:15:00", "+01:00", true, "eligible"],
    ["Sunday 12:00", "2026-01-11T12:00:00", "+01:00", false, "outside-work-days"],
    ["Monday 18:00", "2026-01-05T18:00:00", "+01:00", true, "eligible"],
    ["Monday 18:01", "2026-01-05T18:01:00", "+01:00", false, "outside-window"],
  ] as const)("handles %s", (_name, localIso, offset, expected, reason) => {
    expect(getScheduleDecision(zagrebInstant(localIso, offset), SCHEDULE)).toMatchObject({
      shouldDispatch: expected,
      reason,
    });
  });

  it("honors excluded work days from config.yml", () => {
    const weekdaysOnly = parseScheduleConfig(
      CONFIG_YAML.replace("Fri, Sat", "Fri"),
    );

    expect(
      getScheduleDecision(zagrebInstant("2026-01-11T12:00:00", "+01:00"), weekdaysOnly),
    ).toMatchObject({ shouldDispatch: false, reason: "outside-work-days" });
  });

  it("uses CEST after the spring DST transition", () => {
    expect(getScheduleDecision(Date.parse("2026-03-30T04:00:00Z"), SCHEDULE)).toMatchObject({
      shouldDispatch: true,
      localTime: "Mon 06:00",
    });
  });

  it("uses CET after the autumn DST transition", () => {
    expect(getScheduleDecision(Date.parse("2026-10-26T05:00:00Z"), SCHEDULE)).toMatchObject({
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

  it("loads config.yml before dispatching an eligible capture", async () => {
    const fetcher = schedulerFetcher();
    const controller = scheduledController(zagrebInstant("2026-01-05T06:00:00", "+01:00"));

    await expect(
      handleScheduled(controller, { GITHUB_TOKEN: "test-token" }, fetcher as typeof fetch),
    ).resolves.toBe("dispatched");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(String(fetcher.mock.calls[0][0])).toContain("config.yml");
    expect(String(fetcher.mock.calls[1][0])).toContain("capture.yml/dispatches");
  });

  it("does not call GitHub dispatch outside the configured schedule", async () => {
    const fetcher = schedulerFetcher();
    const controller = scheduledController(zagrebInstant("2026-01-05T18:15:00", "+01:00"));

    await expect(
      handleScheduled(controller, { GITHUB_TOKEN: "test-token" }, fetcher as typeof fetch),
    ).resolves.toBe("skipped");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("disables retries for a permanent GitHub client error", async () => {
    const fetcher = schedulerFetcher(401);
    const controller = scheduledController(zagrebInstant("2026-01-05T06:00:00", "+01:00"));

    await expect(
      handleScheduled(controller, { GITHUB_TOKEN: "test-token" }, fetcher as typeof fetch),
    ).rejects.toBeInstanceOf(GitHubDispatchError);
    expect(controller.noRetry).toHaveBeenCalledOnce();
  });
});
