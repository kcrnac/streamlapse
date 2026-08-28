const TIME_ZONE = "Europe/Zagreb";
const START_MINUTE = 6 * 60;
const END_MINUTE = 18 * 60;
const ALLOWED_WEEKDAYS = new Set(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);
const WORKFLOW_DISPATCH_URL =
  "https://api.github.com/repos/kcrnac/streamlapse/actions/workflows/capture.yml/dispatches";

export type ScheduleDecision = {
  shouldDispatch: boolean;
  localTime: string;
  reason: "eligible" | "outside-window" | "sunday";
};

export class GitHubDispatchError extends Error {
  constructor(readonly status: number) {
    super(`GitHub workflow dispatch failed with HTTP ${status}`);
    this.name = "GitHubDispatchError";
  }
}

export function getScheduleDecision(scheduledTime: number): ScheduleDecision {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
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
    throw new Error("Could not determine the Europe/Zagreb schedule time");
  }

  const localTime = `${weekday} ${parts.hour}:${parts.minute}`;
  if (!ALLOWED_WEEKDAYS.has(weekday)) {
    return { shouldDispatch: false, localTime, reason: "sunday" };
  }

  const minuteOfDay = hour * 60 + minute;
  if (minuteOfDay < START_MINUTE || minuteOfDay > END_MINUTE) {
    return { shouldDispatch: false, localTime, reason: "outside-window" };
  }

  return { shouldDispatch: true, localTime, reason: "eligible" };
}

export async function dispatchCapture(
  githubToken: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher(WORKFLOW_DISPATCH_URL, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${githubToken}`,
      "Content-Type": "application/json",
      "User-Agent": "streamlapse-cloudflare-scheduler",
      "X-GitHub-Api-Version": "2026-03-10",
    },
    body: JSON.stringify({
      ref: "main",
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
  const decision = getScheduleDecision(controller.scheduledTime);
  console.log(
    JSON.stringify({
      event: "schedule-evaluated",
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
      ...decision,
    }),
  );

  if (!decision.shouldDispatch) {
    return "skipped";
  }

  if (!env.GITHUB_TOKEN) {
    controller.noRetry();
    throw new Error("GITHUB_TOKEN secret is not configured");
  }

  try {
    await dispatchCapture(env.GITHUB_TOKEN, fetcher);
    console.log(
      JSON.stringify({
        event: "workflow-dispatched",
        scheduledTime: controller.scheduledTime,
        localTime: decision.localTime,
        repository: "kcrnac/streamlapse",
        workflow: "capture.yml",
        ref: "main",
        force: true,
      }),
    );
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

    console.error(
      JSON.stringify({
        event: "workflow-dispatch-failed",
        scheduledTime: controller.scheduledTime,
        localTime: decision.localTime,
        error: error instanceof Error ? error.message : "Unknown error",
      }),
    );
    throw error;
  }
}

export default {
  async scheduled(controller, env): Promise<void> {
    await handleScheduled(controller, env);
  },
} satisfies ExportedHandler<Env>;
