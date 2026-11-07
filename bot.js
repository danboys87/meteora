import "dotenv/config";
import fs from "fs";
import { fetchCandidates } from "./screener.js";

const cfg = JSON.parse(fs.readFileSync(new URL("./config.json", import.meta.url), "utf8"));
const DRY = process.env.DRY_RUN !== "false";
const STATE_FILE = "./state.json";

// ── util ─────────────────────────────────────────────
const log = (...a) => console.log(new Date().toISOString(), ...a);
const load = () =>
  fs.existsSync(STATE_FILE)
    ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
    : { open: {}, cooldown: {} };
const save = (s) => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

async function notify(text) {
  log(text);
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

// Chain hanya di-load kalau diperlukan (mode `screen` tidak butuh wallet).
let _chain;
const chain = async () => (_chain ??= await import("./dlmm.js"));

// ── screening ────────────────────────────────────────
async function screenCycle() {
  const s = load();
  const open = Object.keys(s.open).length;
  if (open >= cfg.maxPositions) return log(`screen: posisi penuh (${open}/${cfg.maxPositions})`);

  const c = await chain();
  if (!DRY) {
    const bal = await c.solBalance();
    if (bal < cfg.deploySol + cfg.gasReserveSol)
      return log(`screen: saldo kurang (${bal.toFixed(3)} SOL)`);
  }

  const now = Date.now();
  const openPools = new Set(Object.values(s.open).map((p) => p.pool));
  const openMints = new Set(Object.values(s.open).map((p) => p.baseMint));
  const cands = (await fetchCandidates(cfg)).filter(
    (x) => !openPools.has(x.pool) && !openMints.has(x.baseMint) &&
           !(s.cooldown[x.pool] > now)
  );
  if (!cands.length) return log("screen: tidak ada kandidat lolos filter");

  const pick = cands[0];
  const msg = `${pick.name} | fee/TVL ${pick.feeTvlPct.toFixed(1)}% | TVL $${Math.round(pick.tvl)} | vol $${Math.round(pick.vol)}`;
  if (DRY) return notify(`[DRY] akan deploy ${cfg.deploySol} SOL ke ${msg}`);

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
  const s = load();
  const entries = Object.entries(s.open);
  if (!entries.length) return;
  const c = await chain();
  const m = cfg.manage;

  for (const [addr, meta] of entries) {
    const p = await c.getPosition(meta.pool, addr);
    if (!p) {
      log(`manage: ${meta.name} sudah tidak ada on-chain, dihapus dari state`);
      delete s.open[addr];
      continue;
    }
    const pnlPct = ((p.valueSol - meta.entrySol) / meta.entrySol) * 100;
    meta.oorSince = p.inRange ? null : (meta.oorSince ?? Date.now());
    const oorMin = meta.oorSince ? (Date.now() - meta.oorSince) / 60000 : 0;
    log(`manage: ${meta.name} pnl ${pnlPct.toFixed(2)}% | ${p.inRange ? "IN" : `OOR ${oorMin.toFixed(0)}m`}`);

    let reason = null;
    if (pnlPct <= m.stopLossPct) reason = `stop loss (${pnlPct.toFixed(2)}%)`;
    else if (pnlPct >= m.takeProfitPct) reason = `take profit (${pnlPct.toFixed(2)}%)`;
    else if (oorMin >= m.oorMinutes) reason = `OOR ${oorMin.toFixed(0)} menit`;
    if (!reason) continue;

    if (DRY) { await notify(`[DRY] akan close ${meta.name}: ${reason}`); continue; }
    try {
      await c.close(meta.pool, addr, p.lowerBin, p.upperBin);
      s.cooldown[meta.pool] = Date.now() + cfg.cooldownHours * 3600_000;
      delete s.open[addr];
      await notify(`🔒 Close ${meta.name}: ${reason}\nCatatan: token sisa (jika ada) tetap di wallet, swap manual.`);
    } catch (e) {
      await notify(`❌ Gagal close ${meta.name}: ${e.message}`);
    }
  }
  save(s);
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
    vol24h: Math.round(x.vol), "fee/tvl%": x.feeTvlPct.toFixed(1),
  })));
  log(`${list.length} kandidat lolos filter`);
} else if (cmd === "positions") {
  console.log(JSON.stringify(load().open, null, 2));
} else {
  log(`Meridian Lite start | ${DRY ? "DRY RUN" : "LIVE"}`);
  const screen = safe("screen", screenCycle);
  const manage = safe("manage", manageCycle);
  await manage(); await screen();
  setInterval(manage, cfg.manage.intervalMin * 60_000);
  setInterval(screen, cfg.screen.intervalMin * 60_000);
}
