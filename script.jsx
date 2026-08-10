import { useState, useMemo, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

/* Same-origin: the Vite dev server proxies /api to the Java backend (see vite.config.ts),
   and when you run the shaded jar it serves this bundle itself on the same port. */
const API = '';
const CHECK_ENDPOINT = '/api/check-bans';
const RESOLVE_ENDPOINT = '/api/resolve';

/* The backend is schema-agnostic, so the billed/provisioned pair has to be named here.
   BRIM is the billing system; OM is Order Management, which carries what was actually
   provisioned. Change these two if the recon table is repointed. */
const BILLED_COLUMN = 'BRIM_PRODUCT_ID';
const PROVISIONED_COLUMN = 'OM_PRODUCT_ID';
/* How many of the remaining columns to surface under the Detail line. */
const EXTRA_DETAIL_COLUMNS = 3;

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

async function resolveItems(rows, banColumn) {
  return post(RESOLVE_ENDPOINT, {
    items: rows.map(r => ({ ban: r[banColumn], issue_code: r._code })),
    agent: 'console-operator',
  });
}

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';
const text = (v) => (isBlank(v) ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

/* BigQuery values arrive as strings, numbers, nulls, or nested structures. */
function renderCell(value) {
  const t = text(value);
  return t === null ? <span className="null-cell">—</span> : t;
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

/* "Additional Product in C360" -> "ADDITIONAL_PRODUCT_IN_C360" */
const issueCode = (verdict) =>
  verdictKey(verdict).toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'UNCLASSIFIED';

/* Reads the billed/provisioned pair back as the sentence the console shows. */
function detailFor(row, verdict) {
  const billed = text(row[BILLED_COLUMN]);
  const provisioned = text(row[PROVISIONED_COLUMN]);
  if (billed && provisioned) {
    return billed === provisioned
      ? `Billed and provisioned as ${billed}`
      : `Billed as ${billed}, provisioned as ${provisioned}`;
  }
  if (provisioned) return `Provisioned as ${provisioned}, not billed in BRIM`;
  if (billed) return `Billed as ${billed}, not provisioned in OM`;
  return verdictKey(verdict);
}

/* Which system has to change, inferred from whichever side of the pair is missing more
   often across the group. Counting beats any/some: one populated row should not flip the
   route for a group where everything else is missing. */
function fixRoute(rows) {
  let missingBilled = 0;
  let missingProvisioned = 0;
  for (const r of rows) {
    if (isBlank(r[BILLED_COLUMN])) missingBilled++;
    if (isBlank(r[PROVISIONED_COLUMN])) missingProvisioned++;
  }
  if (missingBilled > missingProvisioned) return { system: 'BRIM', action: `addProduct(${PROVISIONED_COLUMN})` };
  if (missingProvisioned > missingBilled) return { system: 'Order Management', action: `addProduct(${BILLED_COLUMN})` };
  return { system: 'BRIM', action: `updateProduct(${PROVISIONED_COLUMN})` };
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
function IssueGroup({
  index, group, extraColumns, banColumn, open, onToggleOpen,
  selected, onToggleRow, onSelectAll, onResolve,
}) {
  const pending   = group.rows.filter(r => r._status === 'Pending');
  const picked    = pending.filter(r => selected.has(r._id));
  const allPicked = pending.length > 0 && picked.length === pending.length;
  const allDone   = pending.length === 0;
  const sevClass  = group.severity === 'High' ? 'sev-high' : 'sev-medium';

  return (
    <div className={`card issue ${open ? 'open' : ''} ${allDone ? 'done' : sevClass}`}>
      <button className="issue-head" onClick={onToggleOpen} aria-expanded={open}>
        <span className="chev">▶</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="issue-index">Issue {index + 1} · {group.code}</span>
          <div className="issue-title">{group.title}</div>
        </span>
        <span className={`sev sev-${group.severity}`}>{group.severity}</span>
        <span className={`count-badge ${allDone ? 'zero' : ''}`}>
          {allDone
            ? `All ${group.rows.length} resolved ✓`
            : `${group.banCount} BAN${group.banCount === 1 ? '' : 's'} affected`}
        </span>
      </button>

      {open && (
        <div className="issue-body">
          <div className="group-toolbar">
            <span className="fixplan">
              Fix route: {group.route.system} · {group.route.action}
            </span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => onSelectAll(pending, !allPicked)} disabled={allDone}>
                {allPicked ? 'Clear selection' : `Select all ${pending.length}`}
              </button>
              <button className="btn btn-dark btn-sm" onClick={() => onResolve(picked)} disabled={picked.length === 0}>
                Resolve selected ({picked.length})
              </button>
              <button className="btn btn-primary btn-sm" onClick={() => onResolve(pending)} disabled={allDone}>
                Resolve all in this issue
              </button>
            </div>
          </div>

          <table>
            <thead>
              <tr>
                <th style={{ width: 44 }}>
                  <input
                    type="checkbox"
                    checked={allPicked}
                    disabled={allDone}
                    onChange={() => onSelectAll(pending, !allPicked)}
                  />
                </th>
                <th>BAN</th>
                <th>Detail</th>
                <th>Billed / Provisioned</th>
                <th>Status</th>
                <th style={{ width: 170 }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {group.rows.map((row) => {
                const isPending = row._status === 'Pending';
                const isPicked = selected.has(row._id);
                /* The columns that have no cell of their own still carry signal. */
                const extras = extraColumns
                  .map(c => [c, text(row[c])])
                  .filter(([, v]) => v !== null)
                  .slice(0, EXTRA_DETAIL_COLUMNS);

                return (
                  <tr key={row._id} className={row._status === 'Resolved' ? 'resolved' : isPicked ? 'picked' : ''}>
                    <td>
                      <input
                        type="checkbox"
                        checked={isPicked}
                        disabled={!isPending}
                        onChange={() => onToggleRow(row._id)}
                      />
                    </td>
                    <td className="mono" style={{ fontWeight: 700 }}>{renderCell(row[banColumn])}</td>
                    <td>
                      {detailFor(row, group.title)}
                      {extras.length > 0 && (
                        <div className="mono" style={{ color: 'var(--muted)', marginTop: 4 }}>
                          {extras.map(([c, v]) => `${c}: ${v}`).join(' · ')}
                        </div>
                      )}
                    </td>
                    <td style={{ color: 'var(--muted)' }}>
                      {renderCell(row[BILLED_COLUMN])} → {renderCell(row[PROVISIONED_COLUMN])}
                    </td>
                    <td>
                      <span className={`pill ${
                        row._status === 'Resolved' ? 'pill-resolved'
                        : isPending ? 'pill-pending'
                        : 'pill-working'}`}
                      >
                        {row._status}
                      </span>
                    </td>
                    <td>
                      {isPending ? (
                        <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={() => onResolve([row])}>
                          Resolve
                        </button>
                      ) : (
                        <button className="btn btn-sm" style={{ width: '100%' }} disabled>
                          {row._status === 'Resolved' ? 'Synched ✓' : 'Processing…'}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function App() {
  const [banText, setBanText]   = useState('');
  const [result, setResult]     = useState(null);        // full /check-bans response
  const [rows, setRows]         = useState([]);          // result.data + _id / _status / _code
  const [selected, setSelected] = useState(() => new Set());
  const [openIds, setOpenIds]   = useState(() => new Set());
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

  const bans = useMemo(() => parseBans(banText), [banText]);

  /* Columns without a cell of their own; they surface under the Detail line. */
  const extraColumns = useMemo(() => {
    if (!result) return [];
    const { columns: all = [], banColumn, verdictColumn } = result;
    const spoken = new Set([banColumn, verdictColumn, BILLED_COLUMN, PROVISIONED_COLUMN]);
    return all.filter(c => !spoken.has(c));
  }, [result]);

  /* One group per distinct verdict, worst first, then by blast radius. */
  const groups = useMemo(() => {
    if (!rows.length || !result) return [];
    const { banColumn } = result;
    const byVerdict = new Map();

    for (const row of rows) {
      const key = row._verdict;
      if (!byVerdict.has(key)) {
        byVerdict.set(key, { title: key, code: row._code, severity: row._severity, rows: [] });
      }
      byVerdict.get(key).rows.push(row);
    }

    return [...byVerdict.values()]
      .map(g => ({
        ...g,
        banCount: new Set(g.rows.map(r => r[banColumn])).size,
        route: fixRoute(g.rows),
      }))
      .sort((a, b) =>
        (a.severity === b.severity ? 0 : a.severity === 'High' ? -1 : 1) ||
        b.rows.length - a.rows.length);
  }, [rows, result]);

  const pendingAll  = rows.filter(r => r._status === 'Pending');
  const resolvedAll = rows.filter(r => r._status === 'Resolved');

  const runCheck = useCallback(async () => {
    if (bans.length === 0) { setError('Enter at least one BAN.'); return; }
    setError(''); setResult(null); setRows([]); setSelected(new Set()); setLoading(true);
    try {
      const data = await checkBans(bans);
      const verdictColumn = data.verdictColumn;
      /* Rows have no natural key — BAN can repeat — so index makes _id unique. */
      const decorated = (data.data ?? []).map((row, i) => {
        const verdict = verdictKey(row[verdictColumn]);
        return {
          ...row,
          _id: `${row[data.banColumn] ?? 'row'}#${i}`,
          _verdict: verdict,
          _code: issueCode(row[verdictColumn]),
          _severity: verdictSeverity(row[verdictColumn]),
          _status: 'Pending',
        };
      });
      setResult(data);
      setRows(decorated);
      /* Start expanded — the findings are the point of the page. */
      setOpenIds(new Set(decorated.map(r => r._verdict)));
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [bans]);

  /* Optimistic: rows go to Resolving…, then Resolved, or back to Pending on failure. */
  const resolve = useCallback(async (targets) => {
    if (!targets.length || !result) return;
    const ids = new Set(targets.map(t => t._id));
    setError('');
    setRows(prev => prev.map(r => (ids.has(r._id) ? { ...r, _status: 'Resolving…' } : r)));
    try {
      await resolveItems(targets, result.banColumn);
      setRows(prev => prev.map(r => (ids.has(r._id) ? { ...r, _status: 'Resolved' } : r)));
      setSelected(prev => {
        const next = new Set(prev);
        ids.forEach(id => next.delete(id));
        return next;
      });
    } catch (e) {
      setRows(prev => prev.map(r => (ids.has(r._id) ? { ...r, _status: 'Pending' } : r)));
      setError(`${e.message} — POST ${RESOLVE_ENDPOINT} is not implemented on the Java backend yet.`);
    }
  }, [result]);

  const clearAll = () => {
    setBanText(''); setResult(null); setRows([]);
    setSelected(new Set()); setError(''); setOpenIds(new Set());
  };

  const toggleRow = (id) => setSelected(prev => {
    const next = new Set(prev);
    next.has(id) ? next.delete(id) : next.add(id);
    return next;
  });
  const selectMany = (items, on) => setSelected(prev => {
    const next = new Set(prev);
    items.forEach(i => (on ? next.add(i._id) : next.delete(i._id)));
    return next;
  });

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
          Source of truth: <strong style={{ color: 'var(--ink)' }}>BigQuery</strong>
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
              <span className="eyebrow">Step 3 — Review &amp; approve by issue</span>
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>
                {selected.size} row{selected.size === 1 ? '' : 's'} selected
                {resolvedAll.length > 0 ? ` · ${resolvedAll.length} resolved this session` : ''}
              </span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
                <button className="btn btn-ghost btn-sm" onClick={() => setAllOpen(true)}>Expand all</button>
                <button className="btn btn-ghost btn-sm" onClick={() => setAllOpen(false)}>Collapse all</button>
                <button
                  className="btn btn-dark btn-sm"
                  disabled={selected.size === 0}
                  onClick={() => resolve(rows.filter(r => selected.has(r._id) && r._status === 'Pending'))}
                >
                  Resolve selected ({selected.size})
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  disabled={pendingAll.length === 0}
                  onClick={() => resolve(pendingAll)}
                >
                  Resolve all {pendingAll.length}
                </button>
              </div>
            </div>

            {groups.map((g, i) => (
              <IssueGroup
                key={g.title}
                index={i}
                group={g}
                extraColumns={extraColumns}
                banColumn={result.banColumn}
                open={openIds.has(g.title)}
                onToggleOpen={() => toggleOpen(g.title)}
                selected={selected}
                onToggleRow={toggleRow}
                onSelectAll={selectMany}
                onResolve={resolve}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
