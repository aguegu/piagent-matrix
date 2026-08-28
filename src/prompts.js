// Prompt templates that ship with the bot.
//
// pi reads templates from `${PI_AGENT_DIR}/prompts`, which lives under DATA_DIR
// and is gitignored along with the bot's credentials. That is the right home
// for a template belonging to one deployment — a working style, a checklist for
// whatever that host does — and those are left alone entirely.
//
// A template that describes *the bot itself* is different. It has to be true of
// every deployment, so it is source: kept in `prompts/` at the repo root,
// reviewed with the code it describes, and installed on every start.
//
// Installing rather than symlinking is what makes them portable: the agent runs
// in BOT_CWD, which is not the repo and not DATA_DIR, so a template that needs
// to name a path has to name an absolute one — and that path differs per host.
// `{{DATA_DIR}}` and friends are substituted as the file is written.

import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LogService } from "matrix-bot-sdk";

/** Where the shipped templates live, regardless of the working directory. */
export const SHIPPED_PROMPTS = fileURLToPath(new URL("../prompts", import.meta.url));

/** Replace `{{NAME}}` with `vars.NAME`. An unknown name is left alone. */
export function fillTemplate(text, vars = {}) {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name) =>
    Object.hasOwn(vars, name) ? String(vars[name]) : whole,
  );
}

/**
 * Copy the shipped templates into pi's prompts directory.
 *
 * Only files the repo ships are written, so a host's own templates are left
 * alone — they are not the bot's to manage. Files that already match are not
 * rewritten, which keeps the log quiet and mtimes stable across restarts.
 *
 * Failure is logged, not thrown: a bot that cannot install a prompt template
 * still answers messages, and refusing to start over one would be a poor trade.
 *
 * @param {string} agentDir  PI_AGENT_DIR
 * @param {Record<string, string>} vars  substituted into `{{NAME}}`
 * @param {string} from  the shipped templates, overridable for tests
 * @returns {{ written: string[], skipped: string[] }} names, without .md
 */
export function installPrompts(agentDir, vars = {}, from = SHIPPED_PROMPTS) {
  const written = [];
  const skipped = [];
  let shipped;
  try {
    shipped = readdirSync(from).filter((n) => n.endsWith(".md")).sort();
  } catch (err) {
    LogService.warn("bot", `No prompt templates to install from ${from}: ${err?.message ?? err}`);
    return { written, skipped };
  }

  const target = resolve(agentDir, "prompts");
  for (const file of shipped) {
    const name = file.replace(/\.md$/, "");
    try {
      const wanted = fillTemplate(readFileSync(join(from, file), "utf8"), vars);
      let current = null;
      try {
        current = readFileSync(join(target, file), "utf8");
      } catch {
        /* not installed yet */
      }
      if (current === wanted) {
        skipped.push(name);
        continue;
      }
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, file), wanted);
      written.push(name);
    } catch (err) {
      LogService.warn("bot", `Could not install prompt template ${file}: ${err?.message ?? err}`);
    }
  }

  if (written.length) {
    LogService.info("bot", `Installed prompt template(s) into ${target}: ${written.join(", ")}.`);
  }
  return { written, skipped };
}
