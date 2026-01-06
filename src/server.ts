import express from 'express';
import cors from 'cors';
import { initDb } from './db';
import { router } from './routes';

// ===== INIT DATABASE =====
initDb();

const app = express();

// ===== CORS =====
// ✅ Explicitly allow your frontend origin
app.use(
  cors({
    origin: ["https://terraminttoken.com", "http://localhost:5173"], // Add localhost for dev
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

// ===== PAYSTACK WEBHOOK =====
// ✅ Must use raw body to validate Paystack signature
app.use('/api/paystack/webhook', express.raw({ type: '*/*' }));

// ===== JSON PARSER =====
// ✅ For normal API requests
app.use(express.json());

// ===== API ROUTES =====
app.use('/api', router);

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`API running on :${PORT}`));
