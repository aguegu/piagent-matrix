// What build is this.
//
// The version alone does not answer it. package.json is bumped once when a
// release opens, so every host between two releases reports the same number
// while running different code — which is exactly the question that keeps
// coming up: has this deployment actually been upgraded? The commit answers it,
// and is free to read from a checkout.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repo root, regardless of the working directory. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * The checked-out commit, short form, or "" when it cannot be read.
 *
 * Read from the files rather than by running git: no subprocess at startup, and
 * nothing to fail slowly. A deployment without `.git` — a tarball, an image
 * built by copying — simply has no commit to report, which is honest.
 */
export function readCommit(root = ROOT) {
  try {
    const head = readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return head.slice(0, 7);

    const ref = head.slice(4).trim();
    try {
      return readFileSync(join(root, ".git", ref), "utf8").trim().slice(0, 7);
    } catch {
      // A ref that has been packed away has no file of its own.
      const packed = readFileSync(join(root, ".git", "packed-refs"), "utf8");
      const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
      return line ? line.slice(0, 7) : "";
    }
  } catch {
    return "";
  }
}

/** The declared version, or "" when package.json cannot be read. */
export function readVersion(root = ROOT) {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version ?? "";
  } catch {
    return "";
  }
}

/** One line naming the build: `piagent-matrix 0.2.2 (39bbb25)`. */
export function describeBuild(root = ROOT) {
  const version = readVersion(root);
  const commit = readCommit(root);
  return `piagent-matrix${version ? ` ${version}` : ""}${commit ? ` (${commit})` : ""}`;
}
