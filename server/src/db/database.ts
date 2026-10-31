import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Db = DatabaseSync;

const migrationsDir = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  return db;
}

/** Applies pending `NNN_name.sql` migrations in order, each in its own transaction. */
export function migrate(db: Db): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const applied = new Set(
    db.prepare("SELECT name FROM schema_migrations").all().map((r) => String(r.name)),
  );
  const files = readdirSync(migrationsDir).filter((f) => /^\d+_.+\.sql$/.test(f)).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    transaction(db, () => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(file, new Date().toISOString());
    });
    ran.push(file);
  }
  return ran;
}

let savepointSeq = 0;

/** Runs `fn` atomically. Nested calls use savepoints. `fn` must be synchronous. */
export function transaction<T>(db: Db, fn: () => T): T {
  const nested = db.isTransaction;
  const sp = `sp_${++savepointSeq}`;
  db.exec(nested ? `SAVEPOINT ${sp}` : "BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec(nested ? `RELEASE ${sp}` : "COMMIT");
    return result;
  } catch (err) {
    db.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : "ROLLBACK");
    throw err;
  }
}
