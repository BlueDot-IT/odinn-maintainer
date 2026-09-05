import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflowDir = join(root, ".github", "workflows");
const actionDir = join(root, ".github", "actions");
const actionUse =
  /(?:^|[{\n,])\s*(?:-\s*)?(?:["']?uses["']?)\s*:\s*(?:"([^"]*)"|'([^']*)'|([^\s,}#]+))/gmu;

function stripYamlComments(text) {
  let result = "";
  let quote = null;
  let escaped = false;

  for (const character of text) {
    if (quote) {
      result += character;
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
      result += character;
    } else if (character === "#") {
      result += " ";
    } else {
      result += character;
      if (character === "\n") quote = null;
    }
  }

  return result;
}

function yamlFiles(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return yamlFiles(path);
    return /\.ya?ml$/u.test(entry.name) ? [path] : [];
  });
}

function actionReferences(text) {
  return [...stripYamlComments(text).matchAll(actionUse)].map((match) => ({
    reference: match[1] ?? match[2] ?? match[3],
  }));
}

function assertImmutableActionReferences(text, path = "fixture.yml") {
  for (const { reference } of actionReferences(text)) {
    if (reference.startsWith("./")) continue;
    assert.match(
      reference,
      /^[^/@\s]+\/[^@\s]+@[0-9a-f]{40}$/u,
      `${path} contains an unpinned or mutable action reference: ${reference}`
    );
  }
}

test("all external workflow and composite-action dependencies use immutable commit pins", () => {
  const files = [...yamlFiles(workflowDir), ...yamlFiles(actionDir)];
  assert.ok(files.length > 0, "expected checked-in workflow or action definitions");

  const references = files.flatMap((path) =>
    actionReferences(readFileSync(path, "utf8")).map(({ reference }) => ({ path, reference }))
  );

  assert.ok(references.length > 0, "expected at least one action dependency");
  for (const { path, reference } of references) {
    assertImmutableActionReferences(`uses: ${reference}\n`, path);
  }
});

test("action pinning detects flow-style and quoted YAML mappings", () => {
  const fixture = `
steps:
  - &mutable { uses: owner/action@mutable-tag }
  - { "uses": "owner/another-action@another-tag" }
`;

  assert.deepEqual(actionReferences(fixture).map(({ reference }) => reference), [
    "owner/action@mutable-tag",
    "owner/another-action@another-tag",
  ]);
  assert.throws(
    () => assertImmutableActionReferences(fixture),
    /contains an unpinned or mutable action reference/u
  );
});
