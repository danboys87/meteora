// Ambil pool dari API Meteora lalu saring dengan aturan sederhana.
// CATATAN: cek dulu dengan `npm run screen` (read-only) bahwa field di bawah
// sesuai dengan respons API saat ini. Kalau kosong, sesuaikan nama field-nya.
export const SOL = "So11111111111111111111111111111111111111112";

export async function fetchCandidates(cfg) {
  const s = cfg.screen;
  const url =
    "https://dlmm-api.meteora.ag/pair/all_by_groups" +
    `?sort_key=volume&order_by=desc&limit=100&hide_low_tvl=${s.minTvl}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Meteora API ${res.status}`);
  const data = await res.json();
  const pairs = (data.groups ?? []).flatMap((g) => g.pairs ?? []);

  return pairs
    .map((p) => {
      const tvl = Number(p.liquidity);
      const vol = Number(p.trade_volume_24h);
      const fees = Number(p.fees_24h);
      return {
        pool: p.address,
        name: p.name,
        baseMint: p.mint_x,
        quoteMint: p.mint_y,
        binStep: Number(p.bin_step),
        tvl, vol,
        feeTvlPct: tvl > 0 ? (fees / tvl) * 100 : 0,
      };
    })
    .filter((c) =>
      c.quoteMint === SOL &&                       // SOL harus token Y (deposit satu sisi SOL)
      !cfg.blacklistMints.includes(c.baseMint) &&
      c.tvl >= s.minTvl && c.tvl <= s.maxTvl &&
      c.vol >= s.minVolume24h &&
      c.feeTvlPct >= s.minFeeTvl24hPct &&
      c.binStep >= s.minBinStep && c.binStep <= s.maxBinStep
    )
    .sort((a, b) => b.feeTvlPct - a.feeTvlPct);
}
