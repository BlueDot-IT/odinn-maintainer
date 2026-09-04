import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const workflowDir = join(root, ".github", "workflows");
const actionDir = join(root, ".github", "actions");
const actionUse = /^\s*-?\s*uses:\s*([^\s#]+)\s*(?:#.*)?$/gmu;

function yamlFiles(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return yamlFiles(path);
    return /\.ya?ml$/u.test(entry.name) ? [path] : [];
  });
}

test("all external workflow and composite-action dependencies use immutable commit pins", () => {
  const files = [...yamlFiles(workflowDir), ...yamlFiles(actionDir)];
  assert.ok(files.length > 0, "expected checked-in workflow or action definitions");

  const references = [];
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(actionUse)) {
      references.push({ path, reference: match[1] });
    }
  }

  assert.ok(references.length > 0, "expected at least one action dependency");
  for (const { path, reference } of references) {
    if (reference.startsWith("./")) continue;
    assert.match(
      reference,
      /^[^/@\s]+\/[^@\s]+@[0-9a-f]{40}$/u,
      `${path} contains an unpinned or mutable action reference: ${reference}`
    );
  }
});
