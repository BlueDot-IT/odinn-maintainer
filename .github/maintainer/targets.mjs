import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { GitHubApi } from "./core.mjs";

const MAX_TARGETS = 50;

async function output(name, value) {
  if (!process.env.GITHUB_OUTPUT) return;
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `${name}=${String(value).replace(/%/gu, "%25").replace(/\r/gu, "%0D").replace(/\n/gu, "%0A")}\n`
  );
}

function directTarget(eventName, payload) {
  if (["pull_request_target", "pull_request_review", "pull_request_review_comment"].includes(eventName)) {
    return payload.pull_request?.number
      ? [{ kind: "pull_request", number: Number(payload.pull_request.number) }]
      : [];
  }
  if (["issues", "issue_comment"].includes(eventName) && payload.issue?.number) {
    return [{
      kind: payload.issue.pull_request ? "pull_request" : "issue",
      number: Number(payload.issue.number)
    }];
  }
  if (eventName === "workflow_dispatch" && payload.inputs?.number) {
    return [{
      kind: payload.inputs.kind === "issue" ? "issue" : "pull_request",
      number: Number(payload.inputs.number)
    }];
  }
  if (eventName === "workflow_run") {
    if (
      payload.workflow_run?.conclusion !== "success" &&
      payload.workflow_run?.conclusion !== "failure" &&
      payload.workflow_run?.conclusion !== "cancelled"
    ) return [];
    return (payload.workflow_run?.pull_requests || [])
      .map((pull) => ({ kind: "pull_request", number: Number(pull.number) }))
      .filter((target) => Number.isInteger(target.number) && target.number > 0);
  }
  return [];
}

export async function discoverTargets({
  eventName,
  payload,
  api,
  includeIssues = true,
  rotation = 0
}) {
  if (eventName !== "schedule") {
    return directTarget(eventName, payload).slice(0, MAX_TARGETS);
  }
  const [pulls, issues] = await Promise.all([
    api.openPulls(),
    includeIssues ? api.openIssues() : Promise.resolve({ items: [], complete: true })
  ]);
  const pullTargets = pulls.items.map((pull) => ({
    kind: "pull_request",
    number: Number(pull.number)
  }));
  const issueTargets = issues.items
    .filter((issue) => !issue.pull_request)
    .map((issue) => ({ kind: "issue", number: Number(issue.number) }));
  const rotate = (items) => {
    if (items.length === 0) return items;
    const offset = (Math.abs(Number(rotation) || 0) * Math.ceil(MAX_TARGETS / 2)) % items.length;
    return items.slice(offset).concat(items.slice(0, offset));
  };
  const rotatedPulls = rotate(pullTargets);
  const rotatedIssues = rotate(issueTargets);
  const targets = [];
  while (
    targets.length < MAX_TARGETS &&
    (rotatedPulls.length > 0 || rotatedIssues.length > 0)
  ) {
    if (rotatedPulls.length > 0) targets.push(rotatedPulls.shift());
    if (targets.length < MAX_TARGETS && rotatedIssues.length > 0) {
      targets.push(rotatedIssues.shift());
    }
  }
  return targets
    .filter((target) => Number.isInteger(target.number) && target.number > 0)
    .slice(0, MAX_TARGETS);
}

async function main() {
  const payload = process.env.GITHUB_EVENT_PATH
    ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"))
    : {};
  const api = new GitHubApi({
    token: process.env.GITHUB_READ_TOKEN,
    repository: process.env.GITHUB_REPOSITORY
  });
  const targets = await discoverTargets({
    eventName: process.env.GITHUB_EVENT_NAME || "",
    payload,
    api,
    includeIssues: process.env.ODINN_MAINTAINER_INCLUDE_ISSUES !== "false",
    rotation: process.env.GITHUB_RUN_NUMBER
  });
  await output("targets", JSON.stringify(targets));
  await output("count", targets.length);
  console.log(JSON.stringify({ ok: true, targets }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`Odinn Maintainer discovery failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
