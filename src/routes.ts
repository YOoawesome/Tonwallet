// backend/src/routes.ts
import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from './db';
import { findPayment } from './ton';

const router = Router();

/**
 * INTERNAL RATE
 * 1 USDT = 5 coins (unchanged)
 */
const RATE = 5;

/**
 * TON treasury wallet
 */
const TREASURY = process.env.TREASURY_ADDRESS!;

/* =========================
   HEALTH CHECK
========================= */
router.get('/test', (_req, res) => {
  res.json({ status: 'alive' });
});

/* =========================
   CREATE TON ORDER (WALLET REQUIRED)
========================= */
router.post('/create-order', (req, res) => {
  const { wallet, tonAmount } = req.body;

  if (!wallet || !tonAmount) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const orderId = uuid();
  const coinAmount = tonAmount * RATE;

  // Track blockchain order
  db.run(
    `INSERT INTO orders (id, wallet_address, ton_amount, coin_amount)
     VALUES (?, ?, ?, ?)`,
    [orderId, wallet, tonAmount, coinAmount]
  );

  // Ensure user exists
  db.run(
    `INSERT OR IGNORE INTO users (wallet, coins)
     VALUES (?, 0)`,
    [wallet]
  );

  // Transaction history
  db.run(
    `INSERT INTO transactions
     (order_id, wallet, method, ton_amount, coin_amount, status)
     VALUES (?, ?, 'ton', ?, ?, 'pending')`,
    [orderId, wallet, tonAmount, coinAmount]
  );

  res.json({
    orderId,
    payTo: TREASURY,
    amount: tonAmount,
    memo: orderId,
  });
});

/* =========================
   CONFIRM PAYMENT (TON + PAYSTACK)
========================= */
router.post('/confirm', async (req, res) => {
  const { orderId } = req.body;

  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  db.get(
    `SELECT * FROM transactions WHERE order_id = ?`,
    [orderId],
    async (_err, tx: any) => {
      if (!tx) return res.status(404).json({ error: 'Not found' });
      if (tx.status === 'paid') return res.json({ status: 'already_confirmed' });

      // TON verification
      if (tx.method === 'ton') {
        const found = await findPayment(
          TREASURY,
          tx.ton_amount,
          tx.order_id
        );
        if (!found) return res.json({ status: 'pending' });
      }

      // Credit coins if wallet exists
      if (tx.wallet) {
        db.run(
          `UPDATE users SET coins = coins + ? WHERE wallet = ?`,
          [tx.coin_amount, tx.wallet]
        );
      }

      db.run(
        `UPDATE transactions SET status = 'paid' WHERE order_id = ?`,
        [orderId]
      );

      res.json({ status: 'paid' });
    }
  );
});

/* =========================
   BALANCE
========================= */
router.get('/balance/:wallet', (req, res) => {
  db.get(
    `SELECT coins FROM users WHERE wallet = ?`,
    [req.params.wallet],
    (_err, row: any) => {
      res.json({ coins: row?.coins || 0 });
    }
  );
});

/* =========================
   HISTORY
========================= */
router.get('/history/:wallet', (req, res) => {
  db.all(
    `SELECT order_id, method, ton_amount, naira_amount,
            coin_amount, status, created_at
     FROM transactions
     WHERE wallet = ?
     ORDER BY created_at DESC`,
    [req.params.wallet],
    (_err, rows) => res.json(rows || [])
  );
});

/* =========================
   PAYSTACK INIT (NO WALLET)
   - Locks USDT rate
========================= */
router.post('/paystack/init', (req, res) => {
  const { email, nairaAmount, usdtAmount, usdtRate } = req.body;

  if (!email || !nairaAmount || !usdtAmount || !usdtRate) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  const orderId = uuid();
  const coinAmount = usdtAmount * RATE;

  db.run(
    `INSERT INTO transactions
     (order_id, method, naira_amount, usdt_amount, usdt_rate, coin_amount, status)
     VALUES (?, 'paystack', ?, ?, ?, ?, 'pending')`,
    [orderId, nairaAmount, usdtAmount, usdtRate, coinAmount]
  );

  res.json({
    reference: orderId,
    amount: nairaAmount * 100,
    email,
  });
});

/* =========================
   PAYSTACK WEBHOOK (PRODUCTION SAFE)
========================= */
router.post('/paystack/webhook', (req, res) => {
  const event = req.body;

  if (event.event !== 'charge.success') return res.sendStatus(200);

  const reference = event.data.reference;

  db.run(
    `UPDATE transactions SET status='paid' WHERE order_id=?`,
    [reference]
  );

  res.sendStatus(200);
});

/* =========================
   LINK WALLET AFTER PAYSTACK
========================= */
router.post('/link-wallet', (req, res) => {
  const { orderId, wallet } = req.body;

  if (!orderId || !wallet) {
    return res.status(400).json({ error: 'Invalid request' });
  }

  db.run(
    `INSERT OR IGNORE INTO users (wallet, coins)
     VALUES (?, 0)`,
    [wallet]
  );

  db.get(
    `SELECT * FROM transactions WHERE order_id=? AND status='paid'`,
    [orderId],
    (_err, tx: any) => {
      if (!tx) return res.status(404).json({ error: 'Payment not confirmed' });

      db.run(
        `UPDATE users SET coins = coins + ? WHERE wallet = ?`,
        [tx.coin_amount, wallet]
      );

      db.run(
        `UPDATE transactions SET wallet=? WHERE order_id=?`,
        [wallet, orderId]
      );

      res.json({ status: 'wallet_linked' });
    }
  );
});

export { router };
