# copilot-usage-cli

Report your **GitHub Copilot CLI** AIC usage from the session logs Copilot writes
locally. No API calls, no credentials, no dependencies.

```
$ copilot-usage
GitHub Copilot usage

  Span         Dollar       AIC  Sessions  UserMessages  AssistantMessages  TotalMessages
  Today         $9.92    992.36        16            42                166            208
  This week    $46.03   4603.12        31            88                803            891
  This month  $187.55  18754.86        89           295               2958           3253
  All time    $187.55  18754.86        89           295               2958           3253

Today's sessions

  Started  Dollar     AIC  UserMessages  AssistantMessages  TotalMessages  ToolCalls  Session
  22:16     $0.03    3.35             1                  1              2          0  6907b511
  22:15     $0.08    7.65             1                  1              2          0  ca2c4401
  ...
```

## Install

```bash
npm install -g copilot-usage-cli
```

Or run without installing:

```bash
npx copilot-usage-cli
```

Requires Node >= 14.

## Usage

```
copilot-usage [summary]          Totals per span + today's sessions
copilot-usage sessions [span]    One line per session in a span (default: all)
copilot-usage session <id>       Detail for one session (id prefix accepted)

  span is one of: today, week, month, all

Options:
  --json            Machine-readable JSON output
  --rate <n>        Dollars per AIC for cost display (default 0.01)
  -h, --help        Show help
  -v, --version     Show version
```

The summary table columns are Span, Dollar, AIC, Sessions, UserMessages,
AssistantMessages, TotalMessages. The session tables additionally show ToolCalls.
Weeks start on Monday; spans are bucketed by each session's start time.

Examples:

```bash
copilot-usage                       # summary + today's sessions
copilot-usage sessions              # every session that recorded usage
copilot-usage sessions week         # sessions since Monday
copilot-usage session ca2c4401      # detail (prefix is enough)
copilot-usage --json                # JSON summary
copilot-usage sessions today --json
copilot-usage --rate 0.012          # different $/AIC
```

## How it works

GitHub Copilot CLI writes a per-session log to
`~/.copilot/session-state/<id>/events.jsonl` and appends a `session.shutdown`
event when the session closes. Usage is recorded there as nano-AIU at
`data.totalNanoAiu`:

```
AIC = totalNanoAiu / 1e9
```

- A resumed session writes another shutdown event for that segment; their AIC is
  additive, so all shutdown events in a file are summed.
- Sessions from before ~2026-06 predate nano-AIU tracking (only an unreliable
  `requests.cost` field exists) and are **excluded** from totals.
- Sessions still open have no shutdown event yet, so they don't appear until they
  exit.
- `--rate` only changes the dollar display; the underlying unit is AIC.

A small mtime/size cache under `${XDG_CACHE_HOME:-~/.cache}/copilot-usage-cli/`
makes repeat runs cheap (the first run reads every log; later runs only re-read
files that changed).

## JSON output

`copilot-usage --json` (summary):

```json
{
  "today_aic": 992.36,
  "week_aic": 4603.12,
  "month_aic": 18754.86,
  "all_aic": 18754.86,
  "session_count": 89,
  "spans": [
    { "span": "today", "label": "Today", "aic": 992.36, "sessions": 16,
      "user_messages": 42, "assistant_messages": 166, "total_messages": 208, "tool_calls": 228 }
  ],
  "today_sessions": [
    { "id": "6907b511-...", "aic": 3.34, "start_ms": 1782216998708,
      "user_messages": 1, "assistant_messages": 1, "total_messages": 2, "tool_calls": 0 }
  ]
}
```

`copilot-usage sessions [span] --json` returns `{ span, session_count, totals, sessions: [...] }`;
`copilot-usage session <id> --json` returns one session's detail including
per-model token counts.

This is the interface the companion Copilot Usage GNOME Shell extension consumes
(it runs `copilot-usage --json` and renders today/this-week in the top bar).

## License

MIT
