import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';

export function openDatabase(filename) {
  const sql = new DatabaseSync(filename);
  sql.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
  const migrations = new URL('../drizzle/', import.meta.url);
  const files = readdirSync(migrations).filter((file) => /^\d+_.+\.sql$/.test(file)).sort();
  sql.exec('CREATE TABLE IF NOT EXISTS cr_local_migrations (name TEXT PRIMARY KEY)');
  const hasMigration = sql.prepare('SELECT 1 FROM cr_local_migrations WHERE name=?');
  const recordMigration = sql.prepare('INSERT INTO cr_local_migrations VALUES (?)');
  sql.exec('BEGIN IMMEDIATE');
  try {
    for (const file of files) {
      if (hasMigration.get(file)) continue;
      sql.exec(readFileSync(new URL(file, migrations), 'utf8'));
      recordMigration.run(file);
    }
    sql.exec('COMMIT');
  } catch (error) {
    sql.exec('ROLLBACK');
    sql.close();
    throw error;
  }
  function prepare(query, args = []) {
    return {
      bind: (...values) => prepare(query, values),
      first: () => sql.prepare(query).get(...args) ?? null,
      all: () => ({ results: sql.prepare(query).all(...args) }),
      run: () => ({ meta: { changes: Number(sql.prepare(query).run(...args).changes) } }),
    };
  }
  return {
    sql, prepare,
    batch(entries) {
      sql.exec('BEGIN IMMEDIATE');
      try {
        const results = entries.map((entry) => entry.run());
        sql.exec('COMMIT');
        return results;
      } catch (error) {
        sql.exec('ROLLBACK');
        throw error;
      }
    },
  };
}
