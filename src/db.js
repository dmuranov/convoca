import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'db', 'convoca.sqlite');

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf-8');
db.exec(schema);

// schema.sql only CREATEs IF NOT EXISTS, so columns added later need backfilling here.
const cols = new Set(db.prepare('PRAGMA table_info(grant_row)').all().map(c => c.name));
for (const [name, decl] of [['plain_title', 'TEXT'], ['sede_url', 'TEXT'], ['plain_explainer', 'TEXT'],
                            ['region', 'TEXT'], ['skip_reason', 'TEXT'], ['province', 'TEXT'],
                            ['municipality', 'TEXT'], ['plain_checklist', 'TEXT'],
                            ['closed_at', 'TEXT'], ['archived_at', 'TEXT']]) {
  if (!cols.has(name)) db.exec(`ALTER TABLE grant_row ADD COLUMN ${name} ${decl}`);
}
const licCols = new Set(db.prepare('PRAGMA table_info(licitacion_row)').all().map(c => c.name));
for (const [name, decl] of [['ccaa', 'TEXT']]) {
  if (!licCols.has(name)) db.exec(`ALTER TABLE licitacion_row ADD COLUMN ${name} ${decl}`);
}

export const uuid = () => crypto.randomUUID();
