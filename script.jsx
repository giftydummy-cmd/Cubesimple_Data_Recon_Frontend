import { useState, useMemo, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

/* Same-origin: the Vite dev server proxies /api to the Java backend (see vite.config.ts),
   and when you run the shaded jar it serves this bundle itself on the same port. */
const API = '';
const ENDPOINT = '/api/check-bans';

/* Shown only when the network call itself fails, i.e. nothing is listening. */
const BACKEND_HINT =
  'Cannot reach the Java backend. Start it from the Backend folder with: ' +
  'mvn -q package  then  java -jar target/data-recon-backend.jar';

const parseBans = (text) =>
  [...new Set(
    text.split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean)
  )];

async function checkBans(bans) {
  let res;
  try {
    res = await fetch(API + ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bans }),
    });
  } catch {
    /* fetch only rejects for transport-level problems, never for a 4xx/5xx. */
    throw new Error(BACKEND_HINT);
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

/* BigQuery values arrive as strings, numbers, nulls, or nested structures. */
function renderCell(value) {
  if (value === null || value === undefined) return <span className="null-cell">—</span>;
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function verdictSeverity(value) {
  if (value === null || value === undefined) return 'High';
  const numeric = parseFloat(String(value).replace('%', '').replace(/,/g, '').trim());
  if (Number.isNaN(numeric)) return 'High';
  return numeric < 90 ? 'High' : 'Medium';
}

/* The verdict doubles as the issue identity: every row sharing a verdict shares a root cause. */
function verdictKey(value) {
  if (value === null || value === undefined) return '(no verdict)';
  return String(value);
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

/* ---------- One collapsible issue group ---------- */
function IssueGroup({ index, group, columns, banColumn, open, onToggleOpen }) {
  const sevClass = group.severity === 'High' ? 'sev-high' : 'sev-medium';

  return (
    <div className={`card issue ${open ? 'open' : ''} ${sevClass}`}>
      <button className="issue-head" onClick={onToggleOpen} aria-expanded={open}>
        <span className="chev">▶</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="issue-index">Issue {index + 1}</span>
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
            <span className="fixplan">
              {group.rows.length} row{group.rows.length === 1 ? '' : 's'} · verdict: {group.title}
            </span>
          </div>

          <div className="table-scroll">
            <table>
              <thead>
                <tr>{columns.map(c => <th key={c}>{c}</th>)}</tr>
              </thead>
              <tbody>
                {group.rows.map((row, i) => (
                  <tr key={`${row[banColumn] ?? 'row'}-${i}`}>
                    {columns.map(col => {
                      const isBan = col === banColumn;
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
                  </tr>
                ))}
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
  const [result, setResult]   = useState(null);   // full /check-bans response
  const [openIds, setOpenIds] = useState(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState('');

  const bans = useMemo(() => parseBans(banText), [banText]);

  /* The verdict column heads each group, so it is dropped from the rows beneath it. */
  const columns = useMemo(() => {
    if (!result) return [];
    const { columns: all = [], banColumn, verdictColumn } = result;
    const rest = all.filter(c => c !== banColumn && c !== verdictColumn);
    return all.includes(banColumn) ? [banColumn, ...rest] : rest;
  }, [result]);

  /* One group per distinct verdict, worst first, then by blast radius. */
  const groups = useMemo(() => {
    if (!result?.data?.length) return [];
    const { verdictColumn, banColumn } = result;
    const byVerdict = new Map();

    for (const row of result.data) {
      const key = verdictKey(row[verdictColumn]);
      if (!byVerdict.has(key)) {
        byVerdict.set(key, { title: key, severity: verdictSeverity(row[verdictColumn]), rows: [] });
      }
      byVerdict.get(key).rows.push(row);
    }

    return [...byVerdict.values()]
      .map(g => ({ ...g, banCount: new Set(g.rows.map(r => r[banColumn])).size }))
      .sort((a, b) =>
        (a.severity === b.severity ? 0 : a.severity === 'High' ? -1 : 1) ||
        b.rows.length - a.rows.length);
  }, [result]);

  const runCheck = useCallback(async () => {
    if (bans.length === 0) { setError('Enter at least one BAN.'); return; }
    setError(''); setResult(null); setLoading(true);
    try {
      const data = await checkBans(bans);
      setResult(data);
      /* Start expanded — the findings are the point of the page. */
      setOpenIds(new Set((data.data ?? []).map(r => verdictKey(r[data.verdictColumn]))));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [bans]);

  const clearAll = () => { setBanText(''); setResult(null); setError(''); setOpenIds(new Set()); };

  const toggleOpen = (title) => setOpenIds(prev => {
    const next = new Set(prev);
    next.has(title) ? next.delete(title) : next.add(title);
    return next;
  });
  const setAllOpen = (on) => setOpenIds(on ? new Set(groups.map(g => g.title)) : new Set());

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
          Source of truth: <strong style={{ color: 'var(--ink)' }}>BigQuery</strong> · Accounts with a
          {' '}<strong style={{ color: 'var(--ink)' }}>100%</strong> verdict are fully reconciled and are
          filtered out server-side
        </p>

        {/* ---------- Step 1: BAN entry ---------- */}
        <div className="card" style={{ padding: 22, marginBottom: 20, borderTop: '4px solid var(--bs-yellow)' }}>
          <div className="eyebrow" style={{ marginBottom: 4 }}>Step 1 — Target accounts</div>
          <p style={{ margin: '0 0 12px', color: 'var(--muted)', fontSize: 14 }}>
            Paste the BANs you want to reconcile (comma, space, or newline separated).
          </p>
          <textarea
            value={banText}
            onChange={(e) => setBanText(e.target.value)}
            placeholder="BAN-1000467924, BAN-1000893302 …"
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
        {result && result.totalDiscrepancies === 0 && (
          <div className="banner banner-ok" style={{ marginBottom: 20 }}>{result.message}</div>
        )}
        {result && result.totalDiscrepancies > 0 && result.missingBans?.length > 0 && (
          <div className="banner banner-err" style={{ marginBottom: 20 }}>
            {result.missingBans.length} BAN{result.missingBans.length === 1 ? ' was' : 's were'} not found
            in the table: {result.missingBans.slice(0, 10).join(', ')}
            {result.missingBans.length > 10 ? ` (+${result.missingBans.length - 10} more)` : ''}
          </div>
        )}
        {result?.truncated && (
          <div className="banner banner-err" style={{ marginBottom: 20 }}>
            The result set hit the server's row limit, so this list may be incomplete. Raise
            query.maxRows in the backend configuration.
          </div>
        )}

        {/* ---------- Step 2: summary ---------- */}
        {result && (
          <div style={{ display: 'flex', gap: 14, marginBottom: 24, flexWrap: 'wrap' }}>
            <StatCard label="Accounts scanned"    value={result.totalScanned}             accent="var(--bs-black)" />
            <StatCard label="Discrepancies found" value={result.totalDiscrepancies}       accent="var(--bs-orange)" />
            <StatCard label="Not found in table"  value={result.missingBans?.length ?? 0} accent="#C9C3B8" />
          </div>
        )}

        {/* ---------- Step 3: one collapsible section per verdict ---------- */}
        {groups.length > 0 && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
              <span className="eyebrow">Step 3 — Review by issue</span>
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>
                Every row whose {result.verdictColumn} is not 100%, grouped by verdict
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
                <span style={{ color: 'var(--muted)', fontSize: 13 }}>
                  {result.elapsedMs} ms · job {result.jobId}
                </span>
                <button className="btn btn-ghost btn-sm" onClick={() => setAllOpen(true)}>Expand all</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setAllOpen(false)}>Collapse all</button>
              </div>
            </div>

            {groups.map((g, i) => (
              <IssueGroup
                key={g.title}
                index={i}
                group={g}
                columns={columns}
                banColumn={result.banColumn}
                open={openIds.has(g.title)}
                onToggleOpen={() => toggleOpen(g.title)}
              />
            ))}
          </>
        )}

        {result?.sql && (
          <details className="sql" style={{ marginTop: 24 }}>
            <summary>View the BigQuery reconciliation query that produced these rows</summary>
            <pre>{result.sql}</pre>
          </details>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
