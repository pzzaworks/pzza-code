// Read-only access to an agent's own SQLite database. The database belongs to
// the agent (often open in WAL mode while it runs), so it is opened read-only,
// queried, and closed again; a missing, locked or unexpected database yields
// nothing instead of an error or a made-up zero.

let sqlite = null;
async function driver() {
  if (!sqlite) sqlite = await import("node:sqlite");
  return sqlite;
}

/**
 * Runs `read(db, columns)` against `file` opened read-only, where
 * `columns(table)` lists a table's column names (empty when it is missing), so
 * readers can adapt to the agent's schema version. Returns null on any failure.
 */
export async function readDatabase(file, read) {
  let db;
  try {
    const { DatabaseSync } = await driver();
    db = new DatabaseSync(file, { readOnly: true });
    const cache = new Map();
    const columns = (table) => {
      if (!cache.has(table)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) return new Set();
        cache.set(table, new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => String(row.name))));
      }
      return cache.get(table);
    };
    return read(db, columns);
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}

// `column` when the table has it, else a literal fallback, for SELECT lists.
export const columnOr = (columns, name, fallback = "NULL") => (columns.has(name) ? `"${name}"` : fallback);
