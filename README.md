# copilot-usage-cli

Report your **GitHub Copilot CLI** AIC usage from the session logs Copilot writes
locally. No API calls, no credentials, no dependencies.

```
$ copilot-usage
GitHub Copilot usage

  Period       Dollar       AIC  Sessions  UserMessages  AssistantMessages  TotalMessages
  Today         $9.92    992.36        16            42                166            208
  This week    $46.03   4603.12        31            88                803            891
  This month  $187.55  18754.86        89           295               2958           3253
  All time    $187.55  18754.86        89           295               2958           3253

By model (all time)

  Model              Dollar       AIC  Requests  Sessions  InputTokens  OutputTokens
  claude-opus-4.8   $144.37  14436.64      1676        44       158.0M          1.0M
  gpt-5.5            $77.74   7774.39      1338        33        71.2M        531.4k
  ...

Recent sessions

  Started           Dollar    AIC  UserMessages  AssistantMessages  TotalMessages  ToolCalls  Session
  2026-06-29 22:16   $0.03   3.35             1                  1              2          0  6907b511
  ...
```

(`copilot-usage week` narrows all of this to one period; see below.)

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
copilot-usage [period]           Summary: a totals table for every period, then
                                 that period (default all) grouped by model /
                                 directory / repository, then today's sessions
copilot-usage sessions [period]  One line per session in a period (default: all)
copilot-usage session <id>       Detail for one session (id prefix accepted)

  period is one of: today, week, month, all

Options:
  --json            Machine-readable JSON output
  --rate <n>        Dollars per AIC for cost display (default 0.01)
  --period <p>      Which period the summary groups by (default all). Same as the
                    positional period, e.g. `copilot-usage week`.
  --dimension <list> Which dimensions the summary groups by (default all):
                    a comma-separated list of model, directory, repository
                    (also: all, none). Text only; --json always has all three.
  --anomaly-days <n>    Warn about anomalies only when newer than n days
                        (default 3; 0 = never). Older ones stay in --json.
  --incomplete-days <n> Warn about incomplete sessions only when newer than n
                        days (default 7; 0 = never). Older ones stay in --json.
  --collector[=url] Merge live usage from a local OTLP collector and reconcile
                    by session id (default http://127.0.0.1:4318, or
                    $COPILOT_USAGE_COLLECTOR)
  --no-collector    Force on-disk data only
  -h, --help        Show help
  -v, --version     Show version
```

The summary is scoped to **one** period -- the one picked by the positional
period or `--period`, default all time (`copilot-usage week` is shorthand for
`--period week`). It shows a totals table (all four periods for the default all,
just the chosen period otherwise; columns Period, Dollar, AIC, Sessions,
UserMessages, AssistantMessages, TotalMessages), then that period grouped by
dimension, then that period's sessions (which add ToolCalls). Weeks start on
Monday; periods are bucketed by each session's start time. Long tables are capped
to the top 10 rows with a "... and N more" line.

The grouped tables (scoped to the chosen period) show where the spend went:

- **By model** -- AIC, requests, sessions, and input/output tokens per model
  (e.g. `claude-opus-4.8`, `gpt-5.5`), summed from each session's `modelMetrics`.
- **By directory** -- AIC and session count per working directory (the `cwd`
  Copilot was launched in), with the git repository it mapped to.
- **By repository** -- AIC and session count per git repository. Focus on this
  dimension (`--dimension repository`) to also get a per-branch split under each
  repo; otherwise the Branch column just shows the count or single branch.

The directory, repository, and branch come from each session's `session.start`
event (`data.context.cwd` / `repository` / `branch`).

Pick the period to group by with a positional period or `--period`, and which
dimensions with `--dimension` (a comma-separated list; order is preserved):

```bash
copilot-usage week                         # this week, grouped by all dimensions
copilot-usage week --dimension model       # this week, only by model
copilot-usage --dimension repository       # all time, with the per-branch split
copilot-usage --dimension none             # totals + sessions only, no grouping
```

Anomalies and incomplete sessions are *warned* about only while recent (3 days /
1 week by default); older ones are still reported but no longer flagged. Tune the
windows with `--anomaly-days` / `--incomplete-days` (`0` disables the warning).

Examples:

```bash
copilot-usage                       # summary, all time, + today's sessions
copilot-usage month                 # summary grouped by this month
copilot-usage sessions              # every session that recorded usage
copilot-usage sessions week         # sessions since Monday
copilot-usage session ca2c4401      # detail (prefix is enough)
copilot-usage --dimension model     # only the by-model grouping
copilot-usage --incomplete-days 0   # never warn about incomplete sessions
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
- A session that ends abnormally (crash, kill, reboot) never writes a shutdown
  event, and nothing is recorded incrementally beforehand, so its cost is
  unrecoverable. Such sessions are reported separately as **incomplete** (a count
  in the summary/sessions output and an `incomplete_count` field in the JSON);
  they are never added to totals.
