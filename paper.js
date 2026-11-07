// Simulasi posisi DLMM (SOL saja, bid-ask di bawah harga aktif) tanpa SDK dan tanpa wallet.
// Ini PERKIRAAN kasar, bukan hitungan on-chain. Cukup untuk menguji logika SL/TP/OOR.
//
// Model:
// - Bin ke-i (0..binsBelow) berada di harga entryPrice * (1+binStep/10000)^-i
// - Bid-ask: bobot SOL bin ke-i = (i+1), jadi lebih banyak SOL di bin yang jauh dari harga
// - Saat harga turun melewati sebuah bin, SOL di bin itu berubah jadi token di harga bin tsb
// - Nilai posisi = SOL yang tersisa + token (dinilai di harga sekarang) + estimasi fee
// - Fee diestimasi dari fee/TVL 24j saat entry, hanya dihitung selama IN RANGE
// - Tidak memodelkan slippage, biaya transaksi, atau fee protokol

export function paperPosition(meta, price) {
  const step = 1 + meta.binStep / 10000;
  const n = meta.binsBelow;
  let totalW = 0;
  for (let i = 0; i <= n; i++) totalW += i + 1;

  let value = 0;
  for (let i = 0; i <= n; i++) {
    const sol = (meta.entrySol * (i + 1)) / totalW;
    const binPrice = meta.entryPrice * Math.pow(step, -i);
    value += price < binPrice ? (sol / binPrice) * price : sol;
  }

  const lowerPrice = meta.entryPrice * Math.pow(step, -n);
  const upperPrice = meta.entryPrice * step;
  const inRange = price >= lowerPrice && price <= upperPrice;

  // akumulasi estimasi fee sejak tick terakhir
  const now = Date.now();
  const dt = now - (meta.lastTick ?? now);
  if (inRange && dt > 0) meta.feeSol = (meta.feeSol ?? 0) + (meta.entrySol * meta.feeTvlPct / 100) * (dt / 86_400_000);
  meta.lastTick = now;

  return {
    valueSol: value + (meta.feeSol ?? 0),
    inRange,
    lowerBin: 0,
    upperBin: 0,
  };
}
