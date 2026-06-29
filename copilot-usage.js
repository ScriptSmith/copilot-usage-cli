#!/usr/bin/env node
'use strict';

/*
 * copilot-usage -- report GitHub Copilot CLI AIC usage from local session logs.
 *
 * GitHub Copilot CLI writes a per-session events.jsonl to
 *   ~/.copilot/session-state/<id>/events.jsonl
 * and appends a `session.shutdown` event when the session closes. That event
 * records usage as nano-AIU at data.totalNanoAiu (== the sum of the per-model
 * modelMetrics.<model>.totalNanoAiu):
 *
 *   AIC = totalNanoAiu / 1e9
 *
 * A session that is resumed writes another shutdown event for that segment, so
 * a file may contain several; their AIC is additive and we sum them.
 *
 * Message and tool-call counts come from user.message / assistant.message /
 * tool.execution_start events in the same log.
 *
 * Sessions from before ~2026-06 predate nano-AIU tracking (only the unreliable
 * modelMetrics.<model>.requests.cost field exists) and are excluded from totals.
 *
 * No dependencies; Node >= 14. A small mtime/size cache keeps repeat runs cheap.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const VERSION = '1.2.0'; // keep in sync with package.json
const DEFAULT_COLLECTOR = process.env.COPILOT_USAGE_COLLECTOR || 'http://127.0.0.1:4318';
const NANO_PER_AIC = 1e9;
const DEFAULT_RATE = 0.01; // dollars per AIC
const SESSION_DIR = path.join(os.homedir(), '.copilot', 'session-state');

const CACHE_VERSION = 4; // bump when the cached session shape changes
const CACHE_DIR = path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
    'copilot-usage-cli');
const CACHE_FILE = path.join(CACHE_DIR, 'cache.json');

// The time buckets usage is reported over.
const PERIODS = ['today', 'week', 'month', 'all'];
const PERIOD_LABELS = { today: 'Today', week: 'This week', month: 'This month', all: 'All time' };

// The dimensions usage can be grouped by, and the aliases the --dimension flag
// accepts for each. DIMENSIONS is the canonical render order.
const DIMENSIONS = ['model', 'directory', 'repository'];
const DIMENSION_ALIASES = {
    model: 'model', models: 'model',
    directory: 'directory', directories: 'directory', dir: 'directory', dirs: 'directory',
    repository: 'repository', repositories: 'repository', repo: 'repository', repos: 'repository',
};

// Aging: anomalies / incomplete sessions older than these (days) are still
// reported (in JSON, and the extension submenus) but no longer *warned* about --
// stale crashes and old reconciliation blips shouldn't nag forever. Configurable
// via --anomaly-days / --incomplete-days.
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ANOMALY_DAYS = 3;
const DEFAULT_INCOMPLETE_DAYS = 7;
const DEFAULT_TOP = 10; // rows shown per summary table before "... and N more"

// Within the warning window? Items with no known timestamp are surfaced (warned)
// while aging is on; a window of 0 disables warnings entirely.
function isRecent(startMs, now, days) {
    if (!(days > 0)) return false;
    if (!startMs) return true;
    return (now.getTime() - startMs) <= days * DAY_MS;
}

// --------------------------------------------------------------------------
// Cache: maps events.jsonl path -> { sig, session }
// --------------------------------------------------------------------------

function loadCache() {
    try {
        const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
        if (c.version === CACHE_VERSION) return c.files || {};
    } catch (e) { /* missing or stale */ }
    return {};
}

function saveCache(files) {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        const tmp = CACHE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, files }));
        fs.renameSync(tmp, CACHE_FILE);
    } catch (e) { /* cache is best-effort */ }
}

// --------------------------------------------------------------------------
// Parsing
// --------------------------------------------------------------------------

function eventAic(data) {
    let nano = data.totalNanoAiu || 0;
    if (!nano) {
        for (const m of Object.values(data.modelMetrics || {})) {
            nano += (m && m.totalNanoAiu) || 0;
        }
    }
    return nano ? nano / NANO_PER_AIC : 0;
}

// Single pass over a session log. Counts message/tool events by cheap substring
// match and JSON-parses only the (rare) session.start / shutdown lines.
function parseFile(file) {
    const result = {
        shutdowns: [], userMessages: 0, assistantMessages: 0, toolCalls: 0,
        startMs: null, cwd: null, repo: null, branch: null,
    };
    let content;
    try {
        content = fs.readFileSync(file, 'utf8');
    } catch (e) {
        return result;
    }
    let start = 0;
    while (start < content.length) {
        let nl = content.indexOf('\n', start);
        if (nl === -1) nl = content.length;
        const line = content.slice(start, nl);
        start = nl + 1;
        if (line.indexOf('"type":"user.message"') !== -1) result.userMessages++;
        else if (line.indexOf('"type":"assistant.message"') !== -1) result.assistantMessages++;
        else if (line.indexOf('"type":"tool.execution_start"') !== -1) result.toolCalls++;
        else if (result.startMs === null && line.indexOf('"type":"session.start"') !== -1) {
            // session.start carries an ISO startTime; the only reliable date for a
            // session that never wrote a shutdown event (sessionStartTime lives there).
            // Its data.context is also the only place the working directory, git
            // repository, and branch the session ran in are recorded.
            let e;
            try { e = JSON.parse(line); } catch (err) { continue; }
            if (e && e.type === 'session.start' && e.data) {
                if (e.data.startTime) {
                    const ms = Date.parse(e.data.startTime);
                    if (!isNaN(ms)) result.startMs = ms;
                }
                const ctx = e.data.context;
                if (ctx) {
                    if (ctx.cwd) result.cwd = ctx.cwd;
                    if (ctx.repository) result.repo = ctx.repository;
                    if (ctx.branch) result.branch = ctx.branch;
                }
            }
        }
        else if (line.indexOf('session.shutdown') !== -1) {
            let e;
            try { e = JSON.parse(line); } catch (err) { continue; }
            if (e && e.type === 'session.shutdown') result.shutdowns.push(e.data || {});
        }
    }
    return result;
}

