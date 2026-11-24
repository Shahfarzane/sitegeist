# MCP token efficiency

Goal: a run through `sitegeist mcp` spends fewer tokens for the same result. Three costs
were measured before anything was changed.

## What was measured

**The tool list** (`tools/list`, 38 tools): 25,041 characters, 15,568 of them schemas and
7,412 descriptions. Of the schemas, 6,075 characters carried no information: the JSON
Schema draft URL on every tool (38 x 56), safe-integer bounds on every integer (47 x 53)
and one sentence about `tabId` repeated 28 times.

**Results.** Read from 58 recorded harness runs (3,488 tool calls):

| Tool | Calls | Share of result text |
| --- | --- | --- |
| read_page | 134 | 24% |
| run_js | 624 | 21% |
| get_page_text | 277 | 20% |
| read_network | 57 | 11% |
| actions | 165 | 8% |
| navigate | 440 | 6% |

Result text came to 1,975,399 characters plus 379 screenshots. A median run is 39 calls
and 26,446 characters of results.

**Turns.** Every call is a model turn that reads the whole conversation again, so a turn
costs more than most results. The recorded sequences show where turns are wasted:

- `navigate` was followed by `wait` 379 times out of 440, a fixed sleep with a median of
  3 seconds, and the wait by `get_page_text` (235), `run_js` (166) or `read_page` (120).
  Three turns for what `navigate` with `read` does in one; `read` was passed 70 times.
- `click` was followed by `wait` 146 times and by `screenshot` 57 times.
- `run_js` failed 42 times on a syntax error because the code was statements
  (`const x = ...`, a top-level `return`); nothing said it has to be one expression.

`wait` is 641 calls, 18% of all turns, and 585 of them are fixed sleeps.

## Changes

1. **Schemas** (`cli/src/tool-schema.ts`, `cli/src/mcp.ts`). Drop the draft URL and the
   safe-integer bounds from what zod emits; shorten the shared parameter descriptions.
2. **Descriptions and instructions** (`cli/src/mcp.ts`). Say each thing once, lead with
   what the tool is for, and state the one-call patterns the sequences show are missed.
3. **navigate returns the page** (`cli/src/mcp.ts`). `read` defaults to true; `read:false`
   gives the summary alone. The saved `wait` and read are two turns per navigation.
4. **Reads in the same call wait for the page to settle** (`src/browser/page.ts`,
   `src/bridge/tools.ts`). A read that follows a navigation or a click in one call has no
   model latency in front of it, so a page that renders after DOMContentLoaded came back
   empty. `settle` polls from the worker (page timers are throttled in hidden tabs) until
   the element count and text length hold still, 2.5 s at most.
5. **click takes `read`** (`cli/src/mcp.ts`). Runs as a one-step `actions` call, so the
   page after the click comes back with it.
6. **Cut text says so** (`src/browser/page.ts`, `cli/src/mcp.ts`). `read_page` cut the text
   at 3,000 characters without a word; the snapshot now carries the full length and the
   result names it, so the model asks for the rest only when there is a rest.
7. **run_js says what it takes** (`cli/src/mcp.ts`). The description names the expression
   rule and a syntax error comes back with the IIFE form.

Not changed: tool names and count (prompts written for them carry over), result shapes of
the other tools, screenshot size (1280 px wide is about 1,400 tokens, the cheap end).

## Checks

- `cli/src/tool-schema.test.ts`: the pruning, and a budget on the live `tools/list` so
  boilerplate cannot come back unnoticed.
- `scripts/e2e/bridge.e2e.mjs`: navigate returns a page that renders late; `read:false`;
  click with `read`; the cut-text note; the run_js hint.
- Measure `tools/list` again and record the numbers below.

## Outcome

| | Before | After |
| --- | --- | --- |
| `tools/list`, characters | 25,041 | 18,183 |
| of which schemas | 15,568 | 9,419 |
| of which descriptions | 7,412 | 6,723 |
| `instructions`, characters | 1,201 | 1,080 |

At roughly four characters a token that is about 1,700 tokens off a list that every
harness without deferred tool loading sends on every turn.

The turn savings are not measured yet: they show in the next recorded runs, as the share
of `navigate` calls followed by `wait` (86% before) and the calls per run (median 39).
What limits them: `settle` sees the DOM and the load state, not a request still in flight,
so a page that holds still for a second while its data loads is read too early, and the
model waits as before.
