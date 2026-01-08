import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from './db';
import { findPayment } from './ton';
import fetch from 'node-fetch';

const router = Router();

/**
 * SIDE NOTE:
 * - Backend logic is USDT-only
 * - UI can show NGN or USDT
 * - Wallet balance is recorded server-side and persists after refresh
 */

/**
 * TON treasury wallet
 */
const TREASURY = process.env.TREASURY_ADDRESS!;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY!;

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

  if (!wallet || !tonAmount) return res.status(400).json({ error: 'Invalid request' });

  const orderId = uuid();

  db.run(
    `INSERT INTO transactions
     (order_id, wallet, method, ton_amount, status)
     VALUES (?, ?, 'ton', ?, 'pending')`,
    [orderId, wallet, tonAmount]
  );

  db.run(
    `INSERT OR IGNORE INTO users (wallet, usdt_balance)
     VALUES (?, 0)`,
    [wallet]
  );

  res.json({
    orderId,
    payTo: TREASURY,
    amount: tonAmount,
    payload: orderId,
  });
});

/* =========================
   CONFIRM PAYMENT (TON + PAYSTACK)
========================= */
router.post('/confirm', async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: 'orderId required' });

  db.get(`SELECT * FROM transactions WHERE order_id = ?`, [orderId], async (_err, tx: any) => {
    if (!tx) return res.status(404).json({ error: 'Not found' });
    if (tx.status === 'paid') return res.json({ status: 'already_confirmed' });

    if (tx.method === 'ton') {
      const found = await findPayment(TREASURY, tx.ton_amount, tx.order_id);
      if (!found) return res.json({ status: 'pending' });
    }

    if (tx.wallet) {
      const amount = tx.ton_amount || tx.usdt_amount || 0;
      db.run(`UPDATE users SET usdt_balance = usdt_balance + ? WHERE wallet = ?`, [amount, tx.wallet]);
    }

    db.run(`UPDATE transactions SET status = 'paid' WHERE order_id = ?`, [orderId]);
    res.json({ status: 'paid' });
  });
});

/* =========================
   BALANCE
========================= */
router.get('/balance/:wallet', (req, res) => {
  db.get(
    `SELECT usdt_balance FROM users WHERE wallet = ?`,
    [req.params.wallet],
    (_err, row: any) => {
      res.json({ usdt_balance: row?.usdt_balance || 0 });
    }
  );
});

/* =========================
   HISTORY
========================= */
router.get('/history/:wallet', (req, res) => {
  db.all(
    `SELECT order_id, method, ton_amount, naira_amount, usdt_amount, status, created_at
     FROM transactions
     WHERE wallet = ?
     ORDER BY created_at DESC`,
    [req.params.wallet],
    (_err, rows) => res.json(rows || [])
  );
});

/* =========================
   PAYSTACK INIT
========================= */
router.post('/paystack/init', async (req, res) => {
  const { email, nairaAmount, usdtAmount } = req.body;
  if (!email || !nairaAmount || !usdtAmount)
    return res.status(400).json({ error: 'Invalid request' });

  try {
    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        amount: nairaAmount * 100, // Paystack expects kobo
        callback_url: "https://yourfrontend.com/callback", // optional
        metadata: { usdtAmount },
      }),
    });

    const data: any = await response.json();

    if (!data?.status) return res.status(500).json({ error: 'Paystack initialization failed' });

    db.run(
      `INSERT INTO transactions
       (order_id, method, naira_amount, usdt_amount, status)
       VALUES (?, 'paystack', ?, ?, 'pending')`,
      [data.data.reference, nairaAmount, usdtAmount]
    );

    res.json({
      authorization_url: data.data.authorization_url,
      reference: data.data.reference,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Paystack init error' });
  }
});

/* =========================
   PAYSTACK WEBHOOK
========================= */
router.post('/paystack/webhook', (req, res) => {
  try {
    const event: any = JSON.parse(req.body.toString());
    if (event.event !== 'charge.success') return res.sendStatus(200);

    const reference = event.data.reference;
    const usdtAmount = event.data.metadata?.usdtAmount || 0;

    db.get(`SELECT * FROM transactions WHERE order_id=?`, [reference], (_err, tx: any) => {
      if (!tx || tx.status === 'paid') return res.sendStatus(200);

      db.run(
        `UPDATE transactions SET status='paid', usdt_amount=? WHERE order_id=?`,
        [usdtAmount, reference]
      );

      res.sendStatus(200);
    });
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

/* =========================
   LINK WALLET AFTER PAYSTACK
========================= */
router.post('/link-wallet', (req, res) => {
  const { orderId, wallet } = req.body;
  if (!orderId || !wallet) return res.status(400).json({ error: 'Invalid request' });

  db.run(`INSERT OR IGNORE INTO users (wallet, usdt_balance) VALUES (?, 0)`, [wallet]);

  db.get(`SELECT * FROM transactions WHERE order_id=? AND status='paid'`, [orderId], (_err, tx: any) => {
    if (!tx) return res.status(404).json({ error: 'Payment not confirmed' });

    db.run(`UPDATE users SET usdt_balance = usdt_balance + ? WHERE wallet = ?`, [tx.usdt_amount, wallet]);
    db.run(`UPDATE transactions SET wallet=? WHERE order_id=?`, [wallet, orderId]);

    res.json({ status: 'wallet_linked' });
  });
});

export { router };