// Build a session summary from a parsed log.
function summarizeSession(id, parsed) {
    let aic = 0;
    let premium = 0;
    let startMs = null;
    const models = {};
    for (const d of parsed.shutdowns) {
        aic += eventAic(d);
        premium += d.totalPremiumRequests || 0;
        if (!startMs && d.sessionStartTime) startMs = d.sessionStartTime;
        for (const [name, m] of Object.entries(d.modelMetrics || {})) {
            const e = models[name] || (models[name] = {
                requests: 0, aic: 0,
                inputTokens: 0, outputTokens: 0,
                cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
            });
            e.requests += (m.requests && m.requests.count) || 0;
            e.aic += (m.totalNanoAiu || 0) / NANO_PER_AIC;
            const u = m.usage || {};
            e.inputTokens += u.inputTokens || 0;
            e.outputTokens += u.outputTokens || 0;
            e.cacheReadTokens += u.cacheReadTokens || 0;
            e.cacheWriteTokens += u.cacheWriteTokens || 0;
            e.reasoningTokens += u.reasoningTokens || 0;
        }
    }
    const totalMessages = parsed.userMessages + parsed.assistantMessages;
    // Activity but no shutdown event => usage was never recorded. The session is
    // either still running or ended abnormally (crash, kill, reboot); either way
    // its AIC is not in the log, so it's excluded from totals and flagged instead.
    const incomplete = parsed.shutdowns.length === 0 && totalMessages > 0;
    return {
        id,
        aic,
        start_ms: startMs || parsed.startMs || null,
        premium_requests: premium,
        user_messages: parsed.userMessages,
        assistant_messages: parsed.assistantMessages,
        total_messages: totalMessages,
        tool_calls: parsed.toolCalls,
        cwd: parsed.cwd || null,
        repo: parsed.repo || null,
        branch: parsed.branch || null,
        models,
        has_nano_aiu: aic > 0,
        incomplete,
    };
}

// Scan all sessions. Returns { sessions: [...], incomplete: [...], error? }.
// `sessions` are those with recorded usage; `incomplete` are sessions that have
// activity but no shutdown event (usage never recorded), reported separately.
// `includeZero` keeps sessions with no nano-AIU data (used for `session <id>`).
function collect(includeZero) {
    const cache = loadCache();
    const next = {};
    const sessions = [];
    const incomplete = [];
    let entries;
    try {
        entries = fs.readdirSync(SESSION_DIR, { withFileTypes: true });
    } catch (e) {
        return { sessions, incomplete, error: `cannot read ${SESSION_DIR}: ${e.message}` };
    }

    for (const ent of entries) {
        if (!ent.isDirectory()) continue;
        const file = path.join(SESSION_DIR, ent.name, 'events.jsonl');
        let st;
        try {
            st = fs.statSync(file);
        } catch (e) {
            continue;
        }
        const sig = `${Math.floor(st.mtimeMs)}:${st.size}`;
        const cached = cache[file];
        const session = (cached && cached.sig === sig)
            ? cached.session
            : summarizeSession(ent.name, parseFile(file));
        next[file] = { sig, session };
        if (session.incomplete) incomplete.push(session);
        if (!includeZero && session.aic <= 0) continue;
        sessions.push(session);
    }

    saveCache(next);
    return { sessions, incomplete };
}

// --------------------------------------------------------------------------
// Periods
// --------------------------------------------------------------------------

function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function periodStart(period, now) {
    if (period === 'today') return startOfDay(now);
    if (period === 'week') {
        const off = (now.getDay() + 6) % 7; // Mon=0 .. Sun=6
        return new Date(now.getFullYear(), now.getMonth(), now.getDate() - off).getTime();
    }
    if (period === 'month') return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    return 0; // all
}

function inPeriod(startMs, period, now) {
    if (period === 'all') return true;
    if (!startMs) return false;
    return startOfDay(new Date(startMs)) >= periodStart(period, now);
}

function aggregate(sessions, period, now) {
    let aic = 0, count = 0, user = 0, asst = 0, tools = 0;
    for (const s of sessions) {
        if (!inPeriod(s.start_ms, period, now)) continue;
        aic += s.aic;
        count++;
        user += s.user_messages;
        asst += s.assistant_messages;
        tools += s.tool_calls;
    }
    return {
        period,
        label: PERIOD_LABELS[period],
        aic,
        session_count: count,
        user_messages: user,
        assistant_messages: asst,
        total_messages: user + asst,
        tool_calls: tools,
    };
}

// --------------------------------------------------------------------------
// Dimensions (group usage by model / directory / repository)
// --------------------------------------------------------------------------

// Usage grouped by model across the sessions in a period. Folds each session's
// per-model metrics (from its shutdown events) into a global map. Sorted by AIC
// descending.
function aggregateModels(sessions, period, now) {
    const map = new Map();
    for (const s of sessions) {
        if (!inPeriod(s.start_ms, period, now)) continue;
        for (const [name, m] of Object.entries(s.models || {})) {
            let e = map.get(name);
            if (!e) {
                e = {
                    model: name, aic: 0, requests: 0, sessions: 0,
                    input_tokens: 0, output_tokens: 0,
                    cache_read_tokens: 0, cache_write_tokens: 0, reasoning_tokens: 0,
                };
                map.set(name, e);
            }
            e.aic += m.aic;
            e.requests += m.requests;
            e.sessions += 1;
            e.input_tokens += m.inputTokens;
            e.output_tokens += m.outputTokens;
            e.cache_read_tokens += m.cacheReadTokens;
            e.cache_write_tokens += m.cacheWriteTokens;
            e.reasoning_tokens += m.reasoningTokens;
        }
    }
    return [...map.values()].sort((a, b) => b.aic - a.aic);
}

// Usage grouped by working directory (the session's cwd). Sessions with no
// recorded cwd are grouped under "(unknown)". Each entry notes the repository the
// directory mapped to (if any), for context. Sorted by AIC descending.
function aggregateDirs(sessions, period, now) {
    const map = new Map();
    for (const s of sessions) {
        if (!inPeriod(s.start_ms, period, now)) continue;
        const dir = s.cwd || '(unknown)';
        let e = map.get(dir);
        if (!e) {
            e = { dir, repo: s.repo || null, aic: 0, sessions: 0, total_messages: 0, tool_calls: 0 };
            map.set(dir, e);
        }
        e.aic += s.aic;
        e.sessions += 1;
        e.total_messages += s.total_messages;
        e.tool_calls += s.tool_calls;
        if (!e.repo && s.repo) e.repo = s.repo;
    }
    return [...map.values()].sort((a, b) => b.aic - a.aic);
}

// Usage grouped by git repository, with a nested per-branch split. Sessions
// outside a repository are grouped under "(no repo)". Sorted by AIC descending,
// as are the branches within each repository.
function aggregateRepos(sessions, period, now) {
    const map = new Map();
    for (const s of sessions) {
        if (!inPeriod(s.start_ms, period, now)) continue;
        const repo = s.repo || '(no repo)';
        let e = map.get(repo);
        if (!e) {
            e = { repo, aic: 0, sessions: 0, total_messages: 0, tool_calls: 0, _branches: new Map() };
            map.set(repo, e);
        }
        e.aic += s.aic;
        e.sessions += 1;
        e.total_messages += s.total_messages;
        e.tool_calls += s.tool_calls;
        const branch = s.branch || '(no branch)';
        let b = e._branches.get(branch);
        if (!b) { b = { branch, aic: 0, sessions: 0 }; e._branches.set(branch, b); }
        b.aic += s.aic;
        b.sessions += 1;
    }
    return [...map.values()]
        .map(e => {
            const branches = [...e._branches.values()].sort((a, b) => b.aic - a.aic);
            delete e._branches;
            return { ...e, branches };
        })
        .sort((a, b) => b.aic - a.aic);
}

// Drop the per-model breakdown from a session for the list/summary JSON;
// `session <id>` is where the model detail lives.
function leanSession(s) {
    const { models, ...rest } = s;
    return rest;
}

function summarize(sessions, incomplete, now, incompleteDays) {
    const periods = PERIODS.map(p => aggregate(sessions, p, now));
    const byPeriod = {};
    for (const p of periods) byPeriod[p.period] = p;
    // Attach the by-model / by-directory / by-repository dimensions and the
    // session list to each period.
    for (const p of periods) {
        p.models = aggregateModels(sessions, p.period, now);
        p.directories = aggregateDirs(sessions, p.period, now);
        p.repositories = aggregateRepos(sessions, p.period, now);
        p.sessions = sessions
            .filter(s => inPeriod(s.start_ms, p.period, now))
            .sort((a, b) => (b.start_ms || 0) - (a.start_ms || 0))
            .map(leanSession);
    }
    // Tag each incomplete session as recent (warn) or old (show, don't warn).
    const incompleteSessions = incomplete
        .slice()
        .sort((a, b) => (b.start_ms || 0) - (a.start_ms || 0))
        .map(s => ({ ...leanSession(s), recent: isRecent(s.start_ms, now, incompleteDays) }));
    return {
        today_aic: byPeriod.today.aic,
        week_aic: byPeriod.week.aic,
        month_aic: byPeriod.month.aic,
        all_aic: byPeriod.all.aic,
        session_count: sessions.length,
        periods,
        // All-time dimensions surfaced at the top level for convenience; each
        // period in `periods` carries its own scoped copy (plus its sessions).
        models: byPeriod.all.models,
        directories: byPeriod.all.directories,
        repositories: byPeriod.all.repositories,
        today_sessions: byPeriod.today.sessions,
        incomplete_count: incomplete.length,
        incomplete_recent_count: incompleteSessions.filter(s => s.recent).length,
        incomplete_sessions: incompleteSessions,
    };
}

// --------------------------------------------------------------------------
// Collector (live OTLP usage) + reconciliation
// --------------------------------------------------------------------------

const round2 = n => Math.round(n * 100) / 100;

// GET <url>/sessions from the local collector. Resolves to the parsed object
// (with `_url` attached) or null on any error/timeout -- the collector is
// always optional, so a failure must degrade gracefully to log-only data.
function fetchCollector(url, timeoutMs) {
    return new Promise(resolve => {
        let done = false;
        const finish = v => { if (!done) { done = true; resolve(v); } };
        try {
            const u = new URL('/sessions', url);
            const req = http.get(u, { timeout: timeoutMs }, res => {
                if (res.statusCode !== 200) { res.resume(); return finish(null); }
                let data = '';
                res.setEncoding('utf8');
                res.on('data', d => { data += d; });
                res.on('end', () => {
                    try { const j = JSON.parse(data); j._url = url; finish(j); }
                    catch (e) { finish(null); }
                });
            });
            req.on('timeout', () => { req.destroy(); finish(null); });
            req.on('error', () => finish(null));
        } catch (e) { finish(null); }
    });
}

