// backend/routes.ts
import { Router } from "express";
import { v4 as uuid } from "uuid";
import { db } from "./db";
import express from "express";
import { Address } from "@ton/core";
import {
  findUsdtJettonTransfer,
  getJettonWallet,
  buildUsdtPayload
} from "./jetton";

const router = Router();

const TREASURY = process.env.TREASURY_ADDRESS!;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY!;


// ===== Health =====
router.get("/test", (_req, res) => res.json({ status: "alive" }));

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

// ===== INIT USDT PAYMENT =====
router.post("/usdt/init", async (req, res) => {
  try {
    const { wallet, usdtAmount } = req.body;
    if (!wallet || !usdtAmount || Number(usdtAmount) <= 0) {
      return res.status(400).json({ error: "Invalid request" });
    }

    const orderId = uuid();

    db.run(
      `INSERT INTO transactions (order_id, wallet, method, usdt_amount, status)
       VALUES (?, ?, 'usdt_jetton', ?, 'pending')`,
      [orderId, wallet, usdtAmount]
    );

    db.run(`INSERT OR IGNORE INTO users (wallet, usdt_balance) VALUES (?, 0)`, [wallet]);

    // 1️⃣ User jetton wallet
    const jettonWalletRaw = await getJettonWallet(wallet);
    const jettonWallet = Address.parse(jettonWalletRaw).toString({
      bounceable: true,
      testOnly: false,
    });

    // 2️⃣ Convert USDT → jetton units (6 decimals)
    const jettonAmount = Math.floor(Number(usdtAmount) * 1e6);

    // 3️⃣ Build payload → base64
    const payload = buildUsdtPayload(jettonAmount, TREASURY, wallet);

    res.json({
      orderId,
      jettonWallet,
      jettonAmount,
      payload,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "USDT init failed" });
  }
});

// ===== CONFIRM PAYMENT =====
router.post("/usdt/confirm", (req, res) => {
  const { orderId } = req.body;
  if (!orderId) return res.status(400).json({ error: "orderId required" });

  db.get(
    `SELECT * FROM transactions WHERE order_id=? AND status='pending'`,
    [orderId],
    async (_err, tx: any) => {
      if (!tx) return res.json({ status: "not_found" });

      const confirmed = await findUsdtJettonTransfer(tx.wallet, tx.usdt_amount);

      if (!confirmed) return res.json({ status: "pending" });

      db.run(`UPDATE users SET usdt_balance = usdt_balance + ? WHERE wallet=?`, [tx.usdt_amount, tx.wallet]);
      db.run(`UPDATE transactions SET status='paid' WHERE order_id=?`, [orderId]);

      res.json({ status: "paid" });
    }
  );
});


// ===== Paystack Init =====
router.post("/paystack/init", async (req, res) => {
  const { email, nairaAmount, usdtAmount } = req.body;
  if (!email || !nairaAmount || !usdtAmount)
    return res.status(400).json({ error: "Missing fields" });

  const reference = uuid(); // Local reference
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

    if (event.event === "charge.success") {
      const reference = event.data.reference;
      const usdtAmount = event.data.metadata?.usdtAmount || 0;

      db.get(
        `SELECT * FROM transactions WHERE order_id=?`,
        [reference],
        (_err, tx: any) => {
          if (!tx || tx.status === "paid") return res.sendStatus(200);

          // Mark transaction as paid
          db.run(
            `UPDATE transactions SET status='paid', usdt_amount=? WHERE order_id=?`,
            [usdtAmount, reference]
          );

          // Update user's wallet balance if wallet exists
          if (tx.wallet) {
            db.run(
              `UPDATE users SET usdt_balance = usdt_balance + ? WHERE wallet=?`,
              [usdtAmount, tx.wallet]
            );
          }

          res.sendStatus(200);
        }
      );
    } else {
      res.sendStatus(200);
    }
  } catch (err) {
    console.error(err);
    res.sendStatus(500);
  }
});

// ===== Link Wallet after Paystack =====
router.post("/link-wallet", (req, res) => {
  const { orderId, wallet } = req.body;
  if (!orderId || !wallet) return res.status(400).json({ error: "Invalid request" });

  db.run(`INSERT OR IGNORE INTO users (wallet, usdt_balance) VALUES (?, 0)`, [wallet]);

  db.get(
    `SELECT * FROM transactions WHERE order_id=? AND status='paid'`,
    [orderId],
    (_err, tx: any) => {
      if (!tx) return res.status(404).json({ error: "Payment not confirmed" });

      db.run(
        `UPDATE users SET usdt_balance = usdt_balance + ? WHERE wallet=?`,
        [tx.usdt_amount, wallet]
      );

      db.run(`UPDATE transactions SET wallet=? WHERE order_id=?`, [wallet, orderId]);

      res.json({ status: "wallet_linked" });
    }
  );
});

export { router };
