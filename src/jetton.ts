/**
 * Jetton utilities for USDT transfers on TON blockchain
 * Production-ready using JSON-RPC runGetMethod
 * Fully TypeScript-safe
 */

import { Address, Cell, beginCell } from "ton-core";
import dotenv from "dotenv";
import fetch from "node-fetch"; // npm i node-fetch@2

dotenv.config();

// =======================
// ENVIRONMENT HELPER
// =======================
function getEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`${name} not set in .env`);
  return val;
}

// =======================
// CONFIG VARIABLES
// =======================
const TON_RPC_URL: string = getEnv("TON_RPC_URL");
const USDT_JETTON_MASTER: Address = Address.parse(getEnv("USDT_JETTON_MASTER"));

// =======================
// HELPER: JSON-RPC runGetMethod
// =======================
async function runGetMethodRpc(
  address: string,
  method: string,
  stack: { type: string; cell?: string }[] = []
) {
  const body = {
    id: 1,
    jsonrpc: "2.0",
    method: "runGetMethod",
    params: { address, method, stack },
  };

  const response = await fetch(TON_RPC_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const json = await response.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result;
}

// =======================
// BUILD USDT TRANSFER PAYLOAD
// =======================
export function buildUsdtPayload(
  amount: number,
  treasury: string,
  userWallet: string
): string {
  const transferCell = beginCell()
    .storeUint(0x01, 32) // Transfer op code
    .storeCoins(BigInt(amount) * 1_000_000n) // Amount in smallest units (6 decimals)
    .storeAddress(Address.parse(userWallet)) // Recipient
    .storeAddress(Address.parse(treasury)) // Treasury
    .endCell();

  return transferCell.toBoc({ idx: false }).toString("base64");
}

// =======================
// GET USER JETTON WALLET
// =======================
export async function getJettonWallet(userWallet: string): Promise<string> {
  const userAddr: Address = Address.parse(userWallet);

  const stack = [
    {
      type: "cell",
      cell: beginCell().storeAddress(userAddr).endCell().toBoc({ idx: false }).toString("base64"),
    },
  ];

  const result = await runGetMethodRpc(USDT_JETTON_MASTER.toString(), "get_wallet_address", stack);

  if (!result.stack?.length) throw new Error("Failed to fetch Jetton wallet");

  const cellBoc = result.stack[0].cell;
  if (!cellBoc) throw new Error("Invalid Jetton wallet response");

  const cell: Cell = Cell.fromBoc(Buffer.from(cellBoc, "base64"))[0];
  const slice = cell.beginParse();
  const addr = slice.loadAddress();

  if (!addr) throw new Error("Failed to parse Jetton wallet");

  return addr.toString();
}

// =======================
// VERIFY USDT TRANSFER
// =======================
export async function findUsdtJettonTransfer(
  userWallet: string,
  expectedAmount: number
): Promise<boolean> {
  const jettonWallet = await getJettonWallet(userWallet);
  const result = await runGetMethodRpc(jettonWallet, "get_transaction_history");

  const expected: bigint = BigInt(expectedAmount) * 1_000_000n;

  for (const item of result.stack) {
    if (item.type === "tuple" && item.items.length >= 2) {
      const inAmount = item.items[0];
      if (inAmount.type === "int" && BigInt(inAmount.value) === expected) {
        return true;
      }
    }
  }
  return false;
}