// Merge live collector usage into a summary, reconciling by session id.
//   - a session with a shutdown event: its billed AIC is authoritative; if the
//     collector's live total disagrees beyond tolerance, that's an anomaly.
//   - a session the collector knows but has no shutdown yet: it's live/open, so
//     its usage is added to the per-period totals (this is the whole point) and
//     folded into each period's session list.
//   - a session with activity today but no shutdown and no collector data: its
//     usage is genuinely uncounted -> anomaly.
// Adds: collector{}, live_aic, live_session_count, live_sessions, anomalies,
// and *_aic_live / period.aic_live / period.live_session_count fields. Without a
// collector, only sets collector.connected = false and leaves the rest untouched.
function reconcile(sum, sessions, incomplete, collector, now, anomalyDays) {
    if (!collector) { sum.collector = { connected: false }; return sum; }

    const TOL_ABS = 0.05;  // AIC
    const TOL_REL = 0.02;  // 2%
    const shutdownById = new Map(sessions.map(s => [s.id, s]));
    const incompleteIds = new Set(incomplete.map(s => s.id));
    const collectorSessions = collector.sessions || [];
    const anomalies = [];
    const liveSessions = [];

    for (const c of collectorSessions) {
        const sd = shutdownById.get(c.id);
        if (sd) {
            const diff = c.aic - sd.aic;
            const rel = sd.aic ? Math.abs(diff) / sd.aic : (c.aic ? 1 : 0);
            if (Math.abs(diff) > TOL_ABS && rel > TOL_REL) {
                anomalies.push({
                    type: 'mismatch', id: c.id, start_ms: sd.start_ms || null,
                    shutdown_aic: round2(sd.aic), collector_aic: round2(c.aic),
                    diff: round2(diff),
                });
            }
            continue;
        }
        // No shutdown yet => live/open session; count its live usage.
        liveSessions.push({
            id: c.id,
            aic: c.aic,
            start_ms: c.first_ms || null,
            premium_requests: Math.round(c.cost || 0),
            user_messages: 0, assistant_messages: 0, total_messages: 0,
            tool_calls: 0,
            live: true,
            running: !!c.running,
            source: 'collector',
            recovered_incomplete: incompleteIds.has(c.id),
        });
        if (!fs.existsSync(path.join(SESSION_DIR, c.id))) {
            anomalies.push({ type: 'orphan', id: c.id, start_ms: c.first_ms || null, collector_aic: round2(c.aic) });
        }
    }

    // Fold live usage into each period's totals and session list.
    const liveByPeriod = {};
    for (const period of PERIODS) {
        let aic = 0, count = 0;
        for (const ls of liveSessions) {
            if (inPeriod(ls.start_ms, period, now)) { aic += ls.aic; count++; }
        }
        liveByPeriod[period] = { aic, count };
    }
    for (const sp of sum.periods) {
        sp.aic_live = sp.aic + liveByPeriod[sp.period].aic;
        sp.live_session_count = liveByPeriod[sp.period].count;
        const liveInPeriod = liveSessions
            .filter(ls => inPeriod(ls.start_ms, sp.period, now))
            .map(leanSession);
        if (liveInPeriod.length) {
            sp.sessions = sp.sessions
                .concat(liveInPeriod)
                .sort((a, b) => (b.start_ms || 0) - (a.start_ms || 0));
        }
    }
    sum.today_aic_live = sum.today_aic + liveByPeriod.today.aic;
    sum.week_aic_live = sum.week_aic + liveByPeriod.week.aic;
    sum.month_aic_live = sum.month_aic + liveByPeriod.month.aic;
    sum.all_aic_live = sum.all_aic + liveByPeriod.all.aic;

    // Keep the top-level today_sessions in sync with the live-merged today period.
    const todayPeriod = sum.periods.find(p => p.period === 'today');
    if (todayPeriod) sum.today_sessions = todayPeriod.sessions;

    sum.collector = {
        connected: true,
        url: collector._url,
        session_count: collectorSessions.length,
    };
    sum.live_aic = liveByPeriod.all.aic;
    sum.live_session_count = liveSessions.length;
    sum.live_sessions = liveSessions.map(leanSession);
    // Tag each anomaly recent (warn) or old (show, don't warn).
    for (const a of anomalies) a.recent = isRecent(a.start_ms, now, anomalyDays);
    sum.anomalies = anomalies;
    sum.anomaly_recent_count = anomalies.filter(a => a.recent).length;
    return sum;
}

// --------------------------------------------------------------------------
// Formatting helpers
// --------------------------------------------------------------------------

const pad2 = n => String(n).padStart(2, '0');

function usd(aic, rate) {
    return '$' + (aic * rate).toFixed(2);
}

