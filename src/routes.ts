// backend/routes.ts
import { Router } from "express";
import { v4 as uuid } from "uuid";
import express from "express";
import { db } from "./db";

const router = Router();

const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY!;

// ===== Health =====
router.get("/test", (_req, res) => {
  res.json({ status: "alive" });
});

// ===== Wallet Balance =====
router.get("/balance/:wallet", (req, res) => {
  db.get(
    `SELECT usdt_balance FROM users WHERE wallet=?`,
    [req.params.wallet],
    (_err, row: any) => {
      res.json({ usdt_balance: row?.usdt_balance || 0 });
    }
  );
});

// ===== Paystack Init =====
router.post("/paystack/init", (req, res) => {
  const { email, nairaAmount, usdtAmount } = req.body;

  if (!email || !nairaAmount || !usdtAmount) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const reference = uuid();

  db.run(
    `INSERT INTO transactions (order_id, method, naira_amount, usdt_amount, status)
     VALUES (?, 'paystack', ?, ?, 'pending')`,
    [reference, nairaAmount, usdtAmount]
  );

  res.json({ reference });
});

// ===== Paystack Webhook =====
router.post("/paystack/webhook", express.raw({ type: "*/*" }), (req, res) => {
  try {
    const event = JSON.parse(req.body.toString());

    if (event.event !== "charge.success") {
      return res.sendStatus(200);
    }

    const reference = event.data.reference;
    const usdtAmount = event.data.metadata?.usdtAmount || 0;

    db.get(
      `SELECT * FROM transactions WHERE order_id=?`,
      [reference],
      (_err, tx: any) => {
        if (!tx || tx.status === "paid") {
          return res.sendStatus(200);
        }

        // Mark transaction as paid
        db.run(
          `UPDATE transactions SET status='paid', usdt_amount=? WHERE order_id=?`,
          [usdtAmount, reference]
        );

        // Credit wallet if already linked
        if (tx.wallet) {
          db.run(
            `UPDATE users SET usdt_balance = usdt_balance + ? WHERE wallet=?`,
            [usdtAmount, tx.wallet]
          );
        }

        res.sendStatus(200);
      }
    );
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// ===== Link Wallet After Paystack Payment =====
router.post("/link-wallet", (req, res) => {
  const { orderId, wallet } = req.body;

  if (!orderId || !wallet) {
    return res.status(400).json({ error: "Invalid request" });
  }

  db.run(
    `INSERT OR IGNORE INTO users (wallet, usdt_balance)
     VALUES (?, 0)`,
    [wallet]
  );

  db.get(
    `SELECT * FROM transactions WHERE order_id=? AND status='paid'`,
    [orderId],
    (_err, tx: any) => {
      if (!tx) {
        return res.status(404).json({ error: "Payment not confirmed" });
      }

      db.run(
        `UPDATE users SET usdt_balance = usdt_balance + ? WHERE wallet=?`,
        [tx.usdt_amount, wallet]
      );

      db.run(
        `UPDATE transactions SET wallet=? WHERE order_id=?`,
        [wallet, orderId]
      );

      res.json({ status: "wallet_linked" });
    }
  );
});

export { router };
