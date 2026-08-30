# Model providers

The bot reads pi's credentials from `PI_AGENT_DIR` (default `data/pi`), **not**
`~/.pi/agent`. A working interactive `pi` login on the same machine does not
carry over. Skip this and the bot starts, joins, and then fails on the first
message with `No models with complete auth are available in …`.

You do not need pi installed or logged in. Pick whichever fits:

**a. Log in** — stores the credential in `data/pi/auth.json`, pi's own store,
rather than in a project file. pi accepts a pasted API key, so this works on a
headless host; only OAuth providers need a browser:

```sh
PI_CODING_AGENT_DIR=./data/pi npx pi
# then inside pi:  /login <provider>
```

> **Note the variable.** `PI_CODING_AGENT_DIR` is pi's own; `PI_AGENT_DIR` is
> this bot's. The pi CLI ignores `PI_AGENT_DIR` and silently writes to its own
> default instead, which looks like success and leaves the bot finding nothing.
> An `auth.json` containing `{}` means exactly this — the file is created at
> startup, so its presence does not mean a login completed.
>
> Setting `PI_CODING_AGENT_DIR` also avoids having to know where that default
> is. It comes from `piConfig.configDir` in whichever pi build you are running —
> `~/.pi/agent` for the npm package, but a standalone install can differ (one
> reported `~/.config/pi`). Check with `command -v pi` and `npx pi --version` if
> you need to find an existing credential.

**b. An API key in the environment** — fewer steps, but it puts the key in a
file or your shell history rather than pi's credential store. `dotenv-flow` puts
it in the environment and pi picks it up, writing `data/pi/auth.json` on first
use:

```sh
echo 'ANTHROPIC_API_KEY=sk-ant-...' >> .env.local
```

Recognised keys include `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, `MINIMAX_API_KEY`, `MINIMAX_CN_API_KEY`,
`CEREBRAS_API_KEY`, `FIREWORKS_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`,
`XAI_API_KEY`.

**c. Reuse an existing login** on this machine — copy from wherever your pi
keeps it (see the note above; `~/.pi/agent` for the npm package):

```sh
mkdir -p data/pi && cp ~/.pi/agent/auth.json data/pi/
```

Check it worked before starting:

```sh
node -e "import('@earendil-works/pi-coding-agent').then(async m=>{
  const rt = await m.ModelRuntime.create({ authPath:'./data/pi/auth.json', modelsStorePath:'./data/pi/models-store.json' });
  const a = await rt.getAvailable();
  console.log(a.length ? 'available: '+a.map(x=>x.provider+'/'+x.id).join(', ') : 'NONE — see step 4');
})"
```

The bot starts on the first available. There is nothing to configure: say
**`.model <provider/id>`** in the main room to pick another, and the choice is
recorded under `DATA_DIR/agent.json` so it survives restarts.

**`/login` is the only step in the TUI the bot depends on.** pi's own `/model`
does not carry over — it records `defaultProvider` and `defaultModel` in
`data/pi/settings.json`, which the bot never reads, since `ModelRuntime` is
given `auth.json` and `models-store.json` and nothing else. Running it there is
harmless, just not what the bot picks up.

---

[← README](../README.md)
