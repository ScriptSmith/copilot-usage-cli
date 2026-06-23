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

const VERSION = '1.0.0'; // keep in sync with package.json
const NANO_PER_AIC = 1e9;
const DEFAULT_RATE = 0.01; // dollars per AIC
const SESSION_DIR = path.join(os.homedir(), '.copilot', 'session-state');

const CACHE_VERSION = 2;
const CACHE_DIR = path.join(
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'),
    'copilot-usage-cli');
const CACHE_FILE = path.join(CACHE_DIR, 'cache.json');

const SPANS = ['today', 'week', 'month', 'all'];
const SPAN_LABELS = { today: 'Today', week: 'This week', month: 'This month', all: 'All time' };

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
// match and JSON-parses only the (rare) shutdown lines.
function parseFile(file) {
    const result = { shutdowns: [], userMessages: 0, assistantMessages: 0, toolCalls: 0 };
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
    return {
        id,
        aic,
        start_ms: startMs,
        premium_requests: premium,
        user_messages: parsed.userMessages,
        assistant_messages: parsed.assistantMessages,
        total_messages: parsed.userMessages + parsed.assistantMessages,
        tool_calls: parsed.toolCalls,
        models,
        has_nano_aiu: aic > 0,
    };
}

// Scan all sessions. Returns { sessions: [...], error? }.
// `includeZero` keeps sessions with no nano-AIU data (used for `session <id>`).
function collect(includeZero) {
    const cache = loadCache();
    const next = {};
    const sessions = [];
    let entries;
    try {
        entries = fs.readdirSync(SESSION_DIR, { withFileTypes: true });
    } catch (e) {
        return { sessions, error: `cannot read ${SESSION_DIR}: ${e.message}` };
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
        if (!includeZero && session.aic <= 0) continue;
        sessions.push(session);
    }

    saveCache(next);
    return { sessions };
}

// --------------------------------------------------------------------------
// Spans
// --------------------------------------------------------------------------

function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function spanStart(span, now) {
    if (span === 'today') return startOfDay(now);
    if (span === 'week') {
        const off = (now.getDay() + 6) % 7; // Mon=0 .. Sun=6
        return new Date(now.getFullYear(), now.getMonth(), now.getDate() - off).getTime();
    }
    if (span === 'month') return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    return 0; // all
}

function inSpan(startMs, span, now) {
    if (span === 'all') return true;
    if (!startMs) return false;
    return startOfDay(new Date(startMs)) >= spanStart(span, now);
}

function aggregate(sessions, span, now) {
    let aic = 0, count = 0, user = 0, asst = 0, tools = 0;
    for (const s of sessions) {
        if (!inSpan(s.start_ms, span, now)) continue;
        aic += s.aic;
        count++;
        user += s.user_messages;
        asst += s.assistant_messages;
        tools += s.tool_calls;
    }
    return {
        span,
        label: SPAN_LABELS[span],
        aic,
        sessions: count,
        user_messages: user,
        assistant_messages: asst,
        total_messages: user + asst,
        tool_calls: tools,
    };
}

// Drop the per-model breakdown from a session for the list/summary JSON;
// `session <id>` is where the model detail lives.
function leanSession(s) {
    const { models, ...rest } = s;
    return rest;
}

function summarize(sessions, now) {
    const spans = SPANS.map(s => aggregate(sessions, s, now));
    const bySpan = {};
    for (const s of spans) bySpan[s.span] = s;
    const today = sessions
        .filter(s => inSpan(s.start_ms, 'today', now))
        .sort((a, b) => (b.start_ms || 0) - (a.start_ms || 0));
    return {
        today_aic: bySpan.today.aic,
        week_aic: bySpan.week.aic,
        month_aic: bySpan.month.aic,
        all_aic: bySpan.all.aic,
        session_count: sessions.length,
        spans,
        today_sessions: today.map(leanSession),
    };
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

const INDENT = '  ';

// headers: string[], rows: (string|number)[][], aligns: ('l'|'r')[]
function renderTable(headers, rows, aligns) {
    const widths = headers.map((h, i) =>
        Math.max(String(h).length, ...rows.map(r => String(r[i]).length)));
    const fmtRow = cells => (INDENT + cells.map((c, i) =>
        aligns[i] === 'r' ? padLeft(c, widths[i]) : pad(c, widths[i])).join('  ')).replace(/\s+$/, '');
    return [fmtRow(headers), ...rows.map(r => fmtRow(r))].join('\n');
}

// --------------------------------------------------------------------------
// Commands
// --------------------------------------------------------------------------

const SUMMARY_HEADERS = ['Span', 'Dollar', 'AIC', 'Sessions', 'UserMessages', 'AssistantMessages', 'TotalMessages'];
const SUMMARY_ALIGNS = ['l', 'r', 'r', 'r', 'r', 'r', 'r'];
const SESSION_ALIGNS = ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'l'];

function sessionRow(s, started, idText, rate) {
    return [started, usd(s.aic, rate), s.aic.toFixed(2),
        s.user_messages, s.assistant_messages, s.total_messages, s.tool_calls, idText];
}

