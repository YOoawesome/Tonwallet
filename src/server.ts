import express from 'express';
import cors from 'cors';
import { initDb } from './db';
import { router } from './routes';
import dotenv from 'dotenv';
dotenv.config(); // This loads your .env variables


/**
 * SIDE NOTES:
 * - Database is initialized at startup
 * - CORS is explicitly configured to allow your frontend
 * - Paystack webhook requires raw body parser for signature verification
 * - All other API routes use JSON parser
 * - Server exposes health check at `/`
 */

initDb(); // Initialize SQLite/PostgreSQL database

const app = express();

// ===== CORS CONFIGURATION =====
app.use(
  cors({
    origin: ["https://terraminttoken.com", "http://localhost:5173"], // your frontend URLs
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

// ===== PAYSTACK WEBHOOK =====
// Must use raw parser because Paystack requires exact body for signature verification
app.use('/api/paystack/webhook', express.raw({ type: '*/*' }), router);

// ===== JSON PARSER =====
// For all normal API requests
app.use('/api', express.json(), router);

// ===== HEALTH CHECK =====
app.get('/', (_req, res) => res.send('API running'));

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on port ${PORT}`));
