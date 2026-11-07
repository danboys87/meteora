// Ambil pool dari Meteora DLMM Data API lalu saring dengan aturan sederhana.
// Dokumentasi: https://docs.meteora.ag/api-reference/dlmm/pools/pools
export const SOL = "So11111111111111111111111111111111111111112";
const API = "https://dlmm.datapi.meteora.ag/pools";

// Harga terkini satu pool (SOL per token). Dipakai paper trading.
export async function fetchPoolPrice(pool) {
  const res = await fetch(`${API}/${pool}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Meteora API ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const p = await res.json();
  const price = Number(p.current_price);
  if (!(price > 0)) throw new Error("current_price tidak ada/valid di respons API");
  return price;
}

export async function fetchCandidates(cfg) {
  const s = cfg.screen;

  // Filter dasar dikerjakan di sisi server supaya data yang diunduh kecil.
  const filter = [
    "is_blacklisted=false",
    `tvl>=${s.minTvl}`,
    `tvl<=${s.maxTvl}`,
    `volume_24h>=${s.minVolume24h}`,
    `fee_tvl_ratio_24h>=${s.minFeeTvl24hPct}`,
  ].join(" && ");

  const url = `${API}?page=1&page_size=100&sort_by=${encodeURIComponent("fee_tvl_ratio_24h:desc")}` +
              `&filter_by=${encodeURIComponent(filter)}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`Meteora API ${res.status}: ${(await res.text()).slice(0, 150)}`);
  const body = await res.json();

  return (body.data ?? [])
    .map((p) => ({
      pool: p.address,
      name: p.name,
      baseMint: p.token_x?.address,
      quoteMint: p.token_y?.address,
      binStep: Number(p.pool_config?.bin_step),
      baseFeePct: Number(p.pool_config?.base_fee_pct),
      tvl: Number(p.tvl),
      vol: Number(p.volume?.["24h"]),
      feeTvlPct: Number(p.fee_tvl_ratio?.["24h"]),
      holders: Number(p.token_x?.holders),
      mcap: Number(p.token_x?.market_cap),
      price: Number(p.current_price),
    }))
    .filter((c) =>
      c.quoteMint === SOL &&                        // SOL harus token Y (deposit satu sisi SOL)
      !(cfg.blacklistMints ?? []).includes(c.baseMint) &&
      c.binStep >= s.minBinStep && c.binStep <= s.maxBinStep &&
      (!s.minHolders || c.holders >= s.minHolders) &&
      (!s.minMcap || c.mcap >= s.minMcap) &&
      (!s.maxMcap || c.mcap <= s.maxMcap)
    );
}
