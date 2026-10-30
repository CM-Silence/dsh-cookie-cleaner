import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE cookies (
  creation_utc INTEGER NOT NULL,
  host_key TEXT NOT NULL,
  top_frame_site_key TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  encrypted_value BLOB NOT NULL DEFAULT X'',
  path TEXT NOT NULL DEFAULT '/',
  expires_utc INTEGER NOT NULL DEFAULT 0,
  is_secure INTEGER NOT NULL DEFAULT 0,
  is_httponly INTEGER NOT NULL DEFAULT 0,
  last_access_utc INTEGER NOT NULL DEFAULT 0,
  has_expires INTEGER NOT NULL DEFAULT 1,
  is_persistent INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 1,
  samesite INTEGER NOT NULL DEFAULT 0,
  source_scheme INTEGER NOT NULL DEFAULT 0,
  source_port INTEGER NOT NULL DEFAULT 0,
  last_update_utc INTEGER NOT NULL DEFAULT 0,
  source_type INTEGER NOT NULL DEFAULT 0,
  has_cross_site_ancestor INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX cookies_unique_index ON cookies(host_key, top_frame_site_key, name, path);
`;

const CHROMIUM_EPOCH_OFFSET_MS = 11644473600000;

/**
 * Chromium 的时间是 1601 起的**微秒**，比 Number.MAX_SAFE_INTEGER 还大。
 * 所以以字符串形式绑定（列是 INTEGER，靠 SQLite 的亲和性精确落成整数）。
 */
function chromiumTime(ms) {
  return (BigInt(Math.round(ms + CHROMIUM_EPOCH_OFFSET_MS)) * 1000n).toString();
}

/** 造一个和 Chromium 同构的 cookie 库，用来跑测试。 */
export function makeFixture({ dir, cookies }) {
  const networkDir = path.join(dir, 'Network');
  mkdirSync(networkDir, { recursive: true });
  const file = path.join(networkDir, 'Cookies');
  rmSync(file, { force: true });
  const db = new DatabaseSync(file);
  db.exec(SCHEMA);
  const stmt = db.prepare(`
    INSERT INTO cookies (creation_utc, host_key, name, value, path, last_access_utc, last_update_utc)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const cookie of cookies) {
    const created = chromiumTime(cookie.createdAt ?? Date.now());
    const value = cookie.value ?? 'v'.repeat(cookie.bytes ?? 32);
    stmt.run(created, cookie.host, cookie.name, value, cookie.path ?? '/', created, created);
  }
  db.close();
  return file;
}

export function readRows(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const rows = db.prepare(
    'SELECT host_key AS host, name, path, LENGTH(value) AS len, CAST(creation_utc AS TEXT) AS createdAt FROM cookies ORDER BY creation_utc',
  ).all();
  db.close();
  return rows;
}

export function tempDir(name) {
  return path.join(tmpdir(), 'dsh-cookie-cleaner-test', name + '-' + process.pid + '-' + Math.random().toString(36).slice(2, 8));
}
