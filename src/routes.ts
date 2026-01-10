// routes.ts
import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from './db';
import fetch from 'node-fetch';
import { findPayment } from './ton';
import express from 'express';


const router = Router();

const TREASURY = process.env.TREASURY_ADDRESS!;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY!;

// ===== Health Check =====
router.get('/test', (_req, res) => res.json({ status: 'alive' }));

// ===== TON Order =====
router.post('/create-order', (req, res) => {
  const { wallet, tonAmount } = req.body;
  if (!wallet || !tonAmount) return res.status(400).json({ error: 'Invalid request' });

  const orderId = uuid();

  db.run(
    `INSERT INTO transactions (order_id, wallet, method, ton_amount, status) VALUES (?, ?, 'ton', ?, 'pending')`,
    [orderId, wallet, tonAmount]
  );

  db.run(`INSERT OR IGNORE INTO users (wallet, usdt_balance) VALUES (?, 0)`, [wallet]);

  res.json({ orderId, payTo: TREASURY, payload: orderId });
});

// ===== Confirm TON =====
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

    db.run(`UPDATE transactions SET status='paid' WHERE order_id=?`, [orderId]);
    res.json({ status: 'paid' });
  });
});

// ===== Balance =====
router.get('/balance/:wallet', (req, res) => {
  db.get(`SELECT usdt_balance FROM users WHERE wallet=?`, [req.params.wallet], (_err, row: any) => {
    res.json({ usdt_balance: row?.usdt_balance || 0 });
  });
});

// ===== Paystack Init =====
router.post('/paystack/init', async (req, res) => {
  try {
    const { email, nairaAmount, usdtAmount } = req.body;
    if (!email || !nairaAmount || !usdtAmount) return res.status(400).json({ error: 'Missing fields' });

    const reference = uuid(); // local reference
    db.run(
      `INSERT INTO transactions (order_id, method, naira_amount, usdt_amount, status) VALUES (?, 'paystack', ?, ?, 'pending')`,
      [reference, nairaAmount, usdtAmount]
    );

    res.json({ reference });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===== Paystack Webhook =====

router.post('/paystack/webhook', express.raw({ type: '*/*' }), (req, res) => {
  const event = JSON.parse(req.body.toString());
  if (event.event === 'charge.success') {
    const reference = event.data.reference;
    const usdtAmount = event.data.metadata?.usdtAmount || 0;

    db.get(`SELECT * FROM transactions WHERE order_id=?`, [reference], (_err, tx: any) => {
      if (!tx || tx.status === 'paid') return res.sendStatus(200);

      // Mark transaction as paid
      db.run(`UPDATE transactions SET status='paid', usdt_amount=? WHERE order_id=?`, [usdtAmount, reference]);

      // Update user's wallet
      if (tx.wallet) {
        db.run(`UPDATE users SET usdt_balance = usdt_balance + ? WHERE wallet = ?`, [usdtAmount, tx.wallet]);
      }

      res.sendStatus(200);
    });
  } else {
    res.sendStatus(200);
  }
});


// ===== Link Wallet after Paystack =====
router.post('/link-wallet', (req, res) => {
  const { orderId, wallet } = req.body;
  if (!orderId || !wallet) return res.status(400).json({ error: 'Invalid request' });

  db.run(`INSERT OR IGNORE INTO users (wallet, usdt_balance) VALUES (?, 0)`, [wallet]);

  db.get(`SELECT * FROM transactions WHERE order_id=? AND status='paid'`, [orderId], (_err, tx: any) => {
    if (!tx) return res.status(404).json({ error: 'Payment not confirmed' });

    db.run(`UPDATE users SET usdt_balance = usdt_balance + ? WHERE wallet=?`, [tx.usdt_amount, wallet]);
    db.run(`UPDATE transactions SET wallet=? WHERE order_id=?`, [wallet, orderId]);

    res.json({ status: 'wallet_linked' });
  });
});

export { router };
