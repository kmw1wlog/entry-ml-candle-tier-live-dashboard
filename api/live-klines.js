module.exports = async function handler(req, res) {
  const symbol = String(req.query.symbol || "").trim().toUpperCase();
  const interval = String(req.query.interval || "5m");
  const limit = Math.min(Math.max(Number(req.query.limit || 288), 50), 1000);
  if (!/^[A-Z0-9]{2,30}USDT$/.test(symbol)) {
    res.status(400).json({ error: "invalid symbol" });
    return;
  }
  if (!["1m", "5m", "15m", "1h"].includes(interval)) {
    res.status(400).json({ error: "invalid interval" });
    return;
  }
  const sendBars = (source, bars) => {
    res.setHeader("cache-control", "s-maxage=10, stale-while-revalidate=20");
    res.json({
      symbol,
      interval,
      source,
      bars: bars.filter((row) => Number.isFinite(row.time) && Number.isFinite(row.close)).sort((a, b) => a.time - b.time),
    });
  };

  const params = new URLSearchParams({ symbol, interval, limit: String(limit) });
  const binance = await fetch(`https://api.binance.com/api/v3/klines?${params}`, {
    headers: { "user-agent": "entry-ml-candle-tier-live-dashboard" },
  });
  if (binance.ok) {
    const rows = await binance.json();
    sendBars(
      "binance",
      rows.map((row) => ({
        time: Math.floor(Number(row[0]) / 1000),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        quoteVolume: Number(row[7]),
      })),
    );
    return;
  }

  const bybitInterval = { "1m": "1", "5m": "5", "15m": "15", "1h": "60" }[interval];
  const bybitParams = new URLSearchParams({ category: "spot", symbol, interval: bybitInterval, limit: String(limit) });
  const bybit = await fetch(`https://api.bybit.com/v5/market/kline?${bybitParams}`, {
    headers: { "user-agent": "entry-ml-candle-tier-live-dashboard" },
  });
  if (!bybit.ok) {
    const base = symbol.replace(/USDT$/, "");
    const granularity = { "1m": "ONE_MINUTE", "5m": "FIVE_MINUTE", "15m": "FIFTEEN_MINUTE", "1h": "ONE_HOUR" }[interval];
    for (const product of [`${base}-USDT`, `${base}-USD`]) {
      const coinbaseParams = new URLSearchParams({ granularity, limit: String(Math.min(limit, 300)) });
      const coinbase = await fetch(`https://api.coinbase.com/api/v3/brokerage/market/products/${product}/candles?${coinbaseParams}`, {
        headers: { "user-agent": "entry-ml-candle-tier-live-dashboard" },
      });
      if (!coinbase.ok) continue;
      const payload = await coinbase.json();
      const candles = payload?.candles || [];
      if (!candles.length) continue;
      sendBars(
        `coinbase:${product}`,
        candles.map((row) => ({
          time: Number(row.start),
          open: Number(row.open),
          high: Number(row.high),
          low: Number(row.low),
          close: Number(row.close),
          quoteVolume: Number(row.volume) * Number(row.close),
        })),
      );
      return;
    }
    res.status(bybit.status).json({ error: `binance ${binance.status}; bybit ${bybit.status}; coinbase unavailable` });
    return;
  }
  const payload = await bybit.json();
  const rows = payload?.result?.list || [];
  sendBars(
    "bybit",
    rows.map((row) => ({
      time: Math.floor(Number(row[0]) / 1000),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      quoteVolume: Number(row[6]),
    })),
  );
};
