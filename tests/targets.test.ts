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
    { kind: "issue", number: 81 },
    { kind: "pull_request", number: 92 }
  ]);
});

test("scheduled discovery reserves capacity for both pulls and issues", async () => {
  const targets = await discoverTargets({
    eventName: "schedule",
    payload: {},
    api: {
      openPulls: async () => ({
        items: Array.from({ length: 50 }, (_, index) => ({ number: 1000 - index })),
        complete: true
      }),
      openIssues: async () => ({
        items: Array.from({ length: 50 }, (_, index) => ({ number: 500 - index })),
        complete: true
      })
    }
  });
  assert.equal(targets.length, 50);
  assert.equal(targets.filter((target) => target.kind === "pull_request").length, 25);
  assert.equal(targets.filter((target) => target.kind === "issue").length, 25);
});

test("scheduled discovery rotates through older targets across runs", async () => {
  const api = {
    openPulls: async () => ({
      items: Array.from({ length: 100 }, (_, index) => ({ number: 1000 - index })),
      complete: true
    }),
    openIssues: async () => ({
      items: Array.from({ length: 100 }, (_, index) => ({ number: 500 - index })),
      complete: true
    })
  };
  const first = await discoverTargets({
    eventName: "schedule",
    payload: {},
    api,
    rotation: 0
  });
  const second = await discoverTargets({
    eventName: "schedule",
    payload: {},
    api,
    rotation: 1
  });
  const firstKeys = new Set(first.map((target) => `${target.kind}:${target.number}`));
  assert.equal(second.some((target) => firstKeys.has(`${target.kind}:${target.number}`)), false);
});