- `--rate` only changes the dollar display; the underlying unit is AIC.

A small mtime/size cache under `${XDG_CACHE_HOME:-~/.cache}/copilot-usage-cli/`
makes repeat runs cheap (the first run reads every log; later runs only re-read
files that changed).

## Live usage (`--collector`)

On-disk totals only count *closed* sessions. With `--collector`, the CLI also
fetches live per-session usage from a local OTLP collector (the companion
`collector/` in this repo) and reconciles it with the on-disk data **by session
id**:

- A closed session's shutdown total is authoritative.
- An open session (no shutdown yet) has its live AIC added to the periods, so it
  counts *before* it exits. These appear in `live_sessions`, folded into each
  period's `sessions` list, and with `live:true` in `today_sessions`.
- If the collector and the shutdown total disagree for the same session, it is
  reported in `anomalies` (a `mismatch`); a collector session with no log on disk
  is an `orphan`. Each anomaly carries `start_ms` and a `recent` flag (within
  `--anomaly-days`); only recent ones are warned about.

Extra JSON fields when `--collector` is used: `collector{connected,url,session_count}`,
`today_aic_live` / `week_aic_live` / `month_aic_live` / `all_aic_live`,
`periods[].aic_live`, `periods[].live_session_count`, `live_aic`,
`live_session_count`, `live_sessions`, `anomalies` (each with `start_ms` /
`recent`), `anomaly_recent_count`. Without the flag the output
is unchanged. The collector requires
Copilot to be exporting OpenTelemetry
(`OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`); see the repo README for
setup.

## JSON output

`copilot-usage --json` (summary):

```json
{
  "today_aic": 992.36,
  "week_aic": 4603.12,
  "month_aic": 18754.86,
  "all_aic": 18754.86,
  "session_count": 89,
  "periods": [
    { "period": "today", "label": "Today", "aic": 992.36, "session_count": 16,
      "user_messages": 42, "assistant_messages": 166, "total_messages": 208, "tool_calls": 228,
      "models": [ ... ], "directories": [ ... ], "repositories": [ ... ], "sessions": [ ... ] }
  ],
  "models": [
    { "model": "claude-opus-4.8", "aic": 14408.37, "requests": 1675, "sessions": 43,
      "input_tokens": 157930856, "output_tokens": 1016060,
      "cache_read_tokens": 151261116, "cache_write_tokens": 6602881, "reasoning_tokens": 86086 }
  ],
  "directories": [
    { "dir": "/home/adam/src/transcription", "repo": "eresearchqut/transcription",
      "aic": 9394.38, "sessions": 49, "total_messages": 1586, "tool_calls": 1658 }
  ],
  "repositories": [
    { "repo": "eresearchqut/transcription", "aic": 11881.26, "sessions": 56,
      "total_messages": 1999, "tool_calls": 2322,
      "branches": [ { "branch": "dev", "aic": 2993.09, "sessions": 10 } ] }
  ],
  "today_sessions": [
    { "id": "6907b511-...", "aic": 3.34, "start_ms": 1782216998708,
      "cwd": "/home/adam/src/transcription", "repo": "eresearchqut/transcription", "branch": "dev",
      "user_messages": 1, "assistant_messages": 1, "total_messages": 2, "tool_calls": 0 }
  ],
  "incomplete_count": 2,
  "incomplete_recent_count": 1,
  "incomplete_sessions": [
    { "id": "2d3e4e84-...", "aic": 0, "start_ms": 1773791302265,
      "user_messages": 1, "assistant_messages": 3, "total_messages": 4, "tool_calls": 4,
      "incomplete": true, "recent": false }
  ]
}
```

Top-level `models` / `directories` / `repositories` are the **all-time**
groupings; each entry in `periods` also carries its own period-scoped copy of the
three, plus that period's `sessions` list. `incomplete_count` /
`incomplete_sessions` cover sessions with activity but no shutdown event (usage
never recorded); they are not included in `*_aic` totals. Each incomplete session
has a `recent` flag (within `--incomplete-days`), and `incomplete_recent_count`
is how many are recent -- only those are warned about; older ones are still
listed.

`copilot-usage sessions [period] --json` returns `{ period, session_count, totals, incomplete_count, sessions: [...] }`;
`copilot-usage session <id> --json` returns one session's detail including
per-model token counts.

This is the interface the companion Copilot Usage GNOME Shell extension consumes:
it runs `copilot-usage --json`, renders today/this-week in the top bar, and uses
each period's `sessions` / `models` / `directories` / `repositories` for the
per-period submenus.

## License

MIT
