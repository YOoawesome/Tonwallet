
import sqlite3 from 'sqlite3';

export const db = new sqlite3.Database('./database.db');

export function initDb() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      wallet TEXT PRIMARY KEY,
      usdt_balance REAL DEFAULT 0
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS transactions (
      order_id TEXT PRIMARY KEY,
      wallet TEXT,
      method TEXT,
      ton_amount REAL DEFAULT 0,
      naira_amount REAL DEFAULT 0,
      usdt_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'pending',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}
