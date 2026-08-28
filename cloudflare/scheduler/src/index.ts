export type GitHubRepository = {
  owner: string;
  repo: string;
  ref: string;
};

export type ScheduleConfig = {
  timeZone: string;
  startMinute: number;
  endMinute: number;
};

type ScheduleEnvironment = {
  SCHEDULE_TIME_ZONE?: string;
  SCHEDULE_START?: string;
  SCHEDULE_END?: string;
};

export type ScheduleDecision = {
  shouldDispatch: boolean;
  localTime: string;
};

export class GitHubDispatchError extends Error {
  constructor(readonly status: number) {
    super(`GitHub workflow dispatch failed with HTTP ${status}`);
    this.name = "GitHubDispatchError";
  }
}

function requireValue(value: string | undefined, field: string): string {
  if (!value || value.trim() !== value || /[\r\n]/.test(value)) {
    throw new Error(`${field} must be a non-empty value without whitespace padding`);
  }
  return value;
}

function parseClock(value: string | undefined, field: string): number {
  const clock = requireValue(value, field);
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(clock)) {
    throw new Error(`${field} must use 24-hour HH:MM format`);
  }

  const [hour, minute] = clock.split(":").map(Number);
  return hour * 60 + minute;
}

export function getGitHubRepository(env: Env): GitHubRepository {
  return {
    owner: requireValue(env.GITHUB_OWNER, "GITHUB_OWNER"),
    repo: requireValue(env.GITHUB_REPO, "GITHUB_REPO"),
    ref: requireValue(env.GITHUB_REF, "GITHUB_REF"),
  };
}

export function getScheduleConfig(env: ScheduleEnvironment): ScheduleConfig {
  const timeZone = requireValue(env.SCHEDULE_TIME_ZONE, "SCHEDULE_TIME_ZONE");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new Error(`SCHEDULE_TIME_ZONE is not a valid IANA timezone: ${timeZone}`);
  }

  const startMinute = parseClock(env.SCHEDULE_START, "SCHEDULE_START");
  const endMinute = parseClock(env.SCHEDULE_END, "SCHEDULE_END");
  if (endMinute < startMinute) {
    throw new Error("Overnight capture windows are not supported");
  }

  return { timeZone, startMinute, endMinute };
}

function workflowDispatchUrl(repository: GitHubRepository): string {
  const { owner, repo } = repository;
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/capture.yml/dispatches`;
}

export function getScheduleDecision(
  scheduledTime: number,
  schedule: ScheduleConfig,
): ScheduleDecision {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(scheduledTime)).map(({ type, value }) => [type, value]),
  );
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  if (Number.isNaN(hour) || Number.isNaN(minute)) {
    throw new Error(`Could not determine the ${schedule.timeZone} schedule time`);
  }

  const minuteOfDay = hour * 60 + minute;
  return {
    shouldDispatch: minuteOfDay >= schedule.startMinute && minuteOfDay <= schedule.endMinute,
    localTime: `${parts.hour}:${parts.minute}`,
  };
}

export async function dispatchCapture(
  githubToken: string,
  repository: GitHubRepository,
  timeZone: string,
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
      inputs: { timezone: timeZone },
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
  const schedule = getScheduleConfig(env);
  const decision = getScheduleDecision(controller.scheduledTime, schedule);
  console.log(JSON.stringify({
    event: decision.shouldDispatch ? "capture-eligible" : "capture-skipped",
    cron: controller.cron,
    scheduledTime: controller.scheduledTime,
    localTime: decision.localTime,
    timeZone: schedule.timeZone,
  }));

  if (!decision.shouldDispatch) {
    return "skipped";
  }

  if (!env.GITHUB_TOKEN) {
    controller.noRetry();
    throw new Error("GITHUB_TOKEN secret is not configured");
  }

  const repository = getGitHubRepository(env);
  try {
    await dispatchCapture(env.GITHUB_TOKEN, repository, schedule.timeZone, fetcher);
    console.log(JSON.stringify({
      event: "workflow-dispatched",
      scheduledTime: controller.scheduledTime,
      localTime: decision.localTime,
      repository: `${repository.owner}/${repository.repo}`,
      workflow: "capture.yml",
      ref: repository.ref,
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
