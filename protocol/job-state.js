// protocol/job-state.js
// Single source of truth for data/job_state.json serialization.
// Importable by BOTH tsx (main.js) and plain node (*.mjs demo scripts) —
// keep this pure ESM JS with no TS types so `node fabricate.mjs` can load it.
//
// On-disk format : { entries: [[role, record[]], ...] }  <->  Map<role, record[]>
// record         : { jobId, description, submittedAt, status, ...extra }
//
// v2 (multi-job): each role now holds an ARRAY of concurrent job records,
// not a single record. This is what unblocks parallel job throughput per role.
// loadJobState() transparently migrates older on-disk shapes:
//   - pre-roster flat:      { jobId, ... }                       -> Map([['PCHEAP', [record]]])
//   - v1 single-record map: { entries: [[role, record], ...] }   -> wrap each non-array val as [val]
//   - v2 array map:         { entries: [[role, record[]], ...] } -> used as-is
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const JOB_STATE_FILE = process.env.JOB_STATE_FILE || './data/job_state.json';

// Terminal on-chain statuses: a job in one of these will never transition
// again, so it's safe to drop it from a role's active array.
const TERMINAL_STATUSES = new Set(['Completed', 'Rejected', 'Expired']);
const isTerminal = (r) => TERMINAL_STATUSES.has(r.status);

export function loadJobState() {
  if (!existsSync(JOB_STATE_FILE)) return new Map();
  let raw;
  try {
    raw = JSON.parse(readFileSync(JOB_STATE_FILE, 'utf-8'));
  } catch {
    return new Map(); // partial/corrupt -> empty; syncFromChain rebuilds
  }
  if (raw && Array.isArray(raw.entries)) {
    // v1 (single record per role) -> v2 (array per role) migration, per-entry
    return new Map(raw.entries.map(([role, val]) => [role, Array.isArray(val) ? val : [val]]));
  }
  if (raw && raw.jobId) return new Map([['PCHEAP', [raw]]]); // legacy flat (pre-roster)
  return new Map();
}

export function saveJobState(stateMap) {
  const dir = dirname(JOB_STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${JOB_STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ entries: Array.from(stateMap.entries()) }, null, 2));
  renameSync(tmp, JOB_STATE_FILE); // atomic on POSIX: never a partial read
}

/** Insert-or-update a SINGLE job record within a role's array, matched by jobId.
 *  - jobId already present in the role's array -> merge (status updates etc.)
 *  - jobId not present -> append as a NEW concurrent job for that role.
 *  This is the one primitive that makes multi-job-per-role possible without
 *  changing call sites: callers keep calling upsertJobState(role, record) exactly
 *  as before; whether it appends or updates now depends only on record.jobId. */
export function upsertJobState(role, record) {
  const state = loadJobState();
  const list = state.get(role) || [];
  const idx = list.findIndex(r => String(r.jobId) === String(record.jobId));
  if (idx === -1) list.push(record);
  else list[idx] = { ...list[idx], ...record };
  state.set(role, list);
  saveJobState(state);
  return state;
}

/** Remove jobs from a role's array whose status is terminal. Active jobs are
 *  left untouched. Used by syncFromChain after re-checking on-chain status for
 *  every job currently tracked for that role. */
export function pruneTerminalJobs(role, isTerminalFn = isTerminal) {
  const state = loadJobState();
  const list = state.get(role) || [];
  const next = list.filter(r => !isTerminalFn(r));
  if (next.length === list.length) return state; // nothing pruned
  if (next.length === 0) state.delete(role);
  else state.set(role, next);
  saveJobState(state);
  return state;
}

/** Read-only: all job records currently tracked for a role ([] if none). */
export function getJobs(role) {
  return loadJobState().get(role) || [];
}

/** Count of non-terminal (active) jobs for a role — the concurrency gate
 *  tickProvider checks before deciding whether to submit another job. */
export function activeJobCount(role, isTerminalFn = isTerminal) {
  return getJobs(role).filter(r => !isTerminalFn(r)).length;
}

/** Remove ALL jobs for a role (full reset — e.g. expired-squatter cleanup
 *  like job #235). No-op if the role has no entry. */
export function clearRole(role) {
  const state = loadJobState();
  if (state.delete(role)) saveJobState(state);
  return state;
}
