import { useState, useMemo, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

/* Same-origin: the Vite dev server proxies /api to the Java backend (see vite.config.ts),
   and when you run the shaded jar it serves this bundle itself on the same port. */
const API = '';
const CHECK_ENDPOINT = '/api/check-bans';

/* The backend classifies; this file only renders. Every issue section arrives with its own
   code, title, severity, rule and column subset, so adding or retuning a check is a backend
   change alone — nothing here needs to know what "Feature code mismatch" means. */

/* Key the backend adds to every returned row: the codes of all issues that row raised. It is
   deliberately not one of the table's columns, so it never shows up as a column of its own. */
const ISSUE_CODES = '_issues';

/* ---------- Resolve: placeholder ----------
   The ServiceNow om_c360_sync integration this button used to call has been removed, and no
   replacement write-back exists yet. The button is kept so the table keeps its shape for
   whatever replaces it, but it is permanently disabled — greyed out and unclickable.

   That is the honest state of things: there is nothing behind it to call. A live-looking button
   that silently changes no system is worse than an obviously inert one, because an operator would
   walk away believing the account was fixed.

   To bring it back to life: drop the `disabled` flags below and give the two buttons an onClick
   that posts to the new endpoint. Nothing else in the table has to change. */
const RESOLVE_HINT =
  'Not available: the ServiceNow sync has been removed and no replacement exists yet.';

/* Shown only when the network call itself fails, i.e. nothing is listening. */
const BACKEND_HINT =
  'Cannot reach the Java backend. Start it from the Backend folder with: ' +
  'mvn -q package  then  java -jar target/data-recon-backend.jar';

const parseBans = (text) =>
  [...new Set(
    text.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean)
  )];

