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

export const uuid = () => crypto.randomUUID();
