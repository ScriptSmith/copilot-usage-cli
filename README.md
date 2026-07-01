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

  Model              Dollar      AIC  Requests  Sessions  InputTokens  OutputTokens
  claude-opus-4.8    $31.04  3104.27       668        22        64.1M        401.5k
  gpt-5.5            $11.99  1198.63       372        15        23.4M        162.8k
  claude-sonnet-4.6   $3.00   300.22       104         6         6.2M         47.1k

By directory (this week)

  Directory      Dollar      AIC  Sessions  Repository
  ~/src/project  $28.93  2893.17        18  you/project
  ~/src/api      $12.74  1274.36         9  you/api
  ~/src/notes     $2.88   287.74         3  -
  ~               $1.48   147.85         1  -

By repository (this week)

  Repository   Dollar      AIC  Sessions  Branch
  you/project  $28.93  2893.17        18  3 branches
  you/api      $12.74  1274.36         9  main
  (no repo)     $4.36   435.59         4  (no branch)

By session (this week)

  Started           Dollar     AIC  UserMessages  AssistantMessages  TotalMessages  ToolCalls  Session
  2026-06-29 22:16   $4.87  486.91             9                 78             87         71  6907b511
  2026-06-28 14:52   $4.21  421.07             8                 71             79         64  a1f4d2c8
  2026-06-27 10:34   $3.88  388.42             7                 64             71         59  3b8e0f17
  2026-06-29 18:03   $3.42  341.55             6                 59             65         54  c7576694
  2026-06-26 16:20   $3.13  312.88             6                 53             59         47  dd9a45b8
  2026-06-25 09:11   $2.86  285.93             5                 48             53         44  2ae0945d
  2026-06-28 11:27   $2.64  264.19             5                 44             49         41  7d1e56fc
  2026-06-24 13:46   $2.33  233.47             4                 39             43         35  f66d60b1
  2026-06-29 12:23   $2.02  201.63             4                 33             37         29  bb5c3468
  2026-06-23 17:38   $1.78  178.42             3                 28             31         24  8b4726cc
  ... and 21 more
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
  --dimension <list>
                    Group by these dimensions: a comma-separated list of model,
                    directory, repository (also: all, none). When given, shows
                    only those grouping tables, with no totals or session list.
                    Text only; --json always has all three.
  --top <n>         Rows to show per table before "... and N more" (default 10;
                    0 = show all). Also opts into the detailed view. Piped
                    (non-TTY) output shows all rows unless set. Text only.
  --sort <list>     Order table rows by these measures: a comma-separated list of
                    aic, requests, sessions, input_tokens, output_tokens,
                    user_messages, assistant_messages, total_messages, tool_calls,
                    started (also: none). Each takes an optional :asc/:desc suffix
                    (default :desc); extra measures break ties. A measure a table
                    lacks is ignored for it. Also opts into the detailed view.
                    Text only; --json ordering is unchanged.
  --anomaly-days <n>
                    Warn about anomalies only when newer than n days
                    (default 3; 0 = never). Older ones stay in --json.
  --incomplete-days <n>
                    Treat incomplete sessions as recent only within n days
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
copilot-usage                                              # overview totals for every period
copilot-usage month                                        # this month, grouped, with its sessions
copilot-usage sessions                                     # every session that recorded usage
copilot-usage sessions week                                # sessions since Monday
copilot-usage session ca2c4401                             # detail (prefix is enough)
copilot-usage incomplete                                   # sessions whose usage was never recorded
copilot-usage today --dimension repository                 # only the by-repository grouping
copilot-usage week --dimension model --sort output_tokens  # models by output tokens
copilot-usage --top 25                                     # show up to 25 rows per table
copilot-usage --top 0                                      # show every row, no cap
copilot-usage --json                                       # JSON summary
copilot-usage sessions today --json                        # today's sessions as JSON
copilot-usage --rate 0.012                                 # different $/AIC
```

## Live usage (`--collector`)

On-disk totals only count closed sessions. With `--collector` the CLI also reads
live per-session usage from a local
[OTLP collector](https://github.com/ScriptSmith/copilot-usage/tree/main/collector)
and reconciles it by session id, so still-open sessions count before they exit and
any disagreements surface as `anomalies`. It needs Copilot exporting OpenTelemetry
to `http://127.0.0.1:4318`, and adds `*_aic_live`, `live_sessions`, and `anomalies`
fields to `--json`.

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
