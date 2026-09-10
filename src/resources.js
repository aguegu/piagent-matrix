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

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
 * Publish the shipped parts where an operator can see and edit them.
 *
 * Available has to be visible. Sections sealed inside the image are no use
 * to someone running one they did not build — they cannot read what they are
 * enabling, let alone copy it — so the shipped ones are written onto the data
 * volume beside any of their own.
 *
 * Each carries the managed marker, and a file without it is left alone: the
 * same bargain AGENTS.md makes. Edit one of ours and it stops being ours.
 */
export function publishParts(dir, from = PARTS) {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(from).filter((n) => n.endsWith(".md"))) {
    const target = join(dir, name);
    const wanted = `${MANAGED}\n\n${readFileSync(join(from, name), "utf8")}`;
    let current = null;
    try { current = readFileSync(target, "utf8"); } catch { /* new */ }
    if (current !== null && !current.startsWith(MANAGED)) {
      LogService.info("resources", `${target} is yours, not ours — left as it is.`);
      continue;
    }
    if (current !== wanted) writeFileSync(target, wanted);
  }
}

/**
 * The enabled parts, in directory order, as one block.
 *
 * Enabling is a filesystem act, as in nginx: everything available lives in
 * one directory, and a copy in `parts-enabled/` turns one on. Order is the
 * order the names sort in, which is why the seeded copies carry a numeric
 * prefix — `10-`, `20-` — leaving room to insert between them.
 *
 * An entry that resolves to nothing is logged rather than thrown, loudly: a
 * bot missing a paragraph should still answer, but the failure is otherwise
 * an instruction the agent never sees and nobody misses.
 */
export function enabledParts(enabledDir, vars = {}) {
  let entries;
  try {
    entries = readdirSync(enabledDir).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return "";
  }

  const out = [];
  for (const entry of entries) {
    let text;
    try {
      text = readFileSync(join(enabledDir, entry), "utf8");
    } catch (err) {
      LogService.error(
        "resources",
        `${join(enabledDir, entry)} is enabled but leads nowhere (${err?.code ?? err}) — the agent will not be told what it says.`,
      );
      continue;
    }
    // The marker is ours, not something to read out to the agent.
    if (text.startsWith(MANAGED)) text = text.slice(MANAGED.length).replace(/^\s*\n/, "");
    for (const [, key] of text.matchAll(/\{\{(\w+)\}\}/g)) {
      if (!vars[key]) {
        LogService.warn("resources", `${entry} uses {{${key}}}, which is empty — enabled on a deployment that does not configure it?`);
      }
    }
    out.push(fillTemplate(text, vars));
  }
  return out.join("\n");
}

/**
 * Turn on the named parts, once, by copying them — and never again.
 *
 * Copies rather than links. A link is cleverer and buys nothing here: the
 * same directory is read from the host and from inside a container, and a
 * copy is a file either way, on any filesystem, with nothing to dangle. It
 * also makes the enabled text the operator's outright — edit it in place, and
 * `parts/` still holds the shipped version to compare against or copy back.
 *
 * A deployment says what a fresh install starts with; after that the
 * directory is theirs, and an empty one means everything is off, which is a
 * choice rather than a mistake to correct on every boot.
 */
export function seedEnabled(enabledDir, availableDir, names = []) {
  if (existsSync(enabledDir)) return false;
  mkdirSync(enabledDir, { recursive: true });
  names.forEach((name, i) => {
    try {
      let text = readFileSync(join(availableDir, `${name}.md`), "utf8");
      // The marker says "the bot rewrites this". Nothing rewrites a copy in
      // here, so carrying it over would be a lie about who owns the file.
      if (text.startsWith(MANAGED)) text = text.slice(MANAGED.length).replace(/^\s*\n/, "");
      writeFileSync(join(enabledDir, `${(i + 1) * 10}-${name}.md`), text);
    } catch (err) {
      LogService.warn("resources", `could not enable ${name}: ${err?.message ?? err}`);
    }
  });
  LogService.info("resources", `Enabled ${names.join(", ") || "nothing"} in ${enabledDir}; it is yours from now on.`);
  return true;
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
