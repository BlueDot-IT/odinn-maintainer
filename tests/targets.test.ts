import assert from "node:assert/strict";
import test from "node:test";
import { discoverTargets } from "../.github/maintainer/targets.mjs";

test("direct and completed workflow events resolve bounded pull request targets", async () => {
  const api = {};
  assert.deepEqual(
    await discoverTargets({
      eventName: "pull_request_target",
      payload: { pull_request: { number: 92 } },
      api
    }),
    [{ kind: "pull_request", number: 92 }]
  );
  assert.deepEqual(
    await discoverTargets({
      eventName: "workflow_run",
      payload: {
        workflow_run: {
          conclusion: "success",
          pull_requests: [{ number: 92 }]
        }
      },
      api
    }),
    [{ kind: "pull_request", number: 92 }]
  );
  assert.deepEqual(
    await discoverTargets({
      eventName: "workflow_run",
      payload: {
        workflow_run: {
          conclusion: null,
          pull_requests: [{ number: 92 }]
        }
      },
      api
    }),
    []
  );
});

test("scheduled discovery reconciles open pulls and non-pull issues", async () => {
  const targets = await discoverTargets({
    eventName: "schedule",
    payload: {},
    api: {
      openPulls: async () => ({ items: [{ number: 93 }, { number: 92 }], complete: true }),
      openIssues: async () => ({
        items: [
          { number: 93, pull_request: {} },
          { number: 81 }
        ],
        complete: true
      })
    }
  });
  assert.deepEqual(targets, [
    { kind: "pull_request", number: 93 },
    { kind: "pull_request", number: 92 },
    { kind: "issue", number: 81 }
  ]);
});
