import { useState, useMemo, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

/* Same-origin: the Vite dev server proxies /api to the Java backend (see vite.config.ts),
   and when you run the shaded jar it serves this bundle itself on the same port. */
const API = '';
const CHECK_ENDPOINT = '/api/check-bans';
const RESOLVE_ENDPOINT = '/api/resolve';
/* Resolving an OM vs C360 status mismatch: the backend re-checks the two systems and, for the
   accounts that really disagree, calls the ServiceNow om_c360_sync flow that rewrites C360 to
   match OM. */
const RESOLVE_ACCOUNT_STATUS_ENDPOINT = '/api/resolve-account-status';

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

/* Triggers the ServiceNow sync for one or more accounts. This call answers 200 even when some
   BANs could not be started, so the per-BAN entries in results[] — not the HTTP status — decide
   what each row shows. Only a request that could not be attempted at all throws. */
const resolveAccountStatus = (bans) => post(RESOLVE_ACCOUNT_STATUS_ENDPOINT, { bans });

/* Per-row outcome of a sync. The backend's `reason` refines `status`, and one refinement
   matters to the operator: NO_ORDER_IN_SERVICENOW is a failure that retrying cannot fix,
   because the account has no order for the flow to run against. Showing it as a plain red
   "Failed" next to a Retry button would send people round a loop that always ends the same. */
const NO_ORDER = 'NO_ORDER_IN_SERVICENOW';

const syncOutcome = (o) => (o.reason === NO_ORDER ? NO_ORDER : o.status);

const SYNC_LABEL = {
  TRIGGERED: 'Flow triggered ✓',
  SKIPPED:   'No sync needed',
  FAILED:    'Failed',
  [NO_ORDER]: 'No order in ServiceNow',
};
const SYNC_PILL = {
  TRIGGERED: 'pill-resolved',
  SKIPPED:   'pill-working',
  FAILED:    'pill-failed',
  [NO_ORDER]: 'pill-working',
};

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

/* ---------- Shared issue table ----------
   Compact by default: the BAN, a few context columns, the issue itself, and a Resolve
   button — the full source row is one "Show all columns" click away. Resolve here is a
   real write: it asks the backend to run the ServiceNow sync for that account, and the
   row then carries whatever the backend reported back for it. */
function IssueRowsTable({ columns, allColumns, rows, banColumn, issueLabel, showAll,
                          rowKey, results, onResolve }) {
  const cols = showAll ? allColumns : columns;
  return (
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
            const key = rowKey(row, i);
            const ban = row[banColumn];
            const outcome = results.get(key);
            const busy = outcome?.status === 'RESOLVING';
            /* Only a triggered flow retires the row. A skip or a failure leaves it actionable:
               nothing changed in C360, so striking it through would be a lie. */
            const done = outcome?.status === 'TRIGGERED';
            const kind = outcome && !busy ? syncOutcome(outcome) : null;
            /* Offer Retry only where it could actually help. */
            const retryable = kind === 'FAILED';

            return (
              <tr key={key} style={{ opacity: done ? 0.55 : undefined }}>
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
                <td style={{ color: '#B33A0C', fontWeight: 600, textDecoration: done ? 'line-through' : undefined }}>
                  {issueLabel}
                </td>
                <td style={{ minWidth: 240 }}>
                  {outcome ? (
                    <>
                      <span className={`pill ${busy ? 'pill-working' : SYNC_PILL[kind] ?? 'pill-pending'}`}>
                        {busy ? 'Triggering…' : SYNC_LABEL[kind] ?? outcome.status}
                      </span>
                      {outcome.message && (
                        <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 5 }}>
                          {outcome.serviceNowMessage ?? outcome.message}
                        </div>
                      )}
                      {outcome.orderId && (
                        <div className="mono" style={{ color: 'var(--muted)', fontSize: 12, marginTop: 3 }}>
                          Order {outcome.orderId}
                          {outcome.orderStatus ? ` · ${outcome.orderStatus}` : ''}
                        </div>
                      )}
                    </>
                  ) : (
                    <span className="pill pill-pending">Pending</span>
                  )}
                </td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button
                    className={done || kind === NO_ORDER ? 'btn btn-ghost btn-sm' : 'btn btn-primary btn-sm'}
                    disabled={busy || done || kind === NO_ORDER}
                    onClick={() => onResolve([{ key, ban }])}
                  >
                    {busy ? <><span className="spin" />Triggering…</>
                      : done ? 'Synched ✓'
                      : kind === NO_ORDER ? 'Not syncable'
                      : retryable ? 'Retry' : 'Resolve'}
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
   A second, independent check on the same BANs: the two systems must agree on the
   account's status. The backend returns only the rows where they do not.

   Resolve is wired to the real thing here. OM is the source of truth, so the fix is always
   in the same direction — C360 is brought up to OM — and the backend runs it through the
   ServiceNow om_c360_sync flow. */
const ACCT_KEY = '__account_status__';

const acctRowKey = (banColumn) => (row, i) => `${ACCT_KEY}|${row[banColumn] ?? 'row'}|${i}`;

function AccountStatusGroup({ index, acct, open, onToggleOpen, results, onResolve, syncMessage }) {
  const [showAll, setShowAll] = useState(false);
  // BRIM is not part of this reconciliation. Keep its status out of both the
  // summary and the optional full-column view in case the backend includes it.
  const columns = useMemo(
    () => (acct.columns ?? []).filter(c => String(c).toUpperCase() !== 'BRIM_ACCOUNT_STATUS'),
    [acct.columns]
  );
  const rows = acct.data ?? [];

  /* Compact view: the BAN, the account type, and the two statuses being compared. */
  const compactColumns = useMemo(
    () => columns.filter(c =>
      c === acct.banColumn || c === 'Account_Type' || /status/i.test(c)),
    [columns, acct.banColumn]);

  const keyOf = useMemo(() => acctRowKey(acct.banColumn), [acct.banColumn]);

  /* Rows still worth sending: not already triggered, not mid-flight, and not one of the
     accounts ServiceNow has no order for — those would fail identically every time. */
  const outstanding = rows
    .map((row, i) => ({ key: keyOf(row, i), ban: row[acct.banColumn] }))
    .filter(e => {
      const o = results.get(e.key);
      return o?.status !== 'TRIGGERED' && o?.status !== 'RESOLVING' && o?.reason !== NO_ORDER;
    });

  const busy = rows.some((row, i) => results.get(keyOf(row, i))?.status === 'RESOLVING');
  const triggered = rows.filter((row, i) => results.get(keyOf(row, i))?.status === 'TRIGGERED').length;
  const allDone = rows.length > 0 && triggered === rows.length;

  return (
    <div className={`card issue ${open ? 'open' : ''} ${allDone ? 'done' : 'sev-high'}`}>
      <button className="issue-head" onClick={onToggleOpen} aria-expanded={open}>
        <span className="chev">▶</span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span className="issue-index">Issue {index + 1} · ACCOUNT_STATUS_MISMATCH</span>
          <div className="issue-title">Account status mismatch — OM vs C360</div>
        </span>
        <span className="sev sev-High">High</span>
        <span className={`count-badge ${allDone ? 'zero' : ''}`}>
          {allDone
            ? `All ${rows.length} triggered ✓`
            : `${acct.mismatches} BAN${acct.mismatches === 1 ? '' : 's'} affected`}
        </span>
      </button>

      {open && (
        <div className="issue-body">
          <div className="group-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="fixplan">
              Fix route: ServiceNow · om_c360_sync(BAN) — C360 is updated to match OM
            </span>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setShowAll(v => !v)}>
                {showAll ? 'Show issue summary' : 'Show all columns'}
              </button>
              <button
                className="btn btn-primary btn-sm"
                disabled={busy || outstanding.length === 0}
                onClick={() => onResolve(outstanding)}
              >
                {busy
                  ? <><span className="spin" />Triggering…</>
                  : `Resolve all ${outstanding.length} in this issue`}
              </button>
            </div>
          </div>

          {syncMessage?.text && (
            <div
              className={`banner ${syncMessage.ok ? 'banner-ok' : 'banner-err'}`}
              style={{ margin: '0 0 14px' }}
            >
              {syncMessage.text}
            </div>
          )}

          <IssueRowsTable
            columns={compactColumns}
            allColumns={columns}
            rows={rows}
            banColumn={acct.banColumn}
            issueLabel="Account status mismatch"
            showAll={showAll}
            rowKey={keyOf}
            results={results}
            onResolve={onResolve}
          />
        </div>
      )}
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
          <div className="group-toolbar" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
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
  /* Row key -> the backend's outcome for that account, or {status:'RESOLVING'} while in flight. */
  const [acctResults, setAcctResults] = useState(() => new Map());
  /* { text, ok } — ok drives green vs orange, so a batch that triggered nothing never reads
     as a success. */
  const [acctMessage, setAcctMessage] = useState(null);
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

  const pendingAll = rows.filter(r => r._status === 'Pending');

  const runCheck = useCallback(async () => {
    if (bans.length === 0) { setError('Enter at least one BAN.'); return; }
    setError(''); setResult(null); setRows([]); setSelected(new Set());
    setAcctResults(new Map()); setAcctMessage(null); setLoading(true);
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
      const ids = new Set(decorated.map(r => r._verdict));
      if (data.accountStatus?.data?.length > 0) ids.add(ACCT_KEY);
      setOpenIds(ids);
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
    setAcctResults(new Map()); setAcctMessage(null);
  };

  /* Resolve an OM vs C360 mismatch for real: hand the BANs to the backend, which re-checks
     them and triggers the ServiceNow sync flow for the ones that still disagree.

     The call returns 200 even when individual accounts fail, so each row is updated from its
     own entry in results[] rather than from the HTTP status. Only a request that could not be
     attempted at all (nothing listening, ServiceNow not configured) lands in catch, and there
     the rows go back to Pending so the operator can retry. */
  const resolveAccountStatusRows = useCallback(async (entries) => {
    if (!entries.length) return;
    setError(''); setAcctMessage(null);

    setAcctResults(prev => {
      const next = new Map(prev);
      entries.forEach(e => next.set(e.key, { status: 'RESOLVING' }));
      return next;
    });

    try {
      const data = await resolveAccountStatus(entries.map(e => e.ban));
      const byBan = new Map((data.results ?? []).map(r => [String(r.ban), r]));
      setAcctResults(prev => {
        const next = new Map(prev);
        for (const e of entries) {
          const r = byBan.get(String(e.ban));
          next.set(e.key, r ?? {
            status: 'FAILED',
            message: 'The backend did not report an outcome for this BAN.',
          });
        }
        return next;
      });
      /* Green only if something actually started. A batch where every account was skipped or
         had no order is a real answer, but it is not a success. */
      setAcctMessage({ text: data.message ?? '', ok: (data.triggered ?? 0) > 0 });
    } catch (e) {
      /* Nothing was started, so drop the in-flight marks rather than leaving spinners behind. */
      setAcctResults(prev => {
        const next = new Map(prev);
        entries.forEach(e => next.delete(e.key));
        return next;
      });
      setError(e.message);
    }
  }, []);

  const acct = result?.accountStatus;
  const acctRows = acct?.data?.length ?? 0;

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
    ? new Set([...groups.map(g => g.title), ...(acctRows > 0 ? [ACCT_KEY] : [])])
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

        {/* ---------- Step 1: BAN entry ---------- */}
        <div className="card" style={{ padding: 22, marginBottom: 20, borderTop: '4px solid var(--bs-yellow)' }}>
          <div className="eyebrow" style={{ marginBottom: 12 }}>Paste the BANs</div>
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
        {result && result.totalDiscrepancies === 0 && !(result.accountStatus?.mismatches > 0) && (
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

        {/* ---------- Step 2: summary ---------- */}
        {result && (
          <div style={{ display: 'flex', gap: 14, marginBottom: 24, flexWrap: 'wrap' }}>
            <StatCard label="Accounts scanned"    value={result.totalScanned}             accent="var(--bs-black)" />
            <StatCard label="Discrepancies found" value={result.totalDiscrepancies}       accent="var(--bs-orange)" />
            {result.accountStatus && (
              <StatCard label="Status mismatches" value={result.accountStatus.mismatches} accent="#B33A0C" />
            )}
            <StatCard label="Not found in table"  value={result.missingBans?.length ?? 0} accent="#C9C3B8" />
          </div>
        )}

        {/* ---------- Step 3: one collapsible section per issue ---------- */}
        {(groups.length > 0 || acctRows > 0) && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
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

            {acctRows > 0 && (
              <AccountStatusGroup
                index={groups.length}
                acct={acct}
                open={openIds.has(ACCT_KEY)}
                onToggleOpen={() => toggleOpen(ACCT_KEY)}
                results={acctResults}
                onResolve={resolveAccountStatusRows}
                syncMessage={acctMessage}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
