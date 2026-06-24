/**
 * protocol/confidential-relay.ts
 * PCONF(x402 commissioning server)がjob作成時に生値をここへ書き込み、
 * oracle.tsがPhase A処理時に一度だけ読んでcommit hashを検証する private side-channel。
 * ファイルシステムにアクセスできるoracle運用者には常に見える(commit-hash confidentiality,
 * zero-knowledgeではない) — README記載方針と一致。
 *
 * peek(getRelay)とdelete(deleteRelay)を分離しているのは、attestFRがretry
 * (quorum不足等)を返した場合に次サイクルでもrelayを読み直せるようにするため。
 * 確定的に終端した(pass/fabricated/mismatch)ときだけ呼び出し側がdeleteRelayする。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { keccak256, toBytes, type Hex } from 'viem';

const PATH = './data/confidential_relay.json';

export interface RelayEntry {
  value:  number;
  nonce:  string;
  asset:  string;
  window: string;
}

type RelayDB = Record<string, RelayEntry>;

function load(): RelayDB {
  if (!existsSync(PATH)) return {};
  return JSON.parse(readFileSync(PATH, 'utf-8')) as RelayDB;
}

function save(db: RelayDB): void {
  mkdirSync('./data', { recursive: true });
  writeFileSync(PATH, JSON.stringify(db, null, 2));
}

/** PCONFのcommission-signalエンドポイントがjob作成と同時に呼ぶ */
export function putRelay(jobId: string, entry: RelayEntry): void {
  const db = load();
  db[jobId] = entry;
  save(db);
}

/** 読むだけ・消さない(retry時の再読み込みに必要) */
export function getRelay(jobId: string): RelayEntry | null {
  const db = load();
  return db[jobId] ?? null;
}

/** Phase Aが確定的に終端した後にoracle.tsが呼ぶ */
export function deleteRelay(jobId: string): void {
  const db = load();
  if (db[jobId]) {
    delete db[jobId];
    save(db);
  }
}

/** server.ts と oracle.ts の両方が同じ式でhashを計算する(一致must) */
export function computeCommitHash(value: number, nonce: string): Hex {
  return keccak256(toBytes(`${value}:${nonce}`)) as Hex;
}
