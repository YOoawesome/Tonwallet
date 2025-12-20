import express from 'express';
import cors from 'cors';
import { initDb } from './db';
import { router } from './routes';

initDb();

const app = express();

// ✅ Explicitly allow your frontend origin
app.use(
  cors({
    origin: "https://terraminttoken.com",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

app.use(express.json());
app.use('/api', router);

app.listen(3000, () => console.log('API running on :3000'));