function cmdSummary(opts) {
    const now = new Date();
    const { sessions, error } = collect(false);
    const sum = summarize(sessions, now);
    if (opts.json) {
        process.stdout.write(JSON.stringify(sum));
        return;
    }
    if (error) process.stderr.write(`warning: ${error}\n`);

    console.log('GitHub Copilot usage');
    console.log('');
    const rows = sum.spans.map(sp => [
        sp.label, usd(sp.aic, opts.rate), sp.aic.toFixed(2),
        sp.sessions, sp.user_messages, sp.assistant_messages, sp.total_messages,
    ]);
    console.log(renderTable(SUMMARY_HEADERS, rows, SUMMARY_ALIGNS));
    console.log('');

    console.log("Today's sessions");
    console.log('');
    if (!sum.today_sessions.length) {
        console.log(INDENT + '(none today)');
        return;
    }
    const headers = ['Started', 'Dollar', 'AIC', 'UserMessages', 'AssistantMessages', 'TotalMessages', 'ToolCalls', 'Session'];
    const rows2 = sum.today_sessions.map(s =>
        sessionRow(s, fmtClock(s.start_ms), s.id.slice(0, 8), opts.rate));
    console.log(renderTable(headers, rows2, SESSION_ALIGNS));
}

function cmdSessions(opts) {
    const span = opts.arg || 'all';
    if (!SPANS.includes(span)) {
        fail(`unknown span "${span}" (use one of: ${SPANS.join(', ')})`, opts);
        return;
    }
    const now = new Date();
    const { sessions, error } = collect(false);
    const inRange = sessions
        .filter(s => inSpan(s.start_ms, span, now))
        .sort((a, b) => (b.start_ms || 0) - (a.start_ms || 0));

    if (opts.json) {
        const totals = aggregate(sessions, span, now);
        process.stdout.write(JSON.stringify({ span, session_count: inRange.length, totals, sessions: inRange.map(leanSession) }));
        return;
    }
    if (error) process.stderr.write(`warning: ${error}\n`);
    if (!inRange.length) {
        console.log(`No sessions with recorded usage (${SPAN_LABELS[span].toLowerCase()}).`);
        return;
    }

    console.log(`Sessions (${SPAN_LABELS[span].toLowerCase()})`);
    console.log('');
    const headers = ['Started', 'Dollar', 'AIC', 'UserMessages', 'AssistantMessages', 'TotalMessages', 'ToolCalls', 'Session'];
    const rows = inRange.map(s => sessionRow(s, fmtDateTime(s.start_ms), s.id, opts.rate));
    // totals row
    const t = aggregate(sessions, span, now);
    rows.push(['', usd(t.aic, opts.rate), t.aic.toFixed(2),
        t.user_messages, t.assistant_messages, t.total_messages, t.tool_calls,
        `${inRange.length} sessions`]);
    console.log(renderTable(headers, rows, SESSION_ALIGNS));
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
    };
    if (opts.json) {
        process.stdout.write(JSON.stringify(detail));
        return;
    }
    console.log(`Session ${res.id}`);
    console.log('');
    console.log(`  Started:   ${fmtDateTime(s.start_ms)}`);
    console.log(`  Usage:     ${s.aic.toFixed(2)} AIC  (${usd(s.aic, opts.rate)})`);
    console.log(`  Premium:   ${s.premium_requests} requests`);
    console.log(`  Messages:  ${s.user_messages} user / ${s.assistant_messages} assistant / ${s.total_messages} total`);
    console.log(`  Tool calls: ${s.tool_calls}`);
    if (parsed.shutdowns.length > 1) console.log(`  Segments:  ${parsed.shutdowns.length} (resumed)`);
    if (!s.has_nano_aiu) {
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
  copilot-usage [summary]          Totals per span + today's sessions
  copilot-usage sessions [span]    Sessions in a span (default: all)
  copilot-usage session <id>       Detail for one session (id prefix accepted)

  span is one of: ${SPANS.join(', ')}

Options:
  --json            Machine-readable JSON output (used by the GNOME extension)
  --rate <n>        Dollars per AIC for cost display (default ${DEFAULT_RATE})
  -h, --help        Show this help
  -v, --version     Show version

Reads ~/.copilot/session-state/*/events.jsonl. AIC = totalNanoAiu / 1e9.
Sessions before ~2026-06 lack nano-AIU data and are excluded from totals.`;

function parseArgs(argv) {
    const opts = { json: false, rate: DEFAULT_RATE, cmd: null, arg: null };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') opts.json = true;
        else if (a === '--rate') opts.rate = parseFloat(argv[++i]);
        else if (a.startsWith('--rate=')) opts.rate = parseFloat(a.slice('--rate='.length));
        else if (a === '-h' || a === '--help') { console.log(HELP); process.exit(0); }
        else if (a === '-v' || a === '--version') { console.log(VERSION); process.exit(0); }
        else if (a.startsWith('-')) { process.stderr.write(`error: unknown option "${a}"\n`); process.exit(2); }
        else if (!opts.cmd) opts.cmd = a;
        else if (opts.arg === null) opts.arg = a;
    }
    if (!isFinite(opts.rate) || opts.rate < 0) opts.rate = DEFAULT_RATE;
    return opts;
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    switch (opts.cmd || 'summary') {
        case 'summary': cmdSummary(opts); break;
        case 'sessions': cmdSessions(opts); break;
        case 'session': cmdSession(opts); break;
        default:
            process.stderr.write(`error: unknown command "${opts.cmd}"\n\n${HELP}\n`);
            process.exit(2);
    }
}

main();
