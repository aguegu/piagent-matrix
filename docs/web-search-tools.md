# Web search tools

## Where they come from

`web_search`, `source_check`, `fetch_content` and `get_search_content` come from
**[`pi-web-access`](https://github.com/nicobailon/pi-web-access)**, a separate
npm package loaded as a pi extension. They are **not** part of
`@earendil-works/pi-coding-agent`.

Verified: none of those four tool names appears anywhere in the pi-coding-agent
package, and all four appear in `pi-web-access`.

The tools pi-coding-agent actually ships are the coding ones — `bash`, `read`,
`write`, `edit`, `grep`, `find`, `ls`, `powershell`. Nothing web-facing.

## How it is installed here

```sh
PI_CODING_AGENT_DIR=./data/pi npx pi install npm:pi-web-access
```

That does two things:

| | |
| --- | --- |
| Adds `"npm:pi-web-access"` to `packages` | `data/pi/settings.json` |
| Installs the package | `data/pi/npm/node_modules/pi-web-access` |

Restart the bot afterwards — sessions are created once per room and cached for
the process lifetime, so a running bot keeps the extension set it started with.
On the next session the bot logs what loaded:

```
[agent] Extensions loaded: pi-web-access
```

Note `PI_CODING_AGENT_DIR` is pi's own variable. This project's `PI_AGENT_DIR`
points at the same directory but the pi CLI ignores it.

## Configuration

`pi-web-access@0.25.0` supports many providers — Brave, Exa, Tavily, Firecrawl,
Jina, Kagi, SearXNG, Perplexity, Gemini, Ollama and others — and reads a
per-provider API key from the environment, for example:

```
BRAVE_API_KEY, EXA_API_KEY, TAVILY_API_KEY, FIRECRAWL_API_KEY,
JINA_API_KEY, KAGI_API_KEY, ANYSEARCH_API_KEY, BRIGHTDATA_API_KEY, …
```

The bot inherits its environment from `dotenv-flow`, so a key in `.env.local` is
visible to the extension. Weigh that against the note in `SECURITY.md` about
keeping credentials in pi's own store rather than a project file.

Without a configured provider the tools load but have nothing to query.

## Uninstalling

```sh
PI_CODING_AGENT_DIR=./data/pi npx pi remove npm:pi-web-access
```

Then restart the bot.

---

An earlier version of this document claimed these tools were built into
pi-coding-agent and bundled in `dist/bundle/chunks/chunk-NUHFSC37.js`. That
chunk exists but contains none of them; the claim did not survive checking.
