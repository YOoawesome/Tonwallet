// backend/routes.ts
/**
 * ROUTES
 * Handles USDT Jetton payments via TON + balance tracking
 * All payloads are generated server-side and passed raw to frontend
 */

import { Router } from "express";
import { v4 as uuid } from "uuid";
import express from "express";
import { db } from "./db";
import { Address } from "@ton/core";
import dotenv from "dotenv";
import {
  getJettonWallet,
  buildUsdtPayload,
  findUsdtJettonTransfer
} from "./jetton";
import debug from "debug";

const router = Router();


  
 
const log = debug("wallet:routes");
// =======================
// ENV
// =======================
const TREASURY = process.env.TREASURY_ADDRESS!;
if (!TREASURY) throw new Error("TREASURY_ADDRESS not set");

// =======================
// HEALTH CHECK
// =======================
router.get("/test", (_req, res) => {
  
  res.json({ status: "alive" });
});

// =======================
// FETCH USER BALANCE
// =======================
router.get("/balance/:wallet", (req, res) => {
   log("Incoming /usdt/init request:", req.body);
  const wallet = req.params.wallet;

  db.get(
    `SELECT usdt_balance FROM users WHERE wallet=?`,
    [wallet],
    (_err, row: any) => {
      res.json({ usdt_balance: row?.usdt_balance || 0 });
    }
  );
});

// =======================
// INIT USDT PAYMENT (TON JETTON)
// =======================
router.post("/usdt/init", async (req, res) => {
  /**
   * SIDE NOTE:
   * This endpoint:
   * 1. Creates an order
   * 2. Resolves user's Jetton wallet
   * 3. Builds a VALID Jetton transfer payload (base64)
   * 4. Returns everything needed for TonConnect sendTransaction
   */

  try {
    const { wallet, usdtAmount } = req.body;
    

    if (!wallet || !usdtAmount || Number(usdtAmount) <= 0) {
      return res.status(400).json({ error: "Invalid request" });
    } 

    const orderId = uuid();

    // Store transaction
    db.run(
      `INSERT INTO transactions (order_id, wallet, method, usdt_amount, status)
       VALUES (?, ?, 'usdt_jetton', ?, 'pending')`,
      [orderId, wallet, usdtAmount]
    );

    // Ensure user exists
    db.run(
      `INSERT OR IGNORE INTO users (wallet, usdt_balance)
       VALUES (?, 0)`,
      [wallet]
    );

    // =======================
    // 1️⃣ Resolve user's Jetton wallet
    // =======================
    const jettonWalletRaw = await getJettonWallet(wallet);
    console.log("Resolved Jetton wallet:", jettonWalletRaw);

    const jettonWallet = Address.parse(jettonWalletRaw).toString({
      bounceable: true,
      testOnly: false
    });
    
    // =======================
    // 2️⃣ Convert USDT → jetton units (6 decimals)
    // =======================
    const jettonAmount = Math.floor(Number(usdtAmount) * 1_000_000);
      console.log("Jetton amount:", jettonAmount);
    // =======================
    // 3️⃣ Build Jetton transfer payload
    // =======================
    /**
     * SIDE NOTE:
     * buildUsdtPayload RETURNS base64 already.
     * DO NOT encode again.
     * DO NOT stringify.
     */
    const payload = buildUsdtPayload(
      jettonAmount,
      TREASURY,
      wallet
    );
    console.log("Payload built:", payload);
 console.log("===== USDT INIT DEBUG =====");
console.log("USER WALLET:", wallet);
console.log("JETTON WALLET:", jettonWallet);
console.log("TREASURY:", TREASURY);
console.log("JETTON AMOUNT:", jettonAmount);
console.log("PAYLOAD TYPE:", typeof payload);
console.log("PAYLOAD LENGTH:", payload.length);
console.log("PAYLOAD (first 50 chars):", payload.slice(0, 50));
console.log("BASE64 SAFE:", /^[A-Za-z0-9+/=]+$/.test(payload));
console.log("===========================");

    // =======================
    // RESPONSE
    // =======================
    res.json({
      orderId,
      jettonWallet,
      jettonAmount,
      payload
    });
  } catch (err) {
    console.error("USDT INIT ERROR:", err);
    res.status(500).json({ error: "USDT init failed" });
  }
});

if (process.env.NODE_ENV !== "production") {
  console.log("Debug mode active");
}


// =======================
// CONFIRM USDT PAYMENT
// =======================
router.post("/usdt/confirm", (req, res) => {
  /**
   * SIDE NOTE:
   * Polls blockchain to confirm Jetton transfer
   * Credits user balance once detected
   */

  const { orderId } = req.body;
  if (!orderId) {
    return res.status(400).json({ error: "orderId required" });
  }

  db.get(
    `SELECT * FROM transactions
     WHERE order_id=? AND status='pending'`,
    [orderId],
    async (_err, tx: any) => {
      if (!tx) return res.json({ status: "not_found" });

      const confirmed = await findUsdtJettonTransfer(
        tx.wallet,
        tx.usdt_amount
      );

      if (!confirmed) {
        return res.json({ status: "pending" });
      }

      // Credit balance
      db.run(
        `UPDATE users
         SET usdt_balance = usdt_balance + ?
         WHERE wallet=?`,
        [tx.usdt_amount, tx.wallet]
      );

      // Mark paid
      db.run(
        `UPDATE transactions
         SET status='paid'
         WHERE order_id=?`,
        [orderId]
      );

      res.json({ status: "paid" });
    }
  );
});

export { router };
