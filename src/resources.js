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
