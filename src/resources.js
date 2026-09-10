// The bot's standing instructions.
//
// pi reads AGENTS.md from PI_AGENT_DIR into every session, so it is where the
// agent learns what it is — reached through a chat client rather than a
// terminal, one session per room, answers posted whole and never edited. That
// belongs in a context file rather than a command: "who are you" is a question
// people ask in ordinary conversation, and a `.whoami` would only have answered
// when someone knew to type it.
//
// PI_AGENT_DIR is under DATA_DIR and gitignored with the credentials, which is
// the right home for something belonging to one deployment but the wrong one
// for a description of the bot: that has to be true everywhere and be reviewed
// with the code it describes. So `agent/` at the repo root is source, installed
// on every start.
//
// Installed rather than symlinked because it makes the content portable. The
// agent runs in BOT_CWD, which is neither the repo nor DATA_DIR, so anything
// naming a path has to name an absolute one, and that path differs per host.
// `{{DATA_DIR}}` and friends are substituted as the file is written.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LogService } from "matrix-bot-sdk";

/** Where the shipped files live, regardless of the working directory. */
export const SHIPPED = fileURLToPath(new URL("../agent", import.meta.url));

/**
 * Optional sections of AGENTS.md, kept as markdown rather than as strings in
 * code. They are not installed on their own — `agent/*.md` is what ships —
 * and a caller pulls in the ones a deployment needs.
 */
export const PARTS = fileURLToPath(new URL("../agent/parts", import.meta.url));

/**
 * One optional section, filled in and ready to substitute into AGENTS.md.
 *
 * Filling here rather than letting the caller pass it through raw is what
 * makes a part's own `{{...}}` work: the main pass is a single replace, so a
 * placeholder arriving inside a substituted value would be left as written.
 */
export function renderPart(name, vars = {}) {
  return fillTemplate(readFileSync(join(PARTS, `${name}.md`), "utf8"), vars);
}

/**
 * The enabled parts, in the order given, as one block.
 *
 * Available is not enabled: everything in `agent/parts/` can be included, and
 * a deployment says which are. That list belongs in configuration where it can
 * be read, rather than in branches here.
 *
 * A named part that does not exist, or one whose placeholders resolve to
 * nothing, is logged rather than thrown — a bot missing a paragraph should
 * still answer — but logged loudly, because the failure is otherwise an
 * instruction the agent never sees and nobody misses.
 */
export function renderParts(names = [], vars = {}) {
  const out = [];
  for (const name of names) {
    let text;
    try {
      text = readFileSync(join(PARTS, `${name}.md`), "utf8");
    } catch {
      LogService.error("resources", `AGENTS.md part "${name}" is enabled but not in ${PARTS} — the agent will not be told what it says.`);
      continue;
    }
    for (const [, key] of text.matchAll(/\{\{(\w+)\}\}/g)) {
      if (!vars[key]) {
        LogService.warn("resources", `part "${name}" uses {{${key}}}, which is empty — is it enabled on a deployment that does not configure it?`);
      }
    }
    out.push(fillTemplate(text, vars));
  }
  return out.join("\n");
}

/**
 * Marks a file as the bot's to rewrite.
 *
 * AGENTS.md is also where an operator would put their own standing
 * instructions, and overwriting those would be theft. Only a file carrying this
 * line is replaced; anything else is left exactly as it is.
 *
 * The two cannot share a directory. pi takes the first of AGENTS.override.md,
 * AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD that exists there and ignores the
 * rest — so keeping someone's file means the bot's own instructions do not load
 * at all, which is why that case warns rather than passing quietly.
 */
export const MANAGED = "<!-- managed by piagent-matrix — edit agent/ in the repo, not this copy -->";

/** Replace `{{NAME}}` with `vars.NAME`. An unknown name is left alone. */
export function fillTemplate(text, vars = {}) {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : whole,
  );
}

/**
 * Install the shipped files into pi's agent directory.
 *
 * Failure is logged, not thrown: a bot that cannot write its context file still
 * answers messages, and refusing to start over one would be a poor trade.
 *
 * @param {string} agentDir  PI_AGENT_DIR
 * @param {Record<string, string>} vars  substituted into `{{NAME}}`
 * @param {string} from  the shipped files, overridable for tests
 * @returns {{ written: string[], skipped: string[], kept: string[], unresolved: string[] }}
 */
export function installAgentResources(agentDir, vars = {}, from = SHIPPED) {
  const written = [];
  const skipped = [];
  const kept = [];
  const unresolved = [];
  let shipped;
  try {
    shipped = readdirSync(from).filter((n) => n.endsWith(".md")).sort();
  } catch (err) {
    LogService.warn("bot", `Nothing to install from ${from}: ${err?.message ?? err}`);
    return { written, skipped, kept, unresolved };
  }

  const target = resolve(agentDir);
  for (const file of shipped) {
    const path = join(target, file);
    try {
      const body = fillTemplate(readFileSync(join(from, file), "utf8"), vars).replace(/^\s+/, "");
      // An unsubstituted placeholder reaches the agent verbatim and reads as a
      // path, so a typo would have it looking for a directory called
      // "{{DATA_DIR}}". Leaving it in beats blanking it, but not silently.
      for (const [, name] of body.matchAll(/\{\{(\w+)\}\}/g)) {
        if (!unresolved.includes(name)) unresolved.push(name);
        LogService.warn("bot", `${file} uses {{${name}}}, which nothing supplies — it ships as written.`);
      }
      const wanted = `${MANAGED}\n\n${body}`;
      let current = null;
      try {
        current = readFileSync(path, "utf8");
      } catch {
        /* not installed yet */
      }
      if (current !== null && !current.startsWith(MANAGED)) {
        kept.push(file);
        LogService.warn(
          "bot",
          `${path} was not written by this bot, so it is left alone — and the bot's own ${file} ` +
            "is therefore not installed, because pi reads only one context file per directory. " +
            "The bot then does not know what it is. Move those instructions to " +
            "$BOT_CWD/AGENTS.md, which pi loads as well, and delete this file.",
        );
        continue;
      }
      if (current === wanted) {
        skipped.push(file);
        continue;
      }
      mkdirSync(target, { recursive: true });
      writeFileSync(path, wanted);
      written.push(file);
    } catch (err) {
      LogService.warn("bot", `Could not install ${file}: ${err?.message ?? err}`);
    }
  }

  if (written.length) {
    LogService.info("bot", `Installed into ${target}: ${written.join(", ")}.`);
  }
  return { written, skipped, kept, unresolved };
}
