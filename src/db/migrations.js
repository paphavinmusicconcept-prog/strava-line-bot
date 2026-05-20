const fs = require("fs");
const path = require("path");

async function ensureMigrationTable(db) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

async function runMigrations(db, options = {}) {
  const migrationsDir =
    options.migrationsDir || path.join(__dirname, "..", "..", "migrations");

  await ensureMigrationTable(db);

  const files = fs
    .readdirSync(migrationsDir)
    .filter(file => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const id = file.replace(/\.sql$/, "");
    const existing = await db.query(
      "SELECT id FROM schema_migrations WHERE id = $1",
      [id]
    );
    if (existing.rows.length > 0) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
    await db.query("BEGIN");
    try {
      await db.query(sql);
      await db.query("INSERT INTO schema_migrations (id) VALUES ($1)", [id]);
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  }
}

module.exports = { runMigrations };
