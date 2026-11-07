import "dotenv/config";
import fs from "fs";
import { fetchCandidates, fetchPoolPrice } from "./screener.js";
import { paperPosition } from "./paper.js";
import { startServer } from "./server.js";

const cfg = JSON.parse(fs.readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const DRY = process.env.DRY_RUN !== "false";
// DRY (paper) dan LIVE punya file state terpisah supaya posisi virtual tidak tercampur posisi asli.
const STATE_FILE = DRY ? "./state.paper.json" : "./state.json";

// ── util ─────────────────────────────────────────────
const log = (...a) => console.log(new Date().toISOString(), ...a);
const load = () =>
  fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    : { open: {}, cooldown: {}, closed: [] };
const save = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

// Data yang ditampilkan di dashboard (tidak berisi kunci rahasia)
const status = {
  mode: DRY ? "DRY" : "LIVE", startedAt: Date.now(),
  lastManage: null, lastScreen: null, balance: null,
  positions: [], candidates: [], events: [], cfg,
};

async function notify(text) {
  log(text);
  status.events.unshift({ t: Date.now(), text: String(text) });
  status.events.length = Math.min(status.events.length, 50);
  const { TELEGRAM_BOT_TOKEN: t, TELEGRAM_CHAT_ID: c } = process.env;
  if (!t || !c) return;
  try {
    await fetch(`https://api.telegram.org/bot${t}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: c, text }),
    });
  } catch { /* abaikan error notifikasi */ }
}

// ── config yang bisa diubah dari dashboard ───────────
// [min, maks, integer?] untuk tiap field. Hanya field di daftar ini yang boleh diubah.
const FIELDS = {
  deploySol: [0.001, 100], maxPositions: [1, 20, true], gasReserveSol: [0, 5],
  binsBelow: [1, 69, true], cooldownHours: [0, 720],
  "screen.intervalMin": [1, 1440, true], "screen.minTvl": [0, 1e10], "screen.maxTvl": [0, 1e10],
  "screen.minVolume24h": [0, 1e10], "screen.minFeeTvl24hPct": [0, 1000],
  "screen.minBinStep": [1, 10000, true], "screen.maxBinStep": [1, 10000, true],
  "screen.minHolders": [0, 1e9, true], "screen.minMcap": [0, 1e12], "screen.maxMcap": [0, 1e12],
  "manage.intervalMin": [1, 1440, true], "manage.stopLossPct": [-100, -0.1],
  "manage.takeProfitPct": [0.1, 1000], "manage.oorMinutes": [1, 10080, true],
};
const getPath = (o, p) => p.split(".").reduce((a, k) => a?.[k], o);
const setPath = (o, p, v) => { const ks = p.split("."); const last = ks.pop(); ks.reduce((a, k) => a[k], o)[last] = v; };

function applyConfig(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("body tidak valid");
  const next = structuredClone(cfg);
  const changed = [];
  for (const [k, v] of Object.entries(patch)) {
    const f = FIELDS[k];
    if (!f) throw new Error(`field tidak dikenal: ${k}`);
    if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${k}: harus berupa angka`);
    if (v < f[0] || v > f[1]) throw new Error(`${k}: harus di antara ${f[0]} dan ${f[1]}`);
    if (f[2] && !Number.isInteger(v)) throw new Error(`${k}: harus bilangan bulat`);
    if (getPath(cfg, k) !== v) changed.push(`${k}=${v}`);
    setPath(next, k, v);
  }
  const sc = next.screen;
  if (sc.minTvl > sc.maxTvl) throw new Error("TVL min tidak boleh lebih besar dari TVL maks");
  if (sc.minBinStep > sc.maxBinStep) throw new Error("Bin step min tidak boleh lebih besar dari maks");
  if (sc.maxMcap && sc.minMcap > sc.maxMcap) throw new Error("Mcap min tidak boleh lebih besar dari mcap maks (0 = tanpa batas)");
  if (!changed.length) return cfg;

  fs.writeFileSync(new URL("./config.json", import.meta.url), JSON.stringify(next, null, 2) + "\n");
  // ubah objek cfg di tempat supaya semua referensi (status.cfg, dll) ikut berubah
  for (const k of Object.keys(patch)) setPath(cfg, k, getPath(next, k));
  notify(`⚙️ Config diubah dari dashboard: ${changed.join(", ")}`);
  return cfg;
}

// Chain hanya di-load kalau diperlukan (DRY/paper tidak butuh wallet).
let _chain;
const chain = async () => (_chain ??= await import("./dlmm.js"));
async function refreshBalance() {
  if (!process.env.WALLET_PRIVATE_KEY || !process.env.RPC_URL) return; // DRY RUN tanpa wallet
  try { status.balance = await (await chain()).solBalance(); } catch (e) { log("saldo error:", e.message); }
}

// ── screening ────────────────────────────────────────
async function screenCycle() {
  status.lastScreen = Date.now();
  await refreshBalance();
  const s = load();
  const open = Object.keys(s.open).length;
  if (open >= cfg.maxPositions) return log(`screen: posisi penuh (${open}/${cfg.maxPositions})`);

  if (!DRY) {
    const bal = await (await chain()).solBalance();
    if (bal < cfg.deploySol + cfg.gasReserveSol)
      return log(`screen: saldo kurang (${bal.toFixed(3)} SOL)`);
  }

  const now = Date.now();
  const openPools = new Set(Object.values(s.open).map((p) => p.pool));
  const openMints = new Set(Object.values(s.open).map((p) => p.baseMint));
  const all = await fetchCandidates(cfg);
  status.candidates = all.slice(0, 10);
  const cands = all.filter(
    (x) => !openPools.has(x.pool) && !openMints.has(x.baseMint) &&
           !(s.cooldown[x.pool] > now)
  );
  if (!cands.length) return log("screen: tidak ada kandidat lolos filter");

  const pick = cands[0];
  const msg = `${pick.name} | fee/TVL ${pick.feeTvlPct.toFixed(1)}% | TVL $${Math.round(pick.tvl)} | vol $${Math.round(pick.vol)}`;

  // PAPER: simpan posisi virtual ke state, tanpa transaksi apa pun.
  if (DRY) {
    const price = pick.price > 0 ? pick.price : await fetchPoolPrice(pick.pool);
    const key = `paper-${now}`;
    s.open[key] = {
      paper: true, pool: pick.pool, baseMint: pick.baseMint, name: pick.name,
      entrySol: cfg.deploySol, openedAt: now, oorSince: null,
      entryPrice: price, binStep: pick.binStep, binsBelow: cfg.binsBelow,
      feeTvlPct: pick.feeTvlPct, feeSol: 0, lastTick: now,
    };
    save(s);
    return notify(`📝 [PAPER] buka ${cfg.deploySol} SOL → ${msg}`);
  }

  const c = await chain();

  const r = await c.deploy(pick.pool, cfg.deploySol, cfg.binsBelow);
  s.open[r.position] = {
    pool: pick.pool, baseMint: pick.baseMint, name: pick.name,
    entrySol: cfg.deploySol, openedAt: now, oorSince: null,
  };
  save(s);
  await notify(`🚀 Deploy ${cfg.deploySol} SOL → ${msg}\nposisi: ${r.position}`);
}

// ── management ───────────────────────────────────────
async function manageCycle() {
  status.lastManage = Date.now();
  await refreshBalance();
  const s = load();
  const entries = Object.entries(s.open);
  if (!entries.length) { status.positions = []; return; }
  const c = DRY ? null : await chain();
  const live = [];
  const m = cfg.manage;

  for (const [addr, meta] of entries) {
    let p;
    if (meta.paper) {
      try {
        p = paperPosition(meta, await fetchPoolPrice(meta.pool));
      } catch (e) {
        log(`manage: ${meta.name} gagal ambil harga (${e.message}), dilewati`);
        continue;
      }
    } else {
      p = await c.getPosition(meta.pool, addr);
    }
    if (!p) {
      log(`manage: ${meta.name} sudah tidak ada on-chain, dihapus dari state`);
      delete s.open[addr];
      continue;
    }
    const pnlPct = ((p.valueSol - meta.entrySol) / meta.entrySol) * 100;
    meta.oorSince = p.inRange ? null : (meta.oorSince ?? Date.now());
    const oorMin = meta.oorSince ? (Date.now() - meta.oorSince) / 60000 : 0;
    log(`manage: ${meta.paper ? "[PAPER] " : ""}${meta.name} pnl ${pnlPct.toFixed(2)}% | ${p.inRange ? "IN" : `OOR ${oorMin.toFixed(0)}m`}`);

    live.push({ address: addr, name: meta.name, entrySol: meta.entrySol, valueSol: p.valueSol,
                pnlPct, inRange: p.inRange, oorMin, openedAt: meta.openedAt, paper: !!meta.paper });

    let reason = null;
    if (pnlPct <= m.stopLossPct) reason = `stop loss (${pnlPct.toFixed(2)}%)`;
    else if (pnlPct >= m.takeProfitPct) reason = `take profit (${pnlPct.toFixed(2)}%)`;
    else if (oorMin >= m.oorMinutes) reason = `OOR ${oorMin.toFixed(0)} menit`;
    if (!reason) continue;

    try {
      if (!meta.paper) await c.close(meta.pool, addr, p.lowerBin, p.upperBin);
      s.cooldown[meta.pool] = Date.now() + cfg.cooldownHours * 3600_000;
      delete s.open[addr];
      (s.closed ??= []).unshift({ name: meta.name, pnlPct, reason, closedAt: Date.now(), openedAt: meta.openedAt,
                                  entrySol: meta.entrySol, paper: !!meta.paper });
      s.closed.length = Math.min(s.closed.length, 50);
      await notify(meta.paper
        ? `📝 [PAPER] close ${meta.name}: ${reason}`
        : `🔒 Close ${meta.name}: ${reason}\nCatatan: token sisa (jika ada) tetap di wallet, swap manual.`);
    } catch (e) {
      await notify(`❌ Gagal close ${meta.name}: ${e.message}`);
    }
  }
  save(s);
  status.positions = live.filter((x) => s.open[x.address]);
}

// ── runner ───────────────────────────────────────────
const safe = (name, fn) => async () => {
  try { await fn(); } catch (e) { log(`${name} error:`, e.message); }
};

const cmd = process.argv[2];
if (cmd === "screen") {
  // read-only: cetak kandidat, tidak butuh wallet
  const list = await fetchCandidates(cfg);
  console.table(list.slice(0, 10).map((x) => ({
    name: x.name, binStep: x.binStep, tvl: Math.round(x.tvl),
    vol24h: Math.round(x.vol), "fee/tvl%": x.feeTvlPct.toFixed(1), price: x.price,
  })));
  log(`${list.length} kandidat lolos filter`);
} else if (cmd === "positions") {
  console.log(JSON.stringify(load().open, null, 2));
} else {
  log(`Meridian Lite start | ${DRY ? "DRY RUN (paper trading)" : "LIVE"}`);
  if (!DRY && (!process.env.WALLET_PRIVATE_KEY || !process.env.RPC_URL)) {
    log("MODE LIVE butuh WALLET_PRIVATE_KEY dan RPC_URL di .env. Berhenti.");
    process.exit(1);
  }
  if (DRY && !process.env.WALLET_PRIVATE_KEY) log("DRY RUN tanpa wallet: saldo tidak ditampilkan, posisi virtual tetap jalan.");
  startServer(() => ({ ...status, closed: load().closed ?? [] }), log, applyConfig);
  const screen = safe("screen", screenCycle);
  const manage = safe("manage", manageCycle);
  await manage(); await screen();
  // Jadwal membaca interval dari cfg setiap putaran, jadi perubahan dari dashboard berlaku
  // setelah jeda yang sedang berjalan selesai (tanpa restart).
  const every = (fn, getMin) => {
    const tick = async () => { await fn(); setTimeout(tick, getMin() * 60_000); };
    setTimeout(tick, getMin() * 60_000);
  };
  every(manage, () => cfg.manage.intervalMin);
  every(screen, () => cfg.screen.intervalMin);
}
