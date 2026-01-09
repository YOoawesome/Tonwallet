import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from './db';
import { findPayment } from './ton';
import fetch from 'node-fetch';

const router = Router();

/**
 * TON treasury wallet
 */
const TREASURY = process.env.TREASURY_ADDRESS!;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY!;

/* =========================
   HEALTH CHECK
========================= */
router.get('/test', (_req: Request, res: Response) => {
  res.json({ status: 'alive' });
});

/* =========================
   CREATE TON ORDER
========================= */
router.post('/create-order', (req: Request, res: Response) => {
  const { wallet, tonAmount } = req.body as { wallet?: string; tonAmount?: number };
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
   CONFIRM PAYMENT
========================= */
router.post('/confirm', async (req: Request, res: Response) => {
  const { orderId } = req.body as { orderId?: string };
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
router.get('/balance/:wallet', (req: Request, res: Response) => {
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
router.get('/history/:wallet', (req: Request, res: Response) => {
  db.all(
    `SELECT order_id, method, ton_amount, naira_amount, usdt_amount, status, created_at
     FROM transactions
     WHERE wallet = ?
     ORDER BY created_at DESC`,
    [req.params.wallet],
    (_err, rows: any[]) => res.json(rows || [])
  );
});

/* =========================
   PAYSTACK INIT
========================= */
/* =========================
   PAYSTACK INIT - DEBUGGED
========================= */

/**
 * SIDE NOTE:
 * - This endpoint initializes a Paystack transaction
 * - Expects: email (string), nairaAmount (number), usdtAmount (number)
 * - Returns: authorization_url & reference on success
 * - Logs all errors to console for easier debugging
 */

router.post('/paystack/init', async (req: Request, res: Response) => {
  try {
    const { email, nairaAmount, usdtAmount } = req.body as {
      email?: string;
      nairaAmount?: number;
      usdtAmount?: number;
    };

    // ===== VALIDATION =====
    if (!email || !nairaAmount || !usdtAmount) {
      console.error('[PAYSTACK INIT] Missing fields:', req.body);
      return res.status(400).json({ error: 'Missing required fields: email, nairaAmount, usdtAmount' });
    }

    if (typeof nairaAmount !== 'number' || nairaAmount <= 0) {
      return res.status(400).json({ error: 'nairaAmount must be a positive number' });
    }

    if (typeof usdtAmount !== 'number' || usdtAmount <= 0) {
      return res.status(400).json({ error: 'usdtAmount must be a positive number' });
    }

    if (!/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // ===== INITIALIZE PAYSTACK =====
    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        amount: Math.round(nairaAmount * 100), // Paystack expects kobo
        currency: "NGN",
        callback_url: "https://terraminttoken.com/callback", // update as needed
        metadata: { usdtAmount },
      }),
    });

    const data: any = await response.json();

    // ===== CHECK PAYSTACK RESPONSE =====
    if (!data || !data.status) {
      console.error('[PAYSTACK INIT] Failed response from Paystack:', data);
      return res.status(500).json({ error: 'Paystack initialization failed', details: data });
    }

    // ===== RECORD TRANSACTION LOCALLY =====
    db.run(
      `INSERT INTO transactions
       (order_id, method, naira_amount, usdt_amount, status)
       VALUES (?, 'paystack', ?, ?, 'pending')`,
      [data.data.reference, nairaAmount, usdtAmount],
      (err) => {
        if (err) console.error('[PAYSTACK INIT] DB insert error:', err);
      }
    );

    // ===== RETURN AUTH URL =====
    res.json({
      authorization_url: data.data.authorization_url,
      reference: data.data.reference,
    });

  } catch (err) {
    console.error('[PAYSTACK INIT] Exception:', err);
    res.status(500).json({ error: 'Internal server error', details: err });
  }
});



/* =========================
   PAYSTACK WEBHOOK
========================= */
router.post('/paystack/webhook', (req: Request, res: Response) => {
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
router.post('/link-wallet', (req: Request, res: Response) => {
  const { orderId, wallet } = req.body as { orderId?: string; wallet?: string };
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
