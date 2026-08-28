import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCommand, helpText, mayCommand, COMMANDS } from "../src/commands.js";

describe("command parsing", () => {
  it("accepts both prefixes", () => {
    // Element intercepts a leading "/" for its own commands, so "." is the
    // reliable form; "/" is honoured for clients that pass it through.
    assert.deepEqual(parseCommand("/verify"), { name: "verify", args: "" });
    assert.deepEqual(parseCommand(".verify"), { name: "verify", args: "" });
  });

  it("carries arguments through", () => {
    assert.deepEqual(parseCommand("/verify the outbox claim"), {
      name: "verify",
      args: "the outbox claim",
    });
  });

  it("is case-insensitive and tolerates leading space", () => {
    assert.equal(parseCommand("  /Verify")?.name, "verify");
    assert.equal(parseCommand("/RELOAD")?.name, "reload");
  });

  it("ignores anything not on the allowlist", () => {
    // Deliberately not a passthrough: unknown commands are ordinary prompts.
    for (const text of ["/login anthropic", "/compact", "/export", ".foo"]) {
      assert.equal(parseCommand(text), null, `${text} must not be treated as a command`);
    }
  });

  it("keeps a subcommand and its target as arguments", () => {
    // `.rooms leave !x:y` is one command with two words of argument, not a
    // command called "rooms leave".
    assert.deepEqual(parseCommand(".rooms leave !abc:example.org"), {
      name: "rooms",
      args: "leave !abc:example.org",
    });
    assert.deepEqual(parseCommand(".rooms leave all confirm"), { name: "rooms", args: "leave all confirm" });
    assert.deepEqual(parseCommand(".rooms"), { name: "rooms", args: "" });
  });

  it("does not eat a message that merely begins with a slash", () => {
    assert.equal(parseCommand("/home/agu/notes.md — have a look"), null);
    assert.equal(parseCommand("/verifying something by hand"), null, "needs a word boundary");
    assert.equal(parseCommand("look at ./verify.md"), null, "only at the start");
  });

  it("returns null for non-strings and empty input", () => {
    for (const v of [undefined, null, "", 42, {}]) {
      assert.equal(parseCommand(v), null);
    }
  });
});

describe("which room may run a command", () => {
  const MAIN = "!main:example.org";
  const WORK = "!work:example.org";

  it("gives the main room everything", () => {
    for (const name of Object.keys(COMMANDS)) {
      assert.equal(mayCommand(name, MAIN, MAIN), true, `${name} should work in the main room`);
    }
  });

  it("gives a working room .info and nothing else", () => {
    // Every other command either reconfigures the bot for all rooms or hands a
    // chat message the agent's own reach; both belong in the control channel.
    assert.equal(mayCommand("info", WORK, MAIN), true);
    for (const name of Object.keys(COMMANDS).filter((n) => n !== "info")) {
      assert.equal(mayCommand(name, WORK, MAIN), false, `${name} must not work in a working room`);
    }
  });

  it("allows everything when no main room is established", () => {
    // Nothing to defer to — refusing here would leave the bot with one usable
    // command on a deployment that never recorded one.
    for (const none of ["", undefined, null]) {
      assert.equal(mayCommand("model", WORK, none), true);
    }
  });

  it("does not treat an unknown name as allowed everywhere", () => {
    assert.equal(mayCommand("nonesuch", WORK, MAIN), false);
  });
});

describe("help output", () => {
  it("lists every command with the dot prefix", () => {
    // Main room only, so it lists the lot.
    const text = helpText();
    for (const name of Object.keys(COMMANDS)) {
      assert.match(text, new RegExp(`\`\\.${name}\``), `${name} should be listed`);
    }
  });

  it("never advertises the slash form", () => {
    // Element intercepts a leading "/", so telling someone to type /help sends
    // them to Element's help instead of the bot.
    const text = helpText({ prompts: ["verify"], skills: ["review"] });
    assert.doesNotMatch(text, /`\/(info|verify|reload|model|thinking|help)/, "no /command in the help output");
  });

  it("names the installed prompts and skills when there are any", () => {
    const text = helpText({ prompts: ["verify"], skills: ["review"] });
    assert.match(text, /`verify`/);
    assert.match(text, /`\/skill:review`/);
  });

  it("omits those sections when nothing is installed", () => {
    const text = helpText({ prompts: [], skills: [] });
    assert.doesNotMatch(text, /Prompt templates installed/);
    assert.doesNotMatch(text, /Skills installed/);
  });
});
