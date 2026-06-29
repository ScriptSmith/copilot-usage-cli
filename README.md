# copilot-usage-cli

Report your GitHub Copilot CLI AIC usage from the session logs Copilot writes
locally.

```
$ copilot-usage
GitHub Copilot usage

  Period       Dollar       AIC  Sessions  UserMessages  AssistantMessages  TotalMessages
  Today         $9.92    992.36        16            42                166            208
  This week    $46.03   4603.12        31            88                803            891
  This month  $187.55  18754.86        89           295               2958           3253
  All time    $187.55  18754.86        89           295               2958           3253

Showing totals only. Run `copilot-usage <period>` (today, week, month, all)
for a breakdown by model, directory and repository, plus that period's sessions.
Run `copilot-usage incomplete` for sessions whose usage was never recorded.
```

The bare command prints just the totals. Name a period to scope everything below
the totals to that period:

```
$ copilot-usage week
GitHub Copilot usage

  Period     Dollar      AIC  Sessions  UserMessages  AssistantMessages  TotalMessages
  This week  $46.03  4603.12        31            88                803            891

By model (this week)

  Model              Dollar       AIC  Requests  Sessions  InputTokens  OutputTokens
  claude-opus-4.8   $144.37  14436.64      1676        44       158.0M          1.0M
  gpt-5.5            $77.74   7774.39      1338        33        71.2M        531.4k
  ...

By session (this week)

  Started           Dollar     AIC  UserMessages  AssistantMessages  TotalMessages  ToolCalls  Session
  2026-06-29 22:16   $1.52  151.66             7                 24             31         22  6907b511
  ...
```

Or jump straight to one grouping with `--dimension` (see below).

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
copilot-usage                    Overview: a totals table for every period
copilot-usage <period>           That period grouped by model / directory /
                                 repository, plus its sessions
copilot-usage sessions [period]  One line per session in a period (default: all)
copilot-usage session <id>       Detail for one session (id prefix accepted)
copilot-usage incomplete [period]
                                 Sessions with no shutdown event (usage never
                                 recorded, so excluded from every total)

  period is one of: today, week, month, all

Options:
  --json            Machine-readable JSON output
  --rate <n>        Dollars per AIC for cost display (default 0.01)
  --period <p>      Which period the summary covers (default all). Same as the
                    positional period, e.g. `copilot-usage week`.
  --dimension <list> Group by these dimensions: a comma-separated list of model,
                    directory, repository (also: all, none). When given, shows
                    only those grouping tables, with no totals or session list.
                    Text only; --json always has all three.
  --top <n>         Rows to show per table before "... and N more" (default 10;
                    0 = show all). Also opts into the detailed view. Piped
                    (non-TTY) output shows all rows unless set. Text only.
  --anomaly-days <n>    Warn about anomalies only when newer than n days
                        (default 3; 0 = never). Older ones stay in --json.
  --incomplete-days <n> Treat incomplete sessions as recent only within n days
                        (default 7; 0 = never). Affects the `recent` flag in --json.
  --collector[=url] Merge live usage from a local OTLP collector and reconcile
                    by session id (default http://127.0.0.1:4318, or
                    $COPILOT_USAGE_COLLECTOR)
  --no-collector    Force on-disk data only
  -h, --help        Show help
  -v, --version     Show version
```

The grouped tables (scoped to the chosen period) show where the spend went:

- By model: AIC, requests, sessions, and input/output tokens per model
  (e.g. `claude-opus-4.8`, `gpt-5.5`), summed from each session's `modelMetrics`.
- By directory: AIC and session count per working directory (the `cwd` Copilot
  was launched in), with the git repository it mapped to.
- By repository: AIC and session count per git repository. Focus on this
  dimension (`--dimension repository`) to also get a per-branch split under each
  repo; otherwise the Branch column just shows the count or single branch.
- By session: one row per session, ranked by dollar/AIC spend.

`--dimension` jumps straight to one or more groupings with nothing else around
them, which is handy for a focused look or for piping. It implies a period via the
positional/`--period` (default all time); the list is comma-separated and order is
preserved:

```bash
copilot-usage today --dimension repository   # today, only the by-repo split
copilot-usage --dimension model              # all time, only the by-model table
copilot-usage --dimension model,directory    # both, in that order, nothing else
```

Examples:

```bash
copilot-usage                       # overview totals for every period
copilot-usage month                 # this month, grouped, with its sessions
copilot-usage sessions              # every session that recorded usage
copilot-usage sessions week         # sessions since Monday
copilot-usage session ca2c4401      # detail (prefix is enough)
copilot-usage incomplete            # sessions whose usage was never recorded
copilot-usage today --dimension repository   # only the by-repository grouping
copilot-usage --top 25              # show up to 25 rows per table
copilot-usage --top 0               # show every row, no cap
copilot-usage --json                # JSON summary
copilot-usage sessions today --json
copilot-usage --rate 0.012          # different $/AIC
```

## Live usage (`--collector`)

On-disk totals only count closed sessions. With `--collector`, the CLI also
fetches live per-session usage from a local OTLP collector and reconciles it with
the on-disk data by session id:

- A closed session's shutdown total is authoritative.
- An open session (no shutdown yet) has its live AIC added to the periods, so it
  counts before it exits. These appear in `live_sessions`, folded into each
  period's `sessions` list, and with `live:true` in `today_sessions`.
- If the collector and the shutdown total disagree for the same session, it is
  reported in `anomalies` (a `mismatch`); a collector session with no log on disk
  is an `orphan`. Each anomaly carries `start_ms` and a `recent` flag (within
  `--anomaly-days`); only recent ones are warned about.

Extra JSON fields when `--collector` is used: `collector{connected,url,session_count}`,
`today_aic_live` / `week_aic_live` / `month_aic_live` / `all_aic_live`,
`periods[].aic_live`, `periods[].live_session_count`, `live_aic`,
`live_session_count`, `live_sessions`, `anomalies` (each with `start_ms` /
`recent`), `anomaly_recent_count`. Without the flag the output is unchanged. The
collector requires Copilot to be exporting OpenTelemetry
(`OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318`).

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
    { "dir": "/home/you/src/project", "repo": "you/project",
      "aic": 9394.38, "sessions": 49, "total_messages": 1586, "tool_calls": 1658 }
  ],
  "repositories": [
    { "repo": "you/project", "aic": 11881.26, "sessions": 56,
      "total_messages": 1999, "tool_calls": 2322,
      "branches": [ { "branch": "dev", "aic": 2993.09, "sessions": 10 } ] }
  ],
  "today_sessions": [
    { "id": "6907b511-...", "aic": 3.34, "start_ms": 1782216998708,
      "cwd": "/home/you/src/project", "repo": "you/project", "branch": "dev",
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

Top-level `models` / `directories` / `repositories` are the all-time groupings;
each entry in `periods` also carries its own period-scoped copy of the three, plus
that period's `sessions` list. `incomplete_count` / `incomplete_sessions` cover
sessions with activity but no shutdown event (usage never recorded); they are not
included in `*_aic` totals. Each incomplete session has a `recent` flag (within
`--incomplete-days`), and `incomplete_recent_count` is how many are recent.

`copilot-usage sessions [period] --json` returns `{ period, session_count, totals, incomplete_count, sessions: [...] }`;
`copilot-usage incomplete [period] --json` returns `{ period, incomplete_count, sessions: [...] }`;
`copilot-usage session <id> --json` returns one session's detail including
per-model token counts.

See the GNOME extension: [ScriptSmith/copilot-usage](https://github.com/ScriptSmith/copilot-usage)

## License

MIT
