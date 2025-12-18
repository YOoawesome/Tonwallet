// src/routes.ts
import { Router, Request, Response } from 'express';
import { v4 as uuid } from 'uuid';
import { db } from './db';
import { findPayment } from './ton';

const router = Router();

const RATE = 5; // 1 TON = 5 coins
const TREASURY = process.env.TREASURY_ADDRESS!;

// ✅ test route
router.get('/test', (req: Request, res: Response) => {
  res.json({ status: 'alive' });
});

// ✅ create order
router.post('/create-order', (req: Request, res: Response) => {
  const { wallet, tonAmount } = req.body;

  const id = uuid();
  const coins = tonAmount * RATE;

  db.run(
    `INSERT INTO orders (id, wallet_address, ton_amount, coin_amount)
     VALUES (?, ?, ?, ?)`,
    [id, wallet, tonAmount, coins]
  );

  res.json({
    orderId: id,
    payTo: TREASURY,
    amount: tonAmount,
    memo: id
  });
});

// ✅ confirm payment
router.post('/confirm', async (req: Request, res: Response) => {
  const { orderId } = req.body;

  db.get(
    `SELECT * FROM orders WHERE id = ?`,
    [orderId],
    async (err, order: any) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      if (!order) {
        return res.status(404).end();
      }

      const tx = await findPayment(
        TREASURY,
        order.ton_amount,
        order.id
      );

      if (!tx) {
        return res.json({ status: 'pending' });
      }

      db.run(
        `UPDATE orders SET status='paid', tx_hash=? WHERE id=?`,
        [tx.transaction_id, orderId]
      );

      db.run(
        `INSERT INTO balances (wallet_address, coins)
         VALUES (?, ?)
         ON CONFLICT(wallet_address)
         DO UPDATE SET coins = coins + ?`,
        [order.wallet_address, order.coin_amount, order.coin_amount]
      );

      res.json({ status: 'paid' });
    }
  );
});

export { router };
