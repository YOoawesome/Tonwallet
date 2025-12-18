// src/ton.ts
import fetch from "node-fetch";

const TONAPI_KEY = process.env.TONAPI_KEY!;
const NETWORK = "testnet"; // change to "mainnet" later

export async function findPayment(
  treasuryAddress: string,
  expectedTon: number,
  memo: string
) {
  const url = `https://${NETWORK}.tonapi.io/v2/blockchain/accounts/${treasuryAddress}/transactions?limit=20`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TONAPI_KEY}`,
    },
  });

  const data: any = await res.json();

  for (const tx of data.transactions) {
    // incoming only
    if (!tx.in_msg) continue;

    const valueTon = Number(tx.in_msg.value) / 1e9;
    const comment = tx.in_msg.comment || "";

    if (
      valueTon >= expectedTon &&
      comment === memo
    ) {
      return {
        transaction_id: tx.hash,
      };
    }
  }

  return null;
}
