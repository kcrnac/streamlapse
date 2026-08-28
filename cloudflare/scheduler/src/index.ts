import { parse } from "yaml";

const WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
const MAX_CONFIG_BYTES = 64 * 1024;

export type GitHubRepository = {
  owner: string;
  repo: string;
  ref: string;
};

export type ScheduleConfig = {
  timeZone: string;
  workDays: ReadonlySet<string>;
  startMinute: number;
  endMinute: number;
};

export type ScheduleDecision = {
  shouldDispatch: boolean;
  localTime: string;
  reason: "eligible" | "outside-work-days" | "outside-window";
};

export class GitHubDispatchError extends Error {
  constructor(readonly status: number) {
    super(`GitHub workflow dispatch failed with HTTP ${status}`);
    this.name = "GitHubDispatchError";
  }
}

export class ScheduleConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleConfigError";
  }
}

export class RepositoryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepositoryConfigError";
  }
}

function requireRepositoryValue(value: string | undefined, field: string): string {
  if (!value || value.trim() !== value || /[\r\n]/.test(value)) {
    throw new RepositoryConfigError(`${field} must be a non-empty value without whitespace padding`);
  }
  return value;
}

export function getGitHubRepository(env: Env): GitHubRepository {
  return {
    owner: requireRepositoryValue(env.GITHUB_OWNER, "GITHUB_OWNER"),
    repo: requireRepositoryValue(env.GITHUB_REPO, "GITHUB_REPO"),
    ref: requireRepositoryValue(env.GITHUB_REF, "GITHUB_REF"),
  };
}

function configUrl(repository: GitHubRepository): string {
  const { owner, repo, ref } = repository;
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/config.yml`;
}

function workflowDispatchUrl(repository: GitHubRepository): string {
  const { owner, repo } = repository;
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/capture.yml/dispatches`;
}

function parseClock(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
    throw new ScheduleConfigError(`${field} must use 24-hour HH:MM format`);
  }

  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function parseScheduleConfig(source: string): ScheduleConfig {
  const document = parse(source) as {
    schedule?: {
      timezone?: unknown;
      work_days?: unknown;
      work_hours?: { start?: unknown; end?: unknown };
    };
  };
  const schedule = document?.schedule;

  if (!schedule || typeof schedule.timezone !== "string") {
    throw new ScheduleConfigError("schedule.timezone is required");
  }

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone }).format();
  } catch {
    throw new ScheduleConfigError(`Invalid IANA timezone: ${schedule.timezone}`);
  }

  if (
    !Array.isArray(schedule.work_days) ||
    schedule.work_days.length === 0 ||
    schedule.work_days.some((day) => typeof day !== "string" || !WEEKDAYS.has(day))
  ) {
    throw new ScheduleConfigError(
      "schedule.work_days must contain one or more of Mon, Tue, Wed, Thu, Fri, Sat, Sun",
    );
  }

  const startMinute = parseClock(schedule.work_hours?.start, "schedule.work_hours.start");
  const endMinute = parseClock(schedule.work_hours?.end, "schedule.work_hours.end");
  if (endMinute < startMinute) {
    throw new ScheduleConfigError("Overnight capture windows are not supported");
  }

  return {
    timeZone: schedule.timezone,
    workDays: new Set(schedule.work_days),
    startMinute,
    endMinute,
  };
}

async function readConfigText(response: Response): Promise<string> {
  if (!response.body) {
    throw new ScheduleConfigError("config.yml response did not include a body");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let source = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    totalBytes += value.byteLength;
    if (totalBytes > MAX_CONFIG_BYTES) {
      await reader.cancel();
      throw new ScheduleConfigError("config.yml exceeds the 64 KiB safety limit");
    }
    source += decoder.decode(value, { stream: true });
  }

  return source + decoder.decode();
}

export async function loadScheduleConfig(
  repository: GitHubRepository,
  fetcher: typeof fetch = fetch,
): Promise<ScheduleConfig> {
  const response = await fetcher(configUrl(repository), {
    headers: {
      Accept: "text/plain",
      "User-Agent": "streamlapse-cloudflare-scheduler",
    },
  });

  if (!response.ok) {
    throw new ScheduleConfigError(`Could not load config.yml: HTTP ${response.status}`);
  }

  return parseScheduleConfig(await readConfigText(response));
}

export function getScheduleDecision(
  scheduledTime: number,
  schedule: ScheduleConfig,
): ScheduleDecision {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(scheduledTime)).map(({ type, value }) => [type, value]),
  );
  const weekday = parts.weekday;
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);

  if (!weekday || Number.isNaN(hour) || Number.isNaN(minute)) {
    throw new Error(`Could not determine the ${schedule.timeZone} schedule time`);
  }

  const localTime = `${weekday} ${parts.hour}:${parts.minute}`;
  if (!schedule.workDays.has(weekday)) {
    return { shouldDispatch: false, localTime, reason: "outside-work-days" };
  }

  const minuteOfDay = hour * 60 + minute;
  if (minuteOfDay < schedule.startMinute || minuteOfDay > schedule.endMinute) {
    return { shouldDispatch: false, localTime, reason: "outside-window" };
  }

  return { shouldDispatch: true, localTime, reason: "eligible" };
}

export async function dispatchCapture(
  githubToken: string,
  repository: GitHubRepository,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(workflowDispatchUrl(repository), {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "Content-Type": "application/json",
      "User-Agent": "streamlapse-cloudflare-scheduler",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    body: JSON.stringify({
      ref: repository.ref,
      inputs: { force: "true" },
    }),
  });

  if (!response.ok) {
    throw new GitHubDispatchError(response.status);
  }
}

export async function handleScheduled(
  controller: ScheduledController,
  env: Env,
  fetcher: typeof fetch = fetch,
): Promise<"dispatched" | "skipped"> {
  const repository = getGitHubRepository(env);
  const schedule = await loadScheduleConfig(repository, fetcher);
  const decision = getScheduleDecision(controller.scheduledTime, schedule);
  console.log(JSON.stringify({
    event: "schedule-evaluated",
    cron: controller.cron,
    scheduledTime: controller.scheduledTime,
    timeZone: schedule.timeZone,
    ...decision,
  }));

  if (!decision.shouldDispatch) {
    return "skipped";
  }

  if (!env.GITHUB_TOKEN) {
    controller.noRetry();
    throw new Error("GITHUB_TOKEN secret is not configured");
  }

  try {
    await dispatchCapture(env.GITHUB_TOKEN, repository, fetcher);
    console.log(JSON.stringify({
      event: "workflow-dispatched",
      scheduledTime: controller.scheduledTime,
      localTime: decision.localTime,
      repository: `${repository.owner}/${repository.repo}`,
      workflow: "capture.yml",
      ref: repository.ref,
      force: true,
    }));
    return "dispatched";
  } catch (error) {
    if (
      error instanceof GitHubDispatchError &&
      error.status >= 400 &&
      error.status < 500 &&
      error.status !== 408 &&
      error.status !== 429
    ) {
      controller.noRetry();
    }

    console.error(JSON.stringify({
      event: "workflow-dispatch-failed",
      scheduledTime: controller.scheduledTime,
      localTime: decision.localTime,
      error: error instanceof Error ? error.message : "Unknown error",
    }));
    throw error;
  }
}

export default {
  async scheduled(controller, env): Promise<void> {
    await handleScheduled(controller, env);
  },
} satisfies ExportedHandler<Env>;
