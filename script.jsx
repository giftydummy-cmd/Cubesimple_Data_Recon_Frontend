import { useState, useMemo, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

/* Same-origin: the Vite dev server proxies /api to the Python backend (see vite.config.ts),
   and once `npm run build` has produced dist/, that backend serves this bundle itself on the
   same port. */
const API = '';
const CHECK_ENDPOINT = '/api/check-bans';
const RESOLVE_ENDPOINT = '/api/resolve';

/* The backend is schema-agnostic, so the billed/provisioned pair has to be named here.
   BRIM is the billing system; OM is Order Management, which carries what was actually
   provisioned. Change these two if the recon table is repointed.

   These must match the table's real column names exactly — BigQuery is mixed-case here and
   JavaScript key lookup is case-sensitive, so a wrong case silently renders every cell empty. */
const BILLED_COLUMN = 'BRIM_Product_ID';
const PROVISIONED_COLUMN = 'OM_Product_ID';
/* How many of the remaining columns to surface under the Detail line. */
const EXTRA_DETAIL_COLUMNS = 3;

/* Key the backend adds to every returned row: the codes of every issue that row raised. It is
   deliberately not one of the table's columns, so it never shows up as a column of its own. */
const ISSUE_CODES = '_issues';

/* Shown only when the network call itself fails, i.e. nothing is listening. */
const BACKEND_HINT =
  'Cannot reach the backend. Start it from the Data_Recon_Backend folder with: ' +
  '.venv\\Scripts\\python run.py';

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

/* The one write this console performs: the backend calls ServiceNow's om_c360_sync per BAN, which
   copies OM's account status into C360. Partial success is normal, so the per-account results
   come back in the body rather than as an error. */
const resolveBans = (bans) => post(RESOLVE_ENDPOINT, { bans });

const isBlank = (v) => v === null || v === undefined || String(v).trim() === '';
const text = (v) => (isBlank(v) ? null : typeof v === 'object' ? JSON.stringify(v) : String(v));

/* BigQuery values arrive as strings, numbers, nulls, or nested structures. */
function renderCell(value) {
  const t = text(value);
  return t === null ? <span className="null-cell">—</span> : t;
}

/* The other rules this row also failed, so a card can point at its neighbours. */
const otherIssues = (row, code) => (row[ISSUE_CODES] ?? []).filter(c => c !== code);

/* Reads the billed/provisioned pair back as the sentence the console shows. */
function detailFor(row, fallback) {
  const billed = text(row[BILLED_COLUMN]);
  const provisioned = text(row[PROVISIONED_COLUMN]);
  if (billed && provisioned) {
    return billed === provisioned
      ? `Billed and provisioned as ${billed}`
      : `Billed as ${billed}, provisioned as ${provisioned}`;
  }
  if (provisioned) return `Provisioned as ${provisioned}, not billed in BRIM`;
  if (billed) return `Billed as ${billed}, not provisioned in OM`;
  return fallback;
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

/* ---------- Account status table ----------
   Compact by default: the BAN, the account type, and the statuses being compared — the full
   source row is one "Show all columns" click away. Unlike the other three issues, Resolve here
   really does write: it posts to the backend, which calls ServiceNow's om_c360_sync. */
function AccountStatusTable({ columns, allColumns, rows, banColumn, showAll,
                              resolvable, resolveHint, onResolve }) {
  const cols = showAll ? allColumns : columns;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {cols.map(c => <th key={c}>{c}</th>)}
            <th>Status</th>
            <th style={{ textAlign: 'right', width: 150 }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const done = row._status === 'Resolved';
            const busy = row._status === 'Resolving…';
            const failed = row._status === 'Failed';
            return (
              <tr key={row._key} style={{ opacity: done ? 0.55 : undefined }}>
                {cols.map(col => {
                  const isBan = col === banColumn;
                  return (
                    <td
                      key={col}
                      className={isBan ? 'mono' : undefined}
                      style={{
                        fontWeight: isBan ? 700 : undefined,
                        color: isBan ? undefined : 'var(--muted)',
                        textDecoration: done ? 'line-through' : undefined,
                      }}
                    >
                      {renderCell(row[col])}
                    </td>
                  );
                })}
                <td>
                  <span className={`pill ${
                    done ? 'pill-resolved' : busy ? 'pill-working' : 'pill-pending'}`}
                  >
                    {row._status}
                  </span>
                  {/* Whatever ServiceNow said, success or failure, verbatim. */}
                  {row._message && (
                    <div style={{ marginTop: 4, fontSize: 12, color: failed ? '#B33A0C' : 'var(--muted)' }}>
                      {row._message}
                    </div>
                  )}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button
                    className={done ? 'btn btn-ghost btn-sm' : 'btn btn-primary btn-sm'}
                    disabled={!resolvable || busy || done}
                    title={resolvable ? undefined : resolveHint}
                    onClick={() => onResolve([row])}
                  >
                    {done ? 'Synced ✓' : busy ? 'Syncing…' : failed ? 'Retry' : 'Resolve'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- Account status mismatch (OM vs C360) ----------
   A second, independent check on the same BANs: OM and C360 must agree on the account's status.
   The backend returns only the rows where they do not — and this is the one issue it can repair,
   by posting to ServiceNow's om_c360_sync, which copies OM's status into C360. */
const ACCT_KEY = '__account_status__';

function AccountStatusGroup({ index, acct, rows, open, onToggleOpen, onResolve }) {
  const [showAll, setShowAll] = useState(false);
  const columns = acct.columns ?? [];
  const resolvable = acct.resolvable === true;

  /* Compact view: the BAN, the account type, and the statuses being compared. */
  const compactColumns = useMemo(
    () => columns.filter(c =>
      c === acct.banColumn || c === 'Account_Type' || /status/i.test(c)),
    [columns, acct.banColumn]);

  const pending = rows.filter(r => r._status === 'Pending' || r._status === 'Failed');
  const allDone = rows.length > 0 && pending.length === 0;

  return (
    <div className={`card issue ${open ? 'open' : ''} ${allDone ? 'done' : 'sev-high'}`}>
      <button className="issue-head" onClick={onToggleOpen} aria-expanded={open}>
        <span className="chev">▶</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="issue-index">Issue {index + 1} · {acct.code}</span>
          <div className="issue-title">{acct.title}</div>
        </span>
        <span className={`sev sev-${acct.severity}`}>{acct.severity}</span>
        <span className={`count-badge ${allDone ? 'zero' : ''}`}>
          {allDone
            ? `All ${rows.length} synced ✓`
            : `${acct.mismatches} BAN${acct.mismatches === 1 ? '' : 's'} affected`}
        </span>
      </button>

      {open && (
        <div className="issue-body">
          <div className="group-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span className="fixplan">{acct.summary} · Rule: {acct.rule}</span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
              <button
                className="btn btn-primary btn-sm"
                disabled={!resolvable || pending.length === 0}
                title={resolvable ? undefined : acct.resolveHint}
                onClick={() => onResolve(pending)}
              >
                Resolve all {pending.length}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowAll(v => !v)}>
                {showAll ? 'Show issue summary' : 'Show all columns'}
              </button>
            </div>
          </div>

          {/* Say why the button is dead rather than leaving the operator to hover it. */}
          {!resolvable && acct.resolveHint && (
            <div className="banner banner-err" style={{ margin: '0 0 12px' }}>
              {acct.resolveHint}
            </div>
          )}

          <AccountStatusTable
            columns={compactColumns}
            allColumns={columns}
            rows={rows}
            banColumn={acct.banColumn}
            showAll={showAll}
            resolvable={resolvable}
            resolveHint={acct.resolveHint}
            onResolve={onResolve}
          />
        </div>
      )}
    </div>
  );
}

/* ---------- One collapsible issue group ---------- */
function IssueGroup({
  index, group, banColumn, open, onToggleOpen,
  selected, onToggleRow, onSelectAll, onResolve,
}) {
  /* The columns this issue's rule actually compared, minus the ones that have a cell of their
     own. The backend picks them per issue, so a feature-code card shows the two feature codes
     while a product card shows the match source. */
  const detailColumns = useMemo(
    () => (group.columns ?? []).filter(
      c => c !== banColumn && c !== BILLED_COLUMN && c !== PROVISIONED_COLUMN),
    [group.columns, banColumn]);

  /* Only the OM vs C360 account status issue has a write-back behind it. The backend says so per
     group, so these controls are disabled from data rather than from a hardcoded list here. */
  const resolvable = group.resolvable === true;

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
        <span className="count-badge">
          {group.banCount} BAN{group.banCount === 1 ? '' : 's'} affected
        </span>
      </button>

      {open && (
        <div className="issue-body">
          <div className="group-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {/* Summary and rule both come from the backend, so retuning a check is a backend
                change alone — nothing here needs to know what "Feature code mismatch" means. */}
            <span className="fixplan">
              {group.summary} · Rule: {group.rule}
            </span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => onSelectAll(pending, !allPicked)}
                disabled={!resolvable || allDone}
                title={resolvable ? undefined : group.resolveHint}
              >
                {allPicked ? 'Clear selection' : `Select all ${pending.length}`}
              </button>
              <button
                className="btn btn-dark btn-sm"
                onClick={() => onResolve(picked)}
                disabled={!resolvable || picked.length === 0}
                title={resolvable ? undefined : group.resolveHint}
              >
                Resolve selected ({picked.length})
              </button>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => onResolve(pending)}
                disabled={!resolvable || allDone}
                title={resolvable ? undefined : group.resolveHint}
              >
                Resolve all in this issue
              </button>
            </div>
          </div>

          {/* Say why the buttons are dead rather than leaving the operator to hover them. */}
          {!resolvable && group.resolveHint && (
            <div className="banner" style={{ margin: '0 0 12px', color: 'var(--muted)' }}>
              {group.resolveHint}
            </div>
          )}

          <table>
            <thead>
              <tr>
                <th style={{ width: 44 }}>
                  <input
                    type="checkbox"
                    checked={allPicked}
                    disabled={!resolvable || allDone}
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
                const extras = detailColumns
                  .map(c => [c, text(row[c])])
                  .filter(([, v]) => v !== null)
                  .slice(0, EXTRA_DETAIL_COLUMNS);

                return (
                  <tr key={row._id} className={row._status === 'Resolved' ? 'resolved' : isPicked ? 'picked' : ''}>
                    <td>
                      <input
                        type="checkbox"
                        checked={isPicked}
                        disabled={!resolvable || !isPending}
                        onChange={() => onToggleRow(row._id)}
                      />
                    </td>
                    <td className="mono" style={{ fontWeight: 700 }}>{renderCell(row[banColumn])}</td>
                    <td>
                      {detailFor(row, group.summary)}
                      {extras.length > 0 && (
                        <div className="mono" style={{ color: 'var(--muted)', marginTop: 4 }}>
                          {extras.map(([c, v]) => `${c}: ${v}`).join(' · ')}
                        </div>
                      )}
                      {/* The same row can fail more than one rule; say so here rather than
                          leaving the operator to spot it in another card. */}
                      {otherIssues(row, group.code).length > 0 && (
                        <div style={{ color: 'var(--muted)', marginTop: 4, fontSize: 12 }}>
                          Also raises: {otherIssues(row, group.code).join(', ')}
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
                      <button
                        className={resolvable && isPending ? 'btn btn-primary btn-sm' : 'btn btn-sm'}
                        style={{ width: '100%' }}
                        disabled={!resolvable || !isPending}
                        title={resolvable ? undefined : group.resolveHint}
                        onClick={() => onResolve([row])}
                      >
                        {row._status === 'Resolved' ? 'Synced ✓'
                          : isPending ? 'Resolve' : 'Processing…'}
                      </button>
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
  const [rows, setRows]         = useState([]);          // every issue row, + _id / _status / _code
  const [acctRows, setAcctRows] = useState([]);          // account-status rows, + _key / _ban / _status
  const [selected, setSelected] = useState(() => new Set());
  const [openIds, setOpenIds]   = useState(() => new Set());
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');

  const bans = useMemo(() => parseBans(banText), [banText]);

  /* The backend classifies; this file only renders. Every section arrives with its own code,
     title, summary, rule, severity and column subset, so adding or retuning a check is a backend
     change alone. The only thing done here is attaching the per-row UI state. */
  const groups = useMemo(() => {
    if (!result?.issues) return [];
    return result.issues.map(g => ({
      ...g,
      rows: rows.filter(r => r._code === g.code),
    }));
  }, [rows, result]);

  const runCheck = useCallback(async () => {
    if (bans.length === 0) { setError('Enter at least one BAN.'); return; }
    setError(''); setResult(null); setRows([]); setAcctRows([]);
    setSelected(new Set()); setLoading(true);
    try {
      const data = await checkBans(bans);
      /* A row raising two issues is returned under both groups, and is a separate line of work
         in each — so _id is keyed by issue as well as position, not by BAN, which repeats. */
      const decorated = (data.issues ?? []).flatMap(group =>
        (group.data ?? []).map((row, i) => ({
          ...row,
          _id: `${group.code}#${i}`,
          _code: group.code,
          _status: 'Pending',
        })));

      const acctBanColumn = data.accountStatus?.banColumn;
      const acctDecorated = (data.accountStatus?.data ?? []).map((row, i) => ({
        ...row,
        _key: `${ACCT_KEY}#${i}`,
        _ban: row[acctBanColumn],
        _status: 'Pending',
        _message: null,
      }));

      setResult(data);
      setRows(decorated);
      setAcctRows(acctDecorated);
      /* Start expanded — the findings are the point of the page. */
      const ids = new Set((data.issues ?? []).map(g => g.code));
      if (acctDecorated.length > 0) ids.add(ACCT_KEY);
      setOpenIds(ids);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [bans]);

  /* The console's only write. Rows go to Resolving…, then to whatever ServiceNow actually said —
     per account, because one BAN can sync while the next 404s. */
  const resolveAccounts = useCallback(async (targets) => {
    const targetBans = [...new Set(targets.map(t => t._ban).filter(Boolean))];
    if (targetBans.length === 0) return;
    const inFlight = new Set(targetBans.map(String));

    setError('');
    setAcctRows(prev => prev.map(r => (inFlight.has(String(r._ban))
      ? { ...r, _status: 'Resolving…', _message: null } : r)));

    try {
      const outcome = await resolveBans(targetBans);
      const byBan = new Map((outcome.results ?? []).map(r => [String(r.ban), r]));
      setAcctRows(prev => prev.map(r => {
        const done = byBan.get(String(r._ban));
        return done
          ? { ...r, _status: done.ok ? 'Resolved' : 'Failed', _message: done.message }
          : r;
      }));
      if (outcome.failed > 0) setError(outcome.message);
    } catch (e) {
      /* The request itself never landed, so nothing changed in ServiceNow. */
      setAcctRows(prev => prev.map(r => (inFlight.has(String(r._ban))
        ? { ...r, _status: 'Pending', _message: null } : r)));
      setError(e.message);
    }
  }, []);

  /* The three product/feature issues have no write-back, so their buttons are inert by design. */
  const resolveNoop = useCallback(() => {}, []);

  const clearAll = () => {
    setBanText(''); setResult(null); setRows([]); setAcctRows([]);
    setSelected(new Set()); setError(''); setOpenIds(new Set());
  };

  const acct = result?.accountStatus;
  const acctCount = acctRows.length;
  const acctResolved = acctRows.filter(r => r._status === 'Resolved').length;

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
  const setAllOpen = (on) => setOpenIds(on
    ? new Set([...groups.map(g => g.code), ...(acctCount > 0 ? [ACCT_KEY] : [])])
    : new Set());

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

        {/* ---------- BAN entry ---------- */}
        <div className="card" style={{ padding: 22, marginBottom: 20, borderTop: '4px solid var(--bs-yellow)' }}>
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

        {/* "No discrepancies found." comes straight from the backend — but only when the
            account-status check found nothing either. */}
        {result && result.totalIssues === 0 && !(result.accountStatus?.mismatches > 0) && (
          <div className="banner banner-ok" style={{ marginBottom: 20 }}>
            {result.message}
            {result.accountStatus ? ` ${result.accountStatus.message}` : ''}
          </div>
        )}
        {result?.accountStatus?.message?.startsWith('Account status check failed') && (
          <div className="banner banner-err" style={{ marginBottom: 20 }}>
            {result.accountStatus.message}
          </div>
        )}
        {result && result.missingBans?.length > 0 && (
          <div className="banner banner-err" style={{ marginBottom: 20 }}>
            {result.missingBans.length} BAN{result.missingBans.length === 1 ? ' was' : 's were'} not found
            in any reconciliation table: {result.missingBans.slice(0, 10).join(', ')}
            {result.missingBans.length > 10 ? ` (+${result.missingBans.length - 10} more)` : ''}
          </div>
        )}
        {result?.truncated && (
          <div className="banner banner-err" style={{ marginBottom: 20 }}>
            The result set hit the server's row limit, so this list may be incomplete. Raise
            query.maxRows in the backend configuration.
          </div>
        )}

        {/* ---------- Summary ---------- */}
        {result && (
          <div style={{ display: 'flex', gap: 14, marginBottom: 24, flexWrap: 'wrap' }}>
            <StatCard label="Accounts scanned"    value={result.totalScanned}             accent="var(--bs-black)" />
            <StatCard label="Accounts affected"   value={result.affectedBans}             accent="var(--bs-orange)" />
            <StatCard label="Issues found"        value={result.totalIssues}              accent="#B33A0C" />
            {result.accountStatus && (
              <StatCard label="Status mismatches" value={result.accountStatus.mismatches} accent="#B33A0C" />
            )}
            <StatCard label="Not found in table"  value={result.missingBans?.length ?? 0} accent="#C9C3B8" />
          </div>
        )}

        {/* ---------- One collapsible section per issue ---------- */}
        {(groups.length > 0 || acctCount > 0) && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>
                {acctResolved > 0
                  ? `${acctResolved} account${acctResolved === 1 ? '' : 's'} synced this session`
                  : 'Only the account status mismatch can be resolved from here'}
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
                group={g}
                banColumn={result.banColumn}
                open={openIds.has(g.code)}
                onToggleOpen={() => toggleOpen(g.code)}
                selected={selected}
                onToggleRow={toggleRow}
                onSelectAll={selectMany}
                onResolve={resolveNoop}
              />
            ))}

            {acctCount > 0 && (
              <AccountStatusGroup
                index={groups.length}
                acct={acct}
                rows={acctRows}
                open={openIds.has(ACCT_KEY)}
                onToggleOpen={() => toggleOpen(ACCT_KEY)}
                onResolve={resolveAccounts}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
