// What build is this, and how long has it been running.
//
// The version alone does not answer it. package.json is bumped once when a
// release opens, so every host between two releases reports the same number
// while running different code — which is exactly the question that keeps
// coming up: has this deployment actually been upgraded? The commit answers it,
// and is free to read from a checkout.

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repo root, regardless of the working directory. */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * Where git keeps its state for this checkout.
 *
 * Usually `<root>/.git`, but in a worktree or a submodule that path is a *file*
 * holding `gitdir: <somewhere else>` — so treating it as a directory reports no
 * commit for a checkout that plainly has one.
 */
function gitDir(root) {
  const path = join(root, ".git");
  if (statSync(path).isDirectory()) return path;
  const pointer = readFileSync(path, "utf8").trim();
  if (!pointer.startsWith("gitdir:")) throw new Error("not a gitdir pointer");
  const target = pointer.slice("gitdir:".length).trim();
  return isAbsolute(target) ? target : resolve(root, target);
}

/**
 * The checked-out commit, short form, or "" when it cannot be read.
 *
 * Read from the files rather than by running git: no subprocess at startup, and
 * nothing to fail slowly. A deployment without `.git` — a tarball, an image
 * built by copying — simply has no commit to report, which is honest.
 *
 * It says which commit is *checked out*, and nothing about whether the tree has
 * been edited since. See BUILD for the other half of that caveat.
 */
export function readCommit(root = ROOT) {
  try {
    const dir = gitDir(root);
    const head = readFileSync(join(dir, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return head.slice(0, 7);

    const ref = head.slice(4).trim();
    try {
      return readFileSync(join(dir, ref), "utf8").trim().slice(0, 7);
    } catch {
      // A ref that has been packed away has no file of its own. A worktree's
      // refs live in the main repository, one level up from its gitdir.
      for (const base of [dir, resolve(dir, "..", "..")]) {
        try {
          const packed = readFileSync(join(base, "packed-refs"), "utf8");
          const line = packed.split("\n").find((l) => l.endsWith(` ${ref}`));
          if (line) return line.slice(0, 7);
        } catch {
          /* try the next */
        }
      }
      return "";
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

/**
 * This process's build, read once at import.
 *
 * Frozen deliberately. Reading it per `.info` would report whatever is checked
 * out now, so a host pulled but not restarted would name the new commit while
 * running the old code — the one situation this exists to catch. What it still
 * cannot see is a tree edited in place: the commit is where the checkout is,
 * not proof that the files match it.
 */
export const BUILD = describeBuild();

/** "2h 14m", to the coarsest useful pair of units. */
function humaniseUptime(seconds) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${Math.floor(seconds)}s`;
}

/**
 * When this process started, and how long ago.
 *
 * Derived from process.uptime() rather than a timestamp taken at import, so it
 * is the process rather than this module — and it must be computed per call,
 * unlike BUILD, since the whole value is that it moves.
 *
 * The absolute time answers "did it restart when I restarted it"; the elapsed
 * answers "has it been up since" without the reader doing arithmetic.
 */
export function describeStart(now = Date.now(), uptimeSeconds = process.uptime()) {
  const started = new Date(now - uptimeSeconds * 1000);
  return `${started.toISOString().replace("T", " ").slice(0, 19)}Z (up ${humaniseUptime(uptimeSeconds)})`;
}
