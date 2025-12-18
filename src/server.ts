// src/server.ts
import express from 'express';
import cors from 'cors';
import { initDb } from './db';
import { router } from './routes';

initDb();

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', router);

app.listen(3000, () => console.log('API running on :3000'));