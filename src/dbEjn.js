// Separate database from convoca.sqlite, per the FondBiH build brief §0/§5: "second
// deployment of the same repo... separate DB" - a different domain (BiH procurement, not
// Spanish grants/licitaciones) with its own schema, not a country column bolted onto
// grant_row/licitacion_row. Selected by config (EJN_DB_PATH), same pattern as db.js's
// own DB_PATH, so a FondBiH deployment just points this at its own file.
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.EJN_DB_PATH || path.join(__dirname, '..', 'db', 'fondbih.sqlite');

export const dbEjn = new Database(DB_PATH);
dbEjn.pragma('journal_mode = WAL');
dbEjn.pragma('foreign_keys = ON');

const schema = readFileSync(path.join(__dirname, '..', 'db', 'schema-ejn.sql'), 'utf-8');
dbEjn.exec(schema);

export const uuidEjn = () => crypto.randomUUID();

// FondBiH's own alert(), writing into its own ingest_alert table (schema-ejn.sql) -
// deliberately not convoca's src/ingest/bdns.js alert(), which targets convoca.sqlite.
// See schema-ejn.sql's comment on ingest_alert for why the two must never be the same table.
const insertAlert = dbEjn.prepare('INSERT INTO ingest_alert (id, source, message) VALUES (?, ?, ?)');
export function alertEjn(source, message) {
  insertAlert.run(uuidEjn(), source, String(message).slice(0, 2000));
  console.error(`[ALERT:${source}] ${message}`);
}
