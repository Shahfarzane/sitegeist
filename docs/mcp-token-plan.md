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
3. **navigate and tabs_create return the page** (`cli/src/mcp.ts`, `src/bridge/tools.ts`).
   `read` defaults to true; `read:false` gives the summary alone. The saved `wait` and read
   are two turns per navigation.
4. **Reads in the same call wait for the page to settle** (`src/browser/page.ts`,
   `src/bridge/tools.ts`). A read that follows a navigation or a click in one call has no
   model latency in front of it, so a page that renders after DOMContentLoaded came back
   empty. `settle` polls from the worker (page timers are throttled in hidden tabs) until
   the load state, element count and text length hold still for about 600 ms (1.2 s while
   resources are still loading), 3 s at most.
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
- `scripts/e2e/bridge.e2e.mjs`: navigate and tabs_create return a page that renders late;
  `read:false`; click with `read`, also when a request brings the result; the cut-text
  note; dialogs in `actions`; the run_js hint.
- The same two tasks through the old and the new CLI with a real model, on the test browser.
- Measure `tools/list` again and record the numbers below.

## Outcome

| | Before | After |
| --- | --- | --- |
| `tools/list`, characters | 25,041 | 18,503 |
| of which schemas | 15,568 | 9,600 |
| of which descriptions | 7,412 | 6,862 |
| `instructions`, characters | 1,201 | 1,183 |
| input tokens per request, Claude Code with the tools loaded up front | 47,900 | 45,100 |

The last row is measured, not estimated: two tasks (two prices from product pages that
render late; a form whose confirmation arrives 500 ms after the click), each run twice
through the old and the new CLI with `claude -p` on Opus against the e2e browser. The
6,500 characters cut from the list are 2,800 tokens on every request, 6% of that
harness's context, which is mostly Claude Code's own prompt and the user's rules.

Calls did not drop on these tasks: 13 through the old CLI, 14 through the new one, the
extra one a `tabs_close` the model chose to make. Given only the server's instructions,
the model already called `navigate` with `read: true`. The wasted turns in the recorded
runs come from a harness brief that taught "navigate, then read_page" and from real pages
that are slower than a fixture, so that saving shows in the next recorded runs, as the
share of `navigate` calls followed by `wait` (86% before) and the calls per run (median 39).

A first version of the change was worse than the old CLI, 19 calls against 13, and the
two causes are fixed in what shipped. `tabs_create` returned a title while `navigate`
returned the page, so a second tab cost a `get_page_text`. And `settle` waited 300 ms,
shorter than the request behind the form, while the instructions said not to wait: the
model read "Working", then waited and read again. The window is now 600 ms and the
instructions say to end with a wait for the result's text.

What still limits it: `settle` sees the DOM and the load state, not a request in flight.
A page that holds still longer than the window while its data loads is read too early.
