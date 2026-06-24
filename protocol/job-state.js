// protocol/job-state.js
// Single source of truth for data/job_state.json serialization.
// Importable by BOTH tsx (main.js) and plain node (*.mjs demo scripts) —
// keep this pure ESM JS with no TS types so `node fabricate.mjs` can load it.
//
// On-disk format : { entries: [[role, record], ...] }  <->  Map<role, record>
// record         : { jobId, description, submittedAt, status, ...extra }

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const JOB_STATE_FILE = process.env.JOB_STATE_FILE || './data/job_state.json';

export function loadJobState() {
  if (!existsSync(JOB_STATE_FILE)) return new Map();
  let raw;
  try {
    raw = JSON.parse(readFileSync(JOB_STATE_FILE, 'utf-8'));
  } catch {
    return new Map(); // partial/corrupt -> empty; syncFromChain rebuilds
  }
  if (raw && Array.isArray(raw.entries)) return new Map(raw.entries);
  if (raw && raw.jobId) return new Map([['PCHEAP', raw]]); // legacy flat (pre-roster)
  return new Map();
}

export function saveJobState(stateMap) {
  const dir = dirname(JOB_STATE_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${JOB_STATE_FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ entries: Array.from(stateMap.entries()) }, null, 2));
  renameSync(tmp, JOB_STATE_FILE); // atomic on POSIX: never a partial read
}

/** Read-modify-write a SINGLE role. Never clobbers other roles. */
export function upsertJobState(role, record) {
  const state = loadJobState();
  state.set(role, record);
  saveJobState(state);
  return state;
}

/** Remove a single role (e.g. after settlement). No-op if absent. */
export function clearRole(role) {
  const state = loadJobState();
  if (state.delete(role)) saveJobState(state);
  return state;
}