async function post(endpoint, payload) {
  let res;
  try {
    res = await fetch(API + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    /* fetch only rejects for transport-level problems, never for a 4xx/5xx. */
    throw new Error(BACKEND_HINT);
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const checkBans = (bans) => post(CHECK_ENDPOINT, { bans });

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';
const text = (v) => (isBlank(v) ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

/* BigQuery values arrive as strings, numbers, nulls, or nested structures. */
function renderCell(value) {
  const t = text(value);
  return t === null ? <span className="null-cell">—</span> : t;
}

/* ---------- Brightspeed mark ----------
   Built on a 120x120 box from four quarter-shapes centred on the corners:
     · a solid disc, r=30            — the yellow corner
     · a quarter ring, r=42 to r=76  — the arcs, alternating yellow/orange round the pinwheel
   The 12-unit gap between disc and ring is the white ring-gap. Adjacent rings overlap
   (42 + 42 < 120 < 76 + 76) and multiply to the red-orange arms. The centre sits 84.9
   from every corner — past every outer radius — so the four-pointed star is negative
   space, 22% of the mark wide. Vector, so it is sharp at any size or pixel density.

   `isolation: isolate` keeps mix-blend-mode inside the SVG; without it the multiply
   would blend against the near-black topbar and turn the whole mark black. */
function BrightspeedMark({ size = 30, title = 'Brightspeed' }) {
  return (
    <svg
      className="bs-mark"
      width={size}
      height={size}
      viewBox="0 0 120 120"
      style={{ isolation: 'isolate' }}
      role="img"
      aria-label={title}
      focusable="false"
    >
      {/* solid corner discs */}
      <g fill="#FFC800">
        <path d="M 0,0 L 30,0 A 30,30 0 0,1 0,30 Z" />
        <path d="M 120,0 L 120,30 A 30,30 0 0,1 90,0 Z" />
        <path d="M 120,120 L 90,120 A 30,30 0 0,1 120,90 Z" />
        <path d="M 0,120 L 0,90 A 30,30 0 0,1 30,120 Z" />
      </g>
      {/* quarter rings — opposite corners share a colour, so every overlap is yellow x orange.
          The blend goes on each path, not the group: on the group it would multiply against
          the topbar behind the SVG instead of against the neighbouring ring. */}
      <g style={{ isolation: 'isolate' }}>
        <path fill="#FB621F" style={{ mixBlendMode: 'multiply' }} d="M 76,0 A 76,76 0 0,1 0,76 L 0,42 A 42,42 0 0,0 42,0 Z" />
        <path fill="#FFC800" style={{ mixBlendMode: 'multiply' }} d="M 120,76 A 76,76 0 0,1 44,0 L 78,0 A 42,42 0 0,0 120,42 Z" />
        <path fill="#FB621F" style={{ mixBlendMode: 'multiply' }} d="M 44,120 A 76,76 0 0,1 120,44 L 120,78 A 42,42 0 0,0 78,120 Z" />
        <path fill="#FFC800" style={{ mixBlendMode: 'multiply' }} d="M 0,44 A 76,76 0 0,1 76,120 L 42,120 A 42,42 0 0,0 0,78 Z" />
      </g>
    </svg>
  );
}

function StatCard({ label, value, accent }) {
  return (
    <div className="card" style={{ flex: 1, padding: '16px 20px', borderTop: `4px solid ${accent}` }}>
      <div className="eyebrow">{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, marginTop: 6, letterSpacing: '-.5px' }}>{value}</div>
    </div>
  );
}

/* ---------- One collapsible issue group ----------
   Compact by default: the BAN, the two columns the rule compared, a little context, and the
   issue itself — the full source row is one "Show all columns" click away.

   The same row can appear under two or three issues, which is correct: an operator works one
   issue at a time. So each row also names the *other* issues it raised, from the backend's
   `_issues` list, and the reader is never left thinking the row has only this one problem. */
function IssueGroup({ index, group, allColumns, titleByCode, open, onToggleOpen }) {
  const [showAll, setShowAll] = useState(false);
  const cols = showAll ? allColumns : (group.columns ?? []);
  const rows = group.data ?? [];
  const sevClass = group.severity === 'High' ? 'sev-high' : 'sev-medium';

  /* A row's identity within this group. Rows have no natural key — a BAN legitimately repeats,
     once per product or feature — so the index carries the uniqueness. The group code is in the
     key too, because the same row shown under two issues is two separate findings. */
  const keyOf = (row, i) => `${group.code}|${row[group.banColumn] ?? 'row'}|${i}`;

  return (
    <div className={`card issue ${open ? 'open' : ''} ${sevClass}`}>
      <button className="issue-head" onClick={onToggleOpen} aria-expanded={open}>
        <span className="chev">▶</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="issue-index">Issue {index + 1} · {group.code}</span>
          <div className="issue-title">{group.title}</div>
        </span>
        <span className={`sev sev-${group.severity}`}>{group.severity}</span>
        <span className="count-badge">
          {group.banCount} BAN{group.banCount === 1 ? '' : 's'} affected
        </span>
      </button>

      {open && (
        <div className="issue-body">
          <div className="group-toolbar">
            <span className="fixplan">Rule: {group.rule}</span>
            <span style={{ fontSize: 12.5, color: 'var(--muted)' }}>
              {group.summary} · {group.rowCount} row{group.rowCount === 1 ? '' : 's'}
            </span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowAll(v => !v)}>
                {showAll ? 'Show issue summary' : 'Show all columns'}
              </button>
              <button className="btn btn-primary btn-sm" title={RESOLVE_HINT} disabled>
                Resolve all {rows.length} in this issue
              </button>
            </div>
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  {cols.map(c => <th key={c}>{c}</th>)}
                  <th>Issue</th>
                  <th>Status</th>
                  <th style={{ textAlign: 'right', width: 150 }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, i) => {
                  const key = keyOf(row, i);
                  /* The other findings on this very row, named rather than coded. */
                  const also = (row[ISSUE_CODES] ?? [])
                    .filter(code => code !== group.code)
                    .map(code => titleByCode[code] ?? code);

                  return (
                    <tr key={key}>
                      {cols.map(col => {
                        const isBan = col === group.banColumn;
                        return (
                          <td
                            key={col}
                            className={isBan ? 'mono' : undefined}
                            style={{
                              fontWeight: isBan ? 700 : undefined,
                              color: isBan ? undefined : 'var(--muted)',
                            }}
                          >
                            {renderCell(row[col])}
                          </td>
                        );
                      })}
                      <td style={{ minWidth: 210 }}>
                        <span className="pill pill-pending">{group.title}</span>
                        {also.length > 0 && (
                          <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 5 }}>
                            Same row also: {also.join(', ')}
                          </div>
                        )}
                      </td>
                      <td>
                        <span className="pill pill-pending">Pending</span>
                      </td>
                      <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <button className="btn btn-primary btn-sm" title={RESOLVE_HINT} disabled>
                          Resolve
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function App() {
  const [banText, setBanText] = useState('');
  const [result, setResult]   = useState(null);        // full /check-bans response
  const [openIds, setOpenIds] = useState(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const bans = useMemo(() => parseBans(banText), [banText]);

  const groups = result?.issues ?? [];

  /* Issue code -> its human title, so a row can name its other findings without the frontend
     hard-coding any of them. */
  const titleByCode = useMemo(
    () => Object.fromEntries(groups.map(g => [g.code, g.title])),
    [groups]
  );

  const runCheck = useCallback(async () => {
    if (bans.length === 0) { setError('Enter at least one BAN.'); return; }
    setError(''); setResult(null); setLoading(true);
    try {
      const data = await checkBans(bans);
      setResult(data);
      /* Start expanded — the findings are the point of the page. */
      setOpenIds(new Set((data.issues ?? []).map(g => g.code)));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [bans]);

  const clearAll = () => {
    setBanText(''); setResult(null); setError(''); setOpenIds(new Set());
  };

  const toggleOpen = (code) => setOpenIds(prev => {
    const next = new Set(prev);
    next.has(code) ? next.delete(code) : next.add(code);
    return next;
  });
  const setAllOpen = (on) => setOpenIds(on ? new Set(groups.map(g => g.code)) : new Set());

  return (
    <div>
      <header className="bs-topbar">
        <BrightspeedMark size={30} />
        <div className="bs-wordmark">Brightspeed</div>
        <div className="bs-sub">Data Reconciliation Console</div>
      </header>
      <div className="accent-rule" />

      <div style={{ padding: '32px 40px 64px', maxWidth: 1180, margin: '0 auto' }}>

        <h1 style={{ margin: '0 0 6px', fontSize: 31, letterSpacing: '-.7px' }}>Data Reconciliation</h1>
        <p style={{ color: 'var(--muted)', margin: '0 0 24px', fontSize: 15 }}>
          Source of truth: <strong style={{ color: 'var(--ink)' }}>BigQuery</strong>
        </p>

        {/* ---------- Step 1: BAN entry ---------- */}
        <div className="card" style={{ padding: 22, marginBottom: 20, borderTop: '4px solid var(--bs-yellow)' }}>
          <div className="eyebrow" style={{ marginBottom: 12 }}>Paste the BANs</div>
          <textarea
            value={banText}
            onChange={(e) => setBanText(e.target.value)}
            placeholder="313497356, 423207561 …"
            spellCheck="false"
          />
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={runCheck} disabled={loading || bans.length === 0}>
              {loading
                ? <><span className="spin" />Checking BigQuery…</>
                : `Check ${bans.length} BAN${bans.length === 1 ? '' : 's'} for Discrepancies`}
            </button>
            <button className="btn btn-ghost" onClick={clearAll} disabled={loading}>
              Clear
            </button>
            <span style={{ color: 'var(--muted)', fontSize: 13, marginLeft: 'auto' }}>
              {bans.length} unique BAN{bans.length === 1 ? '' : 's'} parsed
            </span>
          </div>
        </div>

        {error && <div className="banner banner-err" style={{ marginBottom: 20 }}>{error}</div>}

        {/* "No discrepancies found." comes straight from the backend. */}
        {result && groups.length === 0 && (
          <div className="banner banner-ok" style={{ marginBottom: 20 }}>
            {result.message}
          </div>
        )}
        {result && result.missingBans?.length > 0 && (
          <div className="banner banner-err" style={{ marginBottom: 20 }}>
            {result.missingBans.length} BAN{result.missingBans.length === 1 ? ' was' : 's were'} not found
            in the reconciliation table: {result.missingBans.slice(0, 10).join(', ')}
            {result.missingBans.length > 10 ? ` (+${result.missingBans.length - 10} more)` : ''}
          </div>
        )}
        {result?.truncated && (
          <div className="banner banner-err" style={{ marginBottom: 20 }}>
            The result set hit the server's row limit, so this list may be incomplete. Raise
            query.maxRows in the backend configuration.
          </div>
        )}

        {/* ---------- Step 2: summary ----------
            Accounts and issues are counted separately on purpose: one BAN can raise all three
            issues across its rows, so the two numbers are not meant to agree. */}
        {result && (
          <div style={{ display: 'flex', gap: 14, marginBottom: 24, flexWrap: 'wrap' }}>
            <StatCard label="Accounts scanned"  value={result.totalScanned}             accent="var(--bs-black)" />
            <StatCard label="Accounts affected" value={result.affectedBans}             accent="var(--bs-orange)" />
            <StatCard label="Issues found"      value={result.totalIssues}              accent="#B33A0C" />
            <StatCard label="Not found in table" value={result.missingBans?.length ?? 0} accent="#C9C3B8" />
          </div>
        )}

        {/* ---------- Step 3: one collapsible section per issue ---------- */}
        {groups.length > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>
                {result.cleanRows} clean row{result.cleanRows === 1 ? '' : 's'} filtered out
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setAllOpen(true)}>Expand all</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setAllOpen(false)}>Collapse all</button>
              </div>
            </div>

            {groups.map((g, i) => (
              <IssueGroup
                key={g.code}
                index={i}
                group={{ ...g, banColumn: result.banColumn }}
                allColumns={result.columns ?? []}
                titleByCode={titleByCode}
                open={openIds.has(g.code)}
                onToggleOpen={() => toggleOpen(g.code)}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
