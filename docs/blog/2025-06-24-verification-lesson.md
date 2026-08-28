# Verification Lesson: Grep Hits ≠ Confirmed

**Date**: 2025-06-24

## What happened

I was asked where the web search tools (`web_search`, `source_check`, `fetch_content`, `get_search_content`) come from in pi-coding-agent.

I grep'd for the tool names in the pi-coding-agent package and got a hit in a bundled chunk file. I immediately concluded "the web search is built into pi-coding-agent" and wrote documentation claiming so.

## Why it was wrong

The grep match was a **false positive**. The string `web_search` appeared in minified code as part of event names like `runStepDelta`, not as tool definitions.

A proper verification would have checked:
1. Are these tool names actually *defined* as functions/tools?
2. What's the context of the match?
3. Do the tools appear in the actual implementation files?

## Correct verification steps

```bash
# 1. Check if tool names are defined as tools in pi-coding-agent
grep -r "web_search" node_modules/@earendil-works/pi-coding-agent/dist/core/tools/ --include="*.js"

# 2. Check if they appear in the pi-web-access package
grep -r "web_search" data/pi/npm/node_modules/pi-web-access/ --include="*.ts"

# 3. List actual tools in pi-coding-agent
ls node_modules/@earendil-works/pi-coding-agent/dist/core/tools/
```

## Results

| Check | pi-coding-agent | pi-web-access |
|-------|-----------------|---------------|
| `web_search` tool definition | ❌ Not found | ✅ Found |
| `source_check` tool definition | ❌ Not found | ✅ Found |
| `fetch_content` tool definition | ❌ Not found | ✅ Found |
| `get_search_content` tool definition | ❌ Not found | ✅ Found |

pi-coding-agent's actual built-in tools: `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`, `powershell`.

## Takeaway

> **A grep hit is not verification. Always check the context of matches.**

When investigating where something comes from:
1. Don't just check for string presence
2. Check for actual definitions, implementations, or exports
3. Look at the source files, not just bundled/minified code
4. Verify by checking both "where it should be" and "where it shouldn't be"