function fmtDateTime(ms) {
    if (!ms) return '-';
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
           `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtClock(ms) {
    if (!ms) return '-';
    const d = new Date(ms);
    return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function fmtTokens(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
    return String(n);
}

function pad(s, w) {
    s = String(s);
    return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

function padLeft(s, w) {
    s = String(s);
    return s.length >= w ? s : ' '.repeat(w - s.length) + s;
}

// Middle-truncate s to width w with a single ellipsis, keeping both ends (so a
// path keeps its ~ and its leaf). A no-op when it already fits.
function elide(s, w) {
    s = String(s);
    if (s.length <= w) return s;
    if (w <= 1) return s.slice(0, Math.max(0, w));
    const keep = w - 1; // room for the ellipsis
    const head = Math.ceil(keep / 2);
    const tail = keep - head;
    return s.slice(0, head) + '…' + (tail ? s.slice(s.length - tail) : '');
}

const INDENT = '  ';

// Human-facing line printer that collapses leading and consecutive blank lines.
// Each section can lead with a blank separator without doubling up where two meet
// (or appearing above the first one). JSON, warnings and errors bypass this.
let _lastBlank = true; // start "blank" so the very first line never gets a leader
function out(line) {
    if (!line) {
        if (_lastBlank) return;
        _lastBlank = true;
        console.log('');
    } else {
        _lastBlank = false;
        console.log(line);
    }
}

// headers: string[], rows: (string|number)[][], aligns: ('l'|'r')[]
// maxWidth (default: the TTY width) caps the rendered line length: when the
// natural table is too wide, the widest left-aligned column is shrunk and its
// cells middle-elided. Right-aligned (numeric) columns and headers are never
// truncated. Undefined/non-finite (e.g. piped output) means render at full width.
function renderTable(headers, rows, aligns, maxWidth = process.stdout.columns) {
    const ncols = headers.length;
    const widths = headers.map((h, i) =>
        Math.max(String(h).length, ...rows.map(r => String(r[i]).length)));
    if (maxWidth && isFinite(maxWidth)) {
        const floorFor = i => Math.max(8, String(headers[i]).length);
        const sep = 2 * Math.max(0, ncols - 1);
        const lineWidth = () => INDENT.length + widths.reduce((a, b) => a + b, 0) + sep;
        let over = lineWidth() - maxWidth;
        // Trim a column at a time off the currently-widest shrinkable left-aligned
        // column, so several wide text columns converge toward equal width rather
        // than one being crushed to its floor while another stays long.
        while (over > 0) {
            let idx = -1, best = -1;
            for (let i = 0; i < ncols; i++) {
                if (aligns[i] === 'r' || widths[i] <= floorFor(i)) continue;
                if (widths[i] > best) { best = widths[i]; idx = i; }
            }
            if (idx === -1) break;
            widths[idx] -= 1;
            over -= 1;
        }
    }
    const fit = (c, i) => {
        const s = elide(c, widths[i]);
        return aligns[i] === 'r' ? padLeft(s, widths[i]) : pad(s, widths[i]);
    };
    const fmtRow = cells => (INDENT + cells.map((c, i) => fit(c, i)).join('  ')).replace(/\s+$/, '');
    return [fmtRow(headers), ...rows.map(r => fmtRow(r))].join('\n');
}

// Footnote summarising live collector data and any reconciliation anomalies.
function printCollectorNote(sum) {
    const c = sum.collector;
    if (!c || !c.connected) return;
    out('');
    if (sum.live_session_count) {
        const s = sum.live_session_count === 1 ? '' : 's';
        out(`Live: +${sum.live_aic.toFixed(2)} AIC from ${sum.live_session_count} open session${s} ` +
            `(collector ${c.url}, ${c.session_count} tracked).`);
    } else {
        out(`Live: collector connected (${c.url}, ${c.session_count} tracked), no open sessions.`);
    }
    // Warn about recent anomalies only; older ones are noted quietly (still in JSON).
    const anomalies = sum.anomalies || [];
    const recent = anomalies.filter(a => a.recent);
    const old = anomalies.length - recent.length;
    if (recent.length) {
        out(`Anomalies (${recent.length}):`);
        for (const a of recent.slice(0, 10)) {
            const id = (a.id || '').slice(0, 8);
            if (a.type === 'mismatch') {
                out(`  ${id}  collector ${a.collector_aic} vs shutdown ${a.shutdown_aic} AIC (Δ${a.diff})`);
            } else if (a.type === 'orphan') {
                out(`  ${id}  collector reports ${a.collector_aic} AIC but no session log on disk`);
            }
        }
        if (recent.length > 10) out(`  ... and ${recent.length - 10} more`);
        if (old) out(`  (${old} older anomal${old === 1 ? 'y' : 'ies'} not shown)`);
    } else if (old) {
        out(`${old} older anomal${old === 1 ? 'y' : 'ies'} (not shown).`);
    }
}

const HOME = os.homedir();

// Display form of a path: collapse the home dir to ~ so directory tables stay narrow.
function shortPath(p) {
    if (!p) return '(unknown)';
    if (p === HOME) return '~';
    if (p.startsWith(HOME + path.sep)) return '~' + p.slice(HOME.length);
    return p;
}

// Print a titled table, capped to `cap` rows with a "... and N more" footer
// (cap defaults to DEFAULT_TOP; a non-finite cap shows every row). Narrow with a
// period (`copilot-usage week`), --dimension, or raise/clear it with --top.
// Prints nothing for an empty table.
function printCappedTable(title, headers, aligns, rows, cap = DEFAULT_TOP) {
    if (!rows.length) return;
    out('');
    out(title);
    out('');
    const shown = rows.slice(0, cap);
    out(renderTable(headers, shown, aligns));
    if (rows.length > shown.length) {
        out(INDENT + `... and ${rows.length - shown.length} more`);
    }
}

function printModels(src, rate, periodLabel, cap) {
    const rows = (src.models || []).map(m => [
        m.model, usd(m.aic, rate), m.aic.toFixed(2), m.requests, m.sessions,
        fmtTokens(m.input_tokens), fmtTokens(m.output_tokens),
    ]);
    printCappedTable(`By model (${periodLabel})`,
        ['Model', 'Dollar', 'AIC', 'Requests', 'Sessions', 'InputTokens', 'OutputTokens'],
        ['l', 'r', 'r', 'r', 'r', 'r', 'r'], rows, cap);
}

function printDirectories(src, rate, periodLabel, cap) {
    const rows = (src.directories || []).map(d => [
        shortPath(d.dir), usd(d.aic, rate), d.aic.toFixed(2), d.sessions, d.repo || '-',
    ]);
    printCappedTable(`By directory (${periodLabel})`,
        ['Directory', 'Dollar', 'AIC', 'Sessions', 'Repository'],
        ['l', 'r', 'r', 'r', 'l'], rows, cap);
}

// `withBranches` adds a per-branch sub-table for each shown repository; it's only
// passed when repository is the sole requested dimension, so the default summary
// stays short (the Branch column already shows the count or the single branch).
function printRepositories(src, rate, periodLabel, withBranches, cap) {
    const repos = src.repositories || [];
    const rows = repos.map(r => {
        const branches = r.branches || [];
        const branch = branches.length === 1 ? branches[0].branch : `${branches.length} branches`;
        return [r.repo, usd(r.aic, rate), r.aic.toFixed(2), r.sessions, branch];
    });
    printCappedTable(`By repository (${periodLabel})`,
        ['Repository', 'Dollar', 'AIC', 'Sessions', 'Branch'],
        ['l', 'r', 'r', 'r', 'l'], rows, cap);
    if (!withBranches) return;
    // Per-branch detail for the shown repositories worked on across >1 branch.
    for (const r of repos.slice(0, cap).filter(r => (r.branches || []).length > 1)) {
        const brows = r.branches.map(b => [b.branch, usd(b.aic, rate), b.aic.toFixed(2), b.sessions]);
        printCappedTable(INDENT + `${r.repo} by branch:`,
            ['Branch', 'Dollar', 'AIC', 'Sessions'], ['l', 'r', 'r', 'r'], brows, cap);
    }
}

// Print the requested dimension tables for one period's totals, in the requested
// order. `src` carries .models/.directories/.repositories; `which` is a subset of
// DIMENSIONS (empty prints nothing); `periodLabel` annotates the headings.
function printDimensions(src, rate, which, periodLabel, cap) {
    which = which || DIMENSIONS;
    // Show the per-branch drill-in only when the user has focused on repositories.
    const withBranches = which.length === 1 && which[0] === 'repository';
    for (const kind of which) {
        if (kind === 'model') printModels(src, rate, periodLabel, cap);
        else if (kind === 'directory') printDirectories(src, rate, periodLabel, cap);
        else if (kind === 'repository') printRepositories(src, rate, periodLabel, withBranches, cap);
    }
}

// --------------------------------------------------------------------------
// Commands
// --------------------------------------------------------------------------

const SUMMARY_HEADERS = ['Period', 'Dollar', 'AIC', 'Sessions', 'UserMessages', 'AssistantMessages', 'TotalMessages'];
const SUMMARY_ALIGNS = ['l', 'r', 'r', 'r', 'r', 'r', 'r'];
const SESSION_ALIGNS = ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'l'];

function sessionRow(s, started, idText, rate) {
    return [started, usd(s.aic, rate), s.aic.toFixed(2),
        s.user_messages, s.assistant_messages, s.total_messages, s.tool_calls, idText];
}

async function cmdSummary(opts) {
    const now = new Date();
    // The period to break down by dimension: --period, else a positional period
    // (`copilot-usage week`), else all time.
    const explicitPeriod = opts.period || opts.arg || null;
    const period = explicitPeriod || 'all';
    if (!PERIODS.includes(period)) {
        fail(`unknown period "${period}" (use one of: ${PERIODS.join(', ')})`, opts);
        return;
    }
    // With an explicit --dimension, show *only* those grouping tables (scoped to the
    // period, default all): no totals, no session list. Naming a period -- or --top
    // -- gives the full detailed view (totals + every dimension + by-session). Bare
    // `copilot-usage` stays terse: just the totals table.
    const dimensionOnly = opts.dimensionsExplicit;
    const detailed = dimensionOnly || !!explicitPeriod || opts.topExplicit;

    const { sessions, incomplete, error } = collect(false);
    const sum = summarize(sessions, incomplete, now, opts.incompleteDays);
    if (opts.collector) {
        const live = await fetchCollector(opts.collector, opts.collectorTimeout);
        reconcile(sum, sessions, incomplete, live, now, opts.anomalyDays);
    }
    if (opts.json) {
        process.stdout.write(JSON.stringify(sum));
        return;
    }
    if (error) process.stderr.write(`warning: ${error}\n`);

    const periodLabel = PERIOD_LABELS[period].toLowerCase();
    const src = sum.periods.find(p => p.period === period);

    // Dimension-only: just the requested grouping table(s), nothing else.
    if (dimensionOnly) {
        printDimensions(src, opts.rate, opts.dimensions, periodLabel, opts.top);
        return;
    }

    out('GitHub Copilot usage');
    out('');
    const live = sum.collector && sum.collector.connected;
    // Totals table: all periods for the at-a-glance default (all), or just the one
    // chosen period when narrowed -- so `copilot-usage week` is only about the week.
    const tablePeriods = period === 'all' ? sum.periods : sum.periods.filter(p => p.period === period);
    const rows = tablePeriods.map(sp => [
        sp.label, usd(sp.aic, opts.rate), sp.aic.toFixed(2),
        sp.session_count, sp.user_messages, sp.assistant_messages, sp.total_messages,
    ].concat(live ? [(sp.aic_live).toFixed(2)] : []));
    const headers = live ? SUMMARY_HEADERS.concat(['AIC+Live']) : SUMMARY_HEADERS;
    const aligns = live ? SUMMARY_ALIGNS.concat(['r']) : SUMMARY_ALIGNS;
    out(renderTable(headers, rows, aligns));
    printCollectorNote(sum);

    if (detailed) {
        // Break the chosen period down by the requested dimensions, then rank that
        // period's sessions by spend -- everything below the table is scoped to it.
        printDimensions(src, opts.rate, opts.dimensions, periodLabel, opts.top);

        const fmtWhen = period === 'today' ? fmtClock : fmtDateTime;
        const sessRows = src.sessions
            .slice()
            .sort((a, b) => b.aic - a.aic)
            .map(s => sessionRow(s, fmtWhen(s.start_ms), s.id.slice(0, 8), opts.rate));
        const sessTitle = `By session (${periodLabel})`;
        if (!sessRows.length) {
            out('');
            out(sessTitle);
            out('');
            out(INDENT + '(none)');
        } else {
            printCappedTable(sessTitle,
                ['Started', 'Dollar', 'AIC', 'UserMessages', 'AssistantMessages', 'TotalMessages', 'ToolCalls', 'Session'],
                SESSION_ALIGNS, sessRows, opts.top);
        }
    } else {
        // Pointer to the detail rather than dumping it all by default.
        out('');
        out('Showing totals only. Run `copilot-usage <period>` (today, week, month, all)');
        out("for a breakdown by model, directory and repository, plus that period's sessions.");
        out('Run `copilot-usage incomplete` for sessions whose usage was never recorded.');
    }
}

function cmdSessions(opts) {
    const period = opts.arg || 'all';
    if (!PERIODS.includes(period)) {
        fail(`unknown period "${period}" (use one of: ${PERIODS.join(', ')})`, opts);
        return;
    }
    const now = new Date();
    const { sessions, incomplete, error } = collect(false);
    const inRange = sessions
        .filter(s => inPeriod(s.start_ms, period, now))
        .sort((a, b) => (b.start_ms || 0) - (a.start_ms || 0));

    if (opts.json) {
        const totals = aggregate(sessions, period, now);
        process.stdout.write(JSON.stringify({ period, session_count: inRange.length, totals, incomplete_count: incomplete.length, sessions: inRange.map(leanSession) }));
        return;
    }
    if (error) process.stderr.write(`warning: ${error}\n`);
    if (!inRange.length) {
        out(`No sessions with recorded usage (${PERIOD_LABELS[period].toLowerCase()}).`);
        return;
    }

    out(`Sessions (${PERIOD_LABELS[period].toLowerCase()})`);
    out('');
    const headers = ['Started', 'Dollar', 'AIC', 'UserMessages', 'AssistantMessages', 'TotalMessages', 'ToolCalls', 'Session'];
    const rows = inRange.map(s => sessionRow(s, fmtDateTime(s.start_ms), s.id, opts.rate));
    // totals row
    const t = aggregate(sessions, period, now);
    rows.push(['', usd(t.aic, opts.rate), t.aic.toFixed(2),
        t.user_messages, t.assistant_messages, t.total_messages, t.tool_calls,
        `${inRange.length} sessions`]);
    out(renderTable(headers, rows, SESSION_ALIGNS));
}

// Sessions that have activity but never wrote a shutdown event: still running, or
// ended abnormally (crash, kill, reboot). Their usage was never recorded, so they
// are excluded from every total and listed only here.
function cmdIncomplete(opts) {
    const period = opts.arg || 'all';
    if (!PERIODS.includes(period)) {
        fail(`unknown period "${period}" (use one of: ${PERIODS.join(', ')})`, opts);
        return;
    }
    const now = new Date();
    const { incomplete, error } = collect(false);
    const inRange = incomplete
        .filter(s => inPeriod(s.start_ms, period, now))
        .sort((a, b) => (b.start_ms || 0) - (a.start_ms || 0));

    if (opts.json) {
        process.stdout.write(JSON.stringify({
            period, incomplete_count: inRange.length, sessions: inRange.map(leanSession),
        }));
        return;
    }
    if (error) process.stderr.write(`warning: ${error}\n`);
    if (!inRange.length) {
        out(`No incomplete sessions (${PERIOD_LABELS[period].toLowerCase()}).`);
        return;
    }

    out(`Incomplete sessions (${PERIOD_LABELS[period].toLowerCase()})`);
    out('');
    const rows = inRange.map(s => [
        fmtDateTime(s.start_ms),
        s.user_messages, s.assistant_messages, s.total_messages, s.tool_calls,
        shortPath(s.cwd), s.id,
    ]);
    out(renderTable(
        ['Started', 'UserMessages', 'AssistantMessages', 'TotalMessages', 'ToolCalls', 'Directory', 'Session'],
        rows, ['l', 'r', 'r', 'r', 'r', 'l', 'l']));
    out('');
    out('No shutdown event was recorded for these (still running or ended abnormally),');
    out('so their usage was never captured and is not counted in any total.');
}

function resolveSession(prefix) {
    let entries;
    try {
        entries = fs.readdirSync(SESSION_DIR, { withFileTypes: true });
    } catch (e) {
        return { error: `cannot read ${SESSION_DIR}: ${e.message}` };
    }
    const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
    if (dirs.includes(prefix)) return { id: prefix };
    const matches = dirs.filter(d => d.startsWith(prefix));
    if (matches.length === 1) return { id: matches[0] };
    if (matches.length === 0) return { error: `no session matching "${prefix}"` };
    return { error: `"${prefix}" is ambiguous (${matches.length} matches): ${matches.slice(0, 5).join(', ')}${matches.length > 5 ? ', ...' : ''}` };
}

function cmdSession(opts) {
    if (!opts.arg) {
        fail('session <id> requires a session id (a prefix is fine)', opts);
        return;
    }
    const res = resolveSession(opts.arg);
    if (res.error) {
        fail(res.error, opts);
        return;
    }
    const file = path.join(SESSION_DIR, res.id, 'events.jsonl');
    const parsed = parseFile(file);
    const s = summarizeSession(res.id, parsed);
    const detail = {
        id: res.id,
        start_ms: s.start_ms,
        cwd: s.cwd,
        repo: s.repo,
        branch: s.branch,
        aic: s.aic,
        cost_usd: +(s.aic * opts.rate).toFixed(4),
        premium_requests: s.premium_requests,
        user_messages: s.user_messages,
        assistant_messages: s.assistant_messages,
        total_messages: s.total_messages,
        tool_calls: s.tool_calls,
        segments: parsed.shutdowns.length,
        models: s.models,
        has_nano_aiu: s.has_nano_aiu,
        incomplete: s.incomplete,
    };
    if (opts.json) {
        process.stdout.write(JSON.stringify(detail));
        return;
    }
    console.log(`Session ${res.id}`);
    console.log('');
    console.log(`  Started:   ${fmtDateTime(s.start_ms)}`);
    if (s.cwd) console.log(`  Directory: ${shortPath(s.cwd)}`);
    if (s.repo) console.log(`  Repo:      ${s.repo}${s.branch ? ` (${s.branch})` : ''}`);
    console.log(`  Usage:     ${s.aic.toFixed(2)} AIC  (${usd(s.aic, opts.rate)})`);
    console.log(`  Premium:   ${s.premium_requests} requests`);
    console.log(`  Messages:  ${s.user_messages} user / ${s.assistant_messages} assistant / ${s.total_messages} total`);
    console.log(`  Tool calls: ${s.tool_calls}`);
    if (parsed.shutdowns.length > 1) console.log(`  Segments:  ${parsed.shutdowns.length} (resumed)`);
    if (s.incomplete) {
        console.log('  Note: incomplete session (no shutdown event recorded; still ' +
            'running or ended abnormally), so usage was never captured.');
    } else if (!s.has_nano_aiu) {
        console.log('  Note: this session predates nano-AIU tracking; usage not recorded.');
    }
    const names = Object.keys(s.models);
    if (names.length) {
        console.log('  Models:');
        for (const name of names) {
            const m = s.models[name];
            console.log(`    ${pad(name, 22)} ${padLeft(m.aic.toFixed(2), 8)} AIC  ${m.requests} req`);
            console.log(`      tokens: in ${fmtTokens(m.inputTokens)} / out ${fmtTokens(m.outputTokens)} / ` +
                        `cacheR ${fmtTokens(m.cacheReadTokens)} / cacheW ${fmtTokens(m.cacheWriteTokens)}` +
                        (m.reasoningTokens ? ` / reasoning ${fmtTokens(m.reasoningTokens)}` : ''));
        }
    }
}

function fail(msg, opts) {
    if (opts && opts.json) {
        process.stdout.write(JSON.stringify({ error: msg }));
    } else {
        process.stderr.write(`error: ${msg}\n`);
    }
    process.exitCode = 1;
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

const HELP = `copilot-usage ${VERSION} -- GitHub Copilot CLI usage report

Usage:
  copilot-usage                    Overview: a totals table for every period
                                   (today / this week / this month / all time)
  copilot-usage <period>           That period grouped by model / directory /
                                   repository, plus its sessions
  copilot-usage sessions [period]  One line per session in a period (default all)
  copilot-usage session <id>       Detail for one session (id prefix accepted)
  copilot-usage incomplete [period]
                                   Sessions with no shutdown event (usage never
                                   recorded, so excluded from every total)

  period is one of: ${PERIODS.join(', ')}

Options:
  --json            Machine-readable JSON output (used by the GNOME extension)
  --rate <n>        Dollars per AIC for cost display (default ${DEFAULT_RATE})
  --period <p>      Which period the summary groups by (default all). Same as the
                    positional period, e.g. \`copilot-usage week\`.
  --dimension <list>
                    Group by these dimensions: a comma-separated list of
                    ${DIMENSIONS.join(', ')} (also: all, none). When given,
                    shows only those grouping tables for the period (all time if
                    none given) -- no totals or session list. Default all.
                    Affects text only; --json always has all three.
  --top <n>         Rows to show per table before "... and N more" (default
                    ${DEFAULT_TOP}; 0 = show all). Also opts into the detailed view.
                    Piped (non-TTY) output shows all rows unless set.
                    Affects text only.
  --anomaly-days <n>
                    Warn about anomalies only when newer than n days (default
                    ${DEFAULT_ANOMALY_DAYS}; 0 = never). Older ones are still listed, just not flagged.
  --incomplete-days <n>
                    Warn about incomplete sessions only when newer than n days
                    (default ${DEFAULT_INCOMPLETE_DAYS}; 0 = never). Older ones are still listed.
  --collector[=url] Merge live usage from the local OTLP collector and reconcile
                    by session id (default ${DEFAULT_COLLECTOR}, or
                    $COPILOT_USAGE_COLLECTOR). Adds *_aic_live, live_sessions and
                    anomalies; open sessions count before they write a shutdown.
  --no-collector    Disable the collector even if a default is configured.
  -h, --help        Show this help
  -v, --version     Show version

Examples:
  copilot-usage                    overview totals for every period
  copilot-usage week               this week, grouped and with its sessions
  copilot-usage all                all time, fully broken down
  copilot-usage today --dimension repository
                                   today, only the by-repository grouping
  copilot-usage sessions month     one line per session this month
  copilot-usage incomplete         sessions whose usage was never recorded

Reads ~/.copilot/session-state/*/events.jsonl. AIC = totalNanoAiu / 1e9.
Sessions before ~2026-06 lack nano-AIU data and are excluded from totals.
With --collector, live AIC for still-open sessions is read from the collector's
OTLP feed and merged in before any shutdown event exists.`;

// Parse a --dimension value (comma-separated) into an ordered, deduped list of
// canonical dimensions. `all` expands to every dimension; `none` clears the list
// so far. Exits(2) on an unknown token, matching unknown-option handling.
function parseDimensions(str) {
    if (str == null) {
        process.stderr.write('error: --dimension requires a value (model, directory, repository, all, none)\n');
        process.exit(2);
    }
    const out = [];
    const add = k => { if (!out.includes(k)) out.push(k); };
    for (const raw of String(str).split(',')) {
        const t = raw.trim().toLowerCase();
        if (!t) continue;
        if (t === 'all') { DIMENSIONS.forEach(add); continue; }
        if (t === 'none') { out.length = 0; continue; }
        const canon = DIMENSION_ALIASES[t];
        if (!canon) {
            process.stderr.write(`error: unknown dimension "${t}" (use: model, directory, repository, all, none)\n`);
            process.exit(2);
        }
        add(canon);
    }
    return out;
}

function parseArgs(argv) {
    const opts = {
        json: false, rate: DEFAULT_RATE, cmd: null, arg: null,
        collector: null, collectorTimeout: 1500, dimensions: DIMENSIONS.slice(),
        period: null, anomalyDays: DEFAULT_ANOMALY_DAYS, incompleteDays: DEFAULT_INCOMPLETE_DAYS,
        top: DEFAULT_TOP, dimensionsExplicit: false, topExplicit: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') opts.json = true;
        else if (a === '--rate') opts.rate = parseFloat(argv[++i]);
        else if (a.startsWith('--rate=')) opts.rate = parseFloat(a.slice('--rate='.length));
        else if (a === '--period') opts.period = argv[++i];
        else if (a.startsWith('--period=')) opts.period = a.slice('--period='.length);
        else if (a === '--dimension' || a === '--dimensions') { opts.dimensions = parseDimensions(argv[++i]); opts.dimensionsExplicit = true; }
        else if (a.startsWith('--dimension=')) { opts.dimensions = parseDimensions(a.slice('--dimension='.length)); opts.dimensionsExplicit = true; }
        else if (a.startsWith('--dimensions=')) { opts.dimensions = parseDimensions(a.slice('--dimensions='.length)); opts.dimensionsExplicit = true; }
        else if (a === '--anomaly-days') opts.anomalyDays = parseInt(argv[++i], 10);
        else if (a.startsWith('--anomaly-days=')) opts.anomalyDays = parseInt(a.slice('--anomaly-days='.length), 10);
        else if (a === '--incomplete-days') opts.incompleteDays = parseInt(argv[++i], 10);
        else if (a.startsWith('--incomplete-days=')) opts.incompleteDays = parseInt(a.slice('--incomplete-days='.length), 10);
        else if (a === '--top') { opts.top = parseInt(argv[++i], 10); opts.topExplicit = true; }
        else if (a.startsWith('--top=')) { opts.top = parseInt(a.slice('--top='.length), 10); opts.topExplicit = true; }
        else if (a === '--collector') opts.collector = DEFAULT_COLLECTOR;
        else if (a.startsWith('--collector=')) opts.collector = a.slice('--collector='.length);
        else if (a === '--no-collector') opts.collector = null;
        else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
        else if (a === '-v' || a === '--version') { console.log(VERSION); process.exit(0); }
        else if (a.startsWith('-')) { process.stderr.write(`error: unknown option "${a}"\n`); process.exit(2); }
        else if (!opts.cmd) opts.cmd = a;
        else if (opts.arg === null) opts.arg = a;
    }
    if (!isFinite(opts.rate) || opts.rate < 0) opts.rate = DEFAULT_RATE;
    if (!Number.isFinite(opts.anomalyDays) || opts.anomalyDays < 0) opts.anomalyDays = DEFAULT_ANOMALY_DAYS;
    if (!Number.isFinite(opts.incompleteDays) || opts.incompleteDays < 0) opts.incompleteDays = DEFAULT_INCOMPLETE_DAYS;
    // --top 0 means "no cap": show every row. Negative/NaN falls back to the default.
    if (opts.top === 0) opts.top = Infinity;
    else if (!Number.isFinite(opts.top) || opts.top < 0) opts.top = DEFAULT_TOP;
    return opts;
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    // Piped output (not a TTY) gets every row -- the "... and N more" cap is a
    // human convenience, but a downstream grep/awk wants the whole table. An
    // explicit --top still wins.
    if (!opts.topExplicit && !process.stdout.isTTY) opts.top = Infinity;
    let cmd = opts.cmd || 'summary';
    // `copilot-usage week` is shorthand for the summary grouped by that period.
    if (PERIODS.includes(cmd)) { opts.arg = cmd; cmd = 'summary'; }
    switch (cmd) {
        case 'summary': await cmdSummary(opts); break;
        case 'sessions': cmdSessions(opts); break;
        case 'session': cmdSession(opts); break;
        case 'incomplete': cmdIncomplete(opts); break;
        default:
            if (DIMENSION_ALIASES[cmd]) {
                process.stderr.write(`error: "${cmd}" is a dimension, not a command. ` +
                    `Try: copilot-usage --dimension ${DIMENSION_ALIASES[cmd]}\n`);
            } else {
                process.stderr.write(`error: unknown command "${cmd}"\n\n${HELP}\n`);
            }
            process.exit(2);
    }
}

main();
