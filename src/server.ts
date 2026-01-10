// server.ts
import express from 'express';
import cors from 'cors';
import { initDb } from './db';
import { router } from './routes';
import dotenv from 'dotenv';
dotenv.config();

initDb();

const app = express();

app.use(cors({ origin: ["https://terraminttoken.com", "http://localhost:5173"], methods: ["GET","POST","OPTIONS"], allowedHeaders:["Content-Type"] }));

// Paystack webhook uses raw
app.use('/api/paystack/webhook', express.raw({ type: '*/*' }), router);

// Other API routes use JSON parser
app.use('/api', express.json(), router);

app.get('/', (_req,res)=>res.send('API running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=>console.log(`API running on port ${PORT}`));
