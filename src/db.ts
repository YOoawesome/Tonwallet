import sqlite3 from 'sqlite3';

export const db = new sqlite3.Database('./database.db');

export function initDb() {
  db.run(`
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      wallet_address TEXT,
      ton_amount REAL,
      coin_amount REAL,
      status TEXT DEFAULT 'pending',
      tx_hash TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS balances (
      wallet_address TEXT PRIMARY KEY,
      coins REAL DEFAULT 0
    )
  `);
}
