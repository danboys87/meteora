// Pembungkus tipis untuk SDK Meteora DLMM.
import { createRequire } from "module";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";

const require = createRequire(import.meta.url);
const sdk = require("@meteora-ag/dlmm");
const DLMM = sdk.default ?? sdk;
const { StrategyType } = sdk;

if (!process.env.RPC_URL) throw new Error("RPC_URL kosong di .env");
export const conn = new Connection(process.env.RPC_URL, "confirmed");

function loadWallet() {
  const raw = (process.env.WALLET_PRIVATE_KEY || "").trim();
  if (!raw) throw new Error("WALLET_PRIVATE_KEY kosong di .env");
  const bytes = raw.startsWith("[") ? Uint8Array.from(JSON.parse(raw)) : bs58.decode(raw);
  return Keypair.fromSecretKey(bytes);
}
export const wallet = loadWallet();

export async function solBalance() {
  return (await conn.getBalance(wallet.publicKey)) / 1e9;
}

async function sendAll(txs, signers) {
  const list = Array.isArray(txs) ? txs : [txs];
  const sigs = [];
  for (const tx of list) sigs.push(await sendAndConfirmTransaction(conn, tx, signers));
  return sigs;
}

// Deposit SOL saja (token Y), bid-ask di bawah harga aktif.
export async function deploy(poolAddr, solAmount, binsBelow) {
  const dlmm = await DLMM.create(conn, new PublicKey(poolAddr));
  const active = await dlmm.getActiveBin();
  const position = Keypair.generate();
  const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey,
    user: wallet.publicKey,
    totalXAmount: new BN(0),
    totalYAmount: new BN(Math.floor(solAmount * 1e9)),
    strategy: {
      minBinId: active.binId - binsBelow,
      maxBinId: active.binId,
      strategyType: StrategyType.BidAsk,
    },
  });
  const sigs = await sendAll(tx, [wallet, position]);
  return { position: position.publicKey.toString(), sigs };
}

// Ambil kondisi satu posisi. Nilai dihitung dalam SOL (termasuk fee yang belum di-claim).
export async function getPosition(poolAddr, positionAddr) {
  const dlmm = await DLMM.create(conn, new PublicKey(poolAddr));
  const { activeBin, userPositions } = await dlmm.getPositionsByUserAndLbPair(wallet.publicKey);
  const pos = userPositions.find((p) => p.publicKey.toString() === positionAddr);
  if (!pos) return null;
  const d = pos.positionData;
  const n = (b) => Number(b?.toString?.() ?? b ?? 0);
  const price = Number(activeBin.price); // lamport Y per lamport X
  const lamports = n(d.totalYAmount) + n(d.totalXAmount) * price +
                   n(d.feeY) + n(d.feeX) * price;
  return {
    valueSol: lamports / 1e9,
    inRange: activeBin.binId >= d.lowerBinId && activeBin.binId <= d.upperBinId,
    activeBin: activeBin.binId,
    lowerBin: d.lowerBinId,
    upperBin: d.upperBinId,
  };
}

// Tarik semua likuiditas, claim fee, dan tutup posisi.
export async function close(poolAddr, positionAddr, lowerBin, upperBin) {
  const dlmm = await DLMM.create(conn, new PublicKey(poolAddr));
  const txs = await dlmm.removeLiquidity({
    position: new PublicKey(positionAddr),
    user: wallet.publicKey,
    fromBinId: lowerBin,
    toBinId: upperBin,
    bps: new BN(10000),
    shouldClaimAndClose: true,
  });
  return sendAll(txs, [wallet]);
}
