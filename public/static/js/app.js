(function () {
  const { createChart, CrosshairMode, LineStyle } = LightweightCharts;

  const TIER_COLOR = {
    tier0: "#f59e0b",
    tier1: "#22c55e",
    tier2: "#38bdf8",
  };

  const els = {
    status: document.getElementById("status"),
    liveStatus: document.getElementById("liveStatus"),
    tier0: document.getElementById("tier0"),
    tier1: document.getElementById("tier1"),
    tier2: document.getElementById("tier2"),
    showMarkers: document.getElementById("showMarkers"),
    autoFollow: document.getElementById("autoFollow"),
    refresh: document.getElementById("refresh"),
    symbolCount: document.getElementById("symbolCount"),
    symbolList: document.getElementById("symbolList"),
    title: document.getElementById("title"),
    meta: document.getElementById("meta"),
    charts: document.getElementById("charts"),
    markerCount: document.getElementById("markerCount"),
    markerList: document.getElementById("markerList"),
  };

  const state = {
    supabase: null,
    channel: null,
    markers: [],
    symbol: null,
    activeTiers: { tier0: true, tier1: true, tier2: true },
    showMarkers: true,
    autoFollow: true,
    panels: [],
    syncing: false,
  };

  function setStatus(text) {
    els.status.textContent = text;
  }

  function setLiveStatus(text, klass = "") {
    els.liveStatus.textContent = text;
    els.liveStatus.className = `live-status ${klass}`;
  }

  async function fetchJson(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
    return response.json();
  }

  function fmt(value, digits = 4) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
    return Number(value).toLocaleString("en-US", { maximumFractionDigits: digits });
  }

  function shortTime(value) {
    return String(value || "").replace("T", " ").replace("+00:00", "Z").replace("Z", "").slice(5, 16);
  }

  function epoch(iso) {
    return Math.floor(new Date(iso).getTime() / 1000);
  }

  function tierFromMarker(marker) {
    const rawTier = marker?.raw_record?.alert?.tier;
    if (["tier0", "tier1", "tier2"].includes(rawTier)) return rawTier;
    const source = String(marker?.source_model || "");
    if (source.includes("tier0")) return "tier0";
    if (source.includes("tier1")) return "tier1";
    if (source.includes("tier2")) return "tier2";
    return null;
  }

  function normalizeMarker(marker) {
    const tier = tierFromMarker(marker);
    return {
      ...marker,
      tier,
      time: epoch(marker.decision_time_utc),
      entry: Number(marker.entry_reference_price),
    };
  }

  function mergeMarker(marker) {
    const normalized = normalizeMarker(marker);
    if (!normalized.alert_id || !normalized.symbol || !normalized.tier) return;
    const idx = state.markers.findIndex((item) => item.alert_id === normalized.alert_id);
    if (idx >= 0) state.markers[idx] = normalized;
    else state.markers.unshift(normalized);
    state.markers.sort((a, b) => new Date(b.decision_time_utc) - new Date(a.decision_time_utc));
    state.markers = state.markers.slice(0, 2000);
  }

  function activeMarkers() {
    return state.markers.filter((marker) => state.activeTiers[marker.tier]);
  }

  function selectedMarkers() {
    return activeMarkers().filter((marker) => marker.symbol === state.symbol);
  }

  function symbolsFromMarkers() {
    const map = new Map();
    for (const marker of activeMarkers()) {
      const item = map.get(marker.symbol) || {
        symbol: marker.symbol,
        latest: marker.decision_time_utc,
        counts: { tier0: 0, tier1: 0, tier2: 0 },
        bybit: 0,
      };
      item.counts[marker.tier] += 1;
      if (marker.bybit_status === "placed_and_cancelled") item.bybit += 1;
      if (new Date(marker.decision_time_utc) > new Date(item.latest)) item.latest = marker.decision_time_utc;
      map.set(marker.symbol, item);
    }
    return [...map.values()].sort((a, b) => new Date(b.latest) - new Date(a.latest));
  }

  function chartOptions(height) {
    return {
      autoSize: true,
      height,
      layout: { background: { color: "#14171d" }, textColor: "#e6ebf2", fontFamily: "Inter, system-ui, sans-serif" },
      grid: { vertLines: { color: "rgba(255,255,255,0.07)", style: LineStyle.Solid }, horzLines: { color: "rgba(255,255,255,0.07)", style: LineStyle.Solid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#2a303a" },
      timeScale: { borderColor: "#2a303a", timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 4 },
      localization: { locale: "en-US" },
      handleScroll: { horzTouchDrag: true, mouseWheel: true, pressedMouseMove: true, vertTouchDrag: true },
      handleScale: { axisDoubleClickReset: true, axisPressedMouseMove: true, mouseWheel: true, pinch: true },
    };
  }

  function lineOptions(color, width = 1) {
    return { color, lineWidth: width, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };
  }

  function sma(rows, key, period) {
    const out = Array(rows.length).fill(null);
    let sum = 0;
    const queue = [];
    for (let i = 0; i < rows.length; i += 1) {
      const value = Number(rows[i][key]);
      queue.push(value);
      sum += Number.isFinite(value) ? value : 0;
      if (queue.length > period) {
        const removed = queue.shift();
        sum -= Number.isFinite(removed) ? removed : 0;
      }
      if (queue.length === period) out[i] = sum / period;
    }
    return out;
  }

  function ema(values, period) {
    const out = Array(values.length).fill(null);
    const alpha = 2 / (period + 1);
    let prev = null;
    for (let i = 0; i < values.length; i += 1) {
      const value = Number(values[i]);
      if (!Number.isFinite(value)) continue;
      if (prev === null) {
        if (i < period - 1) continue;
        const slice = values.slice(i - period + 1, i + 1).map(Number).filter(Number.isFinite);
        if (slice.length < period) continue;
        prev = slice.reduce((a, b) => a + b, 0) / period;
      } else {
        prev = value * alpha + prev * (1 - alpha);
      }
      out[i] = prev;
    }
    return out;
  }

  function enrichRows(rows) {
    const out = rows.map((row) => ({ ...row }));
    for (const [field, period] of [["ma25", 25], ["ma50", 50], ["ma200", 200], ["ma400", 400]]) {
      const values = sma(out, "close", period);
      values.forEach((value, idx) => { out[idx][field] = value; });
    }
    for (let i = 0; i < out.length; i += 1) {
      const vwapSlice = out.slice(Math.max(0, i - 95), i + 1);
      const vwmaSlice = out.slice(Math.max(0, i - 99), i + 1);
      const vwapDen = vwapSlice.reduce((sum, row) => sum + Number(row.quoteVolume || 0), 0);
      const vwmaDen = vwmaSlice.reduce((sum, row) => sum + Number(row.quoteVolume || 0), 0);
      out[i].vwap = vwapDen ? vwapSlice.reduce((sum, row) => sum + Number(row.close || 0) * Number(row.quoteVolume || 0), 0) / vwapDen : null;
      out[i].vwma100 = vwmaDen ? vwmaSlice.reduce((sum, row) => sum + Number(row.close || 0) * Number(row.quoteVolume || 0), 0) / vwmaDen : null;
    }
    const close = out.map((row) => row.close);
    const fast = ema(close, 12);
    const slow = ema(close, 26);
    const macd = close.map((_, idx) => (fast[idx] !== null && slow[idx] !== null ? (fast[idx] - slow[idx]) / close[idx] : null));
    const signal = ema(macd.map((value) => value === null ? NaN : value), 9);
    const gains = [];
    const losses = [];
    for (let i = 0; i < out.length; i += 1) {
      const delta = i === 0 ? 0 : close[i] - close[i - 1];
      gains.push(Math.max(delta, 0));
      losses.push(Math.max(-delta, 0));
    }
    const avgGain = ema(gains, 14);
    const avgLoss = ema(losses, 14);
    const volMean = sma(out, "quoteVolume", 48);
    for (let i = 0; i < out.length; i += 1) {
      out[i].macd = macd[i];
      out[i].signal = signal[i];
      out[i].hist = macd[i] !== null && signal[i] !== null ? macd[i] - signal[i] : null;
      if (avgGain[i] !== null && avgLoss[i] !== null && avgLoss[i] !== 0) {
        const rs = avgGain[i] / avgLoss[i];
        out[i].rsi = 100 - (100 / (1 + rs));
      }
      const slice = out.slice(Math.max(0, i - 47), i + 1).map((row) => Number(row.quoteVolume)).filter(Number.isFinite);
      if (slice.length >= 10 && volMean[i] !== null) {
        const variance = slice.reduce((sum, value) => sum + ((value - volMean[i]) ** 2), 0) / slice.length;
        const std = Math.sqrt(variance);
        out[i].volumeZ = std ? (out[i].quoteVolume - volMean[i]) / std : null;
      }
    }
    return out;
  }

  function resampleRows(rows, seconds) {
    const buckets = new Map();
    rows.forEach((row) => {
      const bucket = Math.ceil(row.time / seconds) * seconds;
      if (!buckets.has(bucket)) {
        buckets.set(bucket, { time: bucket, open: row.open, high: row.high, low: row.low, close: row.close, quoteVolume: 0 });
      }
      const item = buckets.get(bucket);
      item.high = Math.max(item.high, row.high);
      item.low = Math.min(item.low, row.low);
      item.close = row.close;
      item.quoteVolume += Number(row.quoteVolume || 0);
    });
    return enrichRows([...buckets.values()].sort((a, b) => a.time - b.time));
  }

  function seriesRows(rows, key) {
    return rows.filter((row) => row[key] !== null && row[key] !== undefined).map((row) => ({ time: row.time, value: Number(row[key]) }));
  }

  function clearCharts() {
    state.panels.forEach((panel) => panel.chart.remove());
    state.panels = [];
    els.charts.innerHTML = "";
  }

  function setSeriesMarkers(series, markers) {
    if (typeof series.setMarkers === "function") {
      series.setMarkers(markers);
    }
  }

  function nearestTime(rows, target) {
    if (!rows.length) return null;
    let best = rows[0].time;
    let bestDiff = Math.abs(best - target);
    for (const row of rows) {
      const diff = Math.abs(row.time - target);
      if (diff < bestDiff) {
        best = row.time;
        bestDiff = diff;
      }
    }
    return best;
  }

  function drawOverlay(panel) {
    const canvas = panel.overlay;
    const rect = panel.host.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, rect.width, rect.height);
    if (!state.showMarkers) return;
    const markers = selectedMarkers().slice(0, 120);
    for (const marker of markers) {
      const t = nearestTime(panel.rows, marker.time);
      const x = t ? panel.chart.timeScale().timeToCoordinate(t) : null;
      if (x === null || x === undefined) continue;
      const color = TIER_COLOR[marker.tier] || "#fff";
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, rect.height);
      ctx.stroke();
      ctx.globalAlpha = 1;
      const y = Number.isFinite(marker.entry) ? panel.candle.priceToCoordinate(marker.entry) : null;
      if (y !== null && y !== undefined) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#f8fafc";
        ctx.font = "11px Inter, sans-serif";
        ctx.fillText(marker.tier.toUpperCase(), Math.min(x + 6, rect.width - 44), Math.max(12, y - 8));
      }
    }
  }

  function drawAllOverlays() {
    window.requestAnimationFrame(() => state.panels.forEach(drawOverlay));
  }

  function drawInterval(label, rows, compact = false) {
    const card = document.createElement("div");
    card.className = "chart-card";
    card.innerHTML = `<div class="chart-title"><strong>${label}</strong><span>${rows.length} bars</span></div><div class="chart-host ${compact ? "compact" : ""}"></div><canvas class="overlay"></canvas>`;
    els.charts.appendChild(card);
    const host = card.querySelector(".chart-host");
    const overlay = card.querySelector(".overlay");
    const chart = createChart(host, chartOptions(compact ? 240 : 340));
    const candle = chart.addCandlestickSeries({
      upColor: "#22ab94",
      downColor: "#f23645",
      borderVisible: false,
      wickUpColor: "#22ab94",
      wickDownColor: "#f23645",
    });
    candle.setData(rows.map((row) => ({ time: row.time, open: row.open, high: row.high, low: row.low, close: row.close })));
    chart.addLineSeries(lineOptions("#ff9800")).setData(seriesRows(rows, "ma25"));
    chart.addLineSeries(lineOptions("#4caf50")).setData(seriesRows(rows, "ma50"));
    chart.addLineSeries(lineOptions("#ff2f4b")).setData(seriesRows(rows, "ma200"));
    chart.addLineSeries(lineOptions("#8bdcff")).setData(seriesRows(rows, "ma400"));
    chart.addLineSeries(lineOptions("#f8fafc", 2)).setData(seriesRows(rows, "vwap"));
    chart.addLineSeries(lineOptions("#a78bfa")).setData(seriesRows(rows, "vwma100"));
    const volume = chart.addHistogramSeries({ color: "#64748b", priceFormat: { type: "volume" }, priceScaleId: "volume", lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });
    volume.setData(rows.map((row) => ({ time: row.time, value: row.quoteVolume || 0, color: (row.volumeZ || 0) >= 2 ? "#38bdf8" : "#475569" })));
    const markerRows = selectedMarkers().map((marker) => {
      const t = nearestTime(rows, marker.time);
      return t ? { time: t, position: "belowBar", color: TIER_COLOR[marker.tier], shape: "arrowUp", text: marker.tier.toUpperCase() } : null;
    }).filter(Boolean);
    setSeriesMarkers(candle, markerRows);
    const panel = { chart, candle, host, overlay, rows };
    state.panels.push(panel);
    chart.timeScale().fitContent();
    chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
      if (state.syncing || !range) return;
      state.syncing = true;
      state.panels.forEach((other) => {
        if (other.chart !== chart) other.chart.timeScale().setVisibleRange(range);
      });
      state.syncing = false;
      drawAllOverlays();
    });
  }

  async function browserKlinesFallback(symbol) {
    const params = new URLSearchParams({ symbol, interval: "5m", limit: "500" });
    const response = await fetch(`https://api.binance.com/api/v3/klines?${params}`);
    if (!response.ok) throw new Error(`browser fallback ${response.status}`);
    const rows = await response.json();
    return {
      source: "browser-binance",
      bars: rows.map((row) => ({
        time: Math.floor(Number(row[0]) / 1000),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        quoteVolume: Number(row[7]),
      })),
    };
  }

  async function loadKlines(symbol) {
    try {
      return await fetchJson(`/api/live-klines?symbol=${encodeURIComponent(symbol)}&interval=5m&limit=500`);
    } catch (error) {
      console.warn(error);
      return browserKlinesFallback(symbol);
    }
  }

  async function loadSymbol(symbol = state.symbol) {
    if (!symbol) {
      els.charts.innerHTML = `<div class="empty">선택 가능한 Tier 마커가 없습니다.</div>`;
      return;
    }
    state.symbol = symbol;
    setStatus(`Loading ${symbol}`);
    clearCharts();
    els.title.textContent = symbol;
    const markers = selectedMarkers();
    els.meta.textContent = `${markers.length} active markers · latest ${shortTime(markers[0]?.decision_time_utc)} · Tier0/1/2 filtered`;
    try {
      const payload = await loadKlines(symbol);
      const rows5 = enrichRows(payload.bars || []);
      if (!rows5.length) throw new Error("no bars");
      drawInterval(`Live 5m · ${payload.source || "api"}`, rows5, false);
      drawInterval("Live 15m", resampleRows(rows5, 15 * 60), true);
      drawInterval("Live 1h", resampleRows(rows5, 60 * 60), true);
      focusLatestMarker();
      render();
      drawAllOverlays();
      setStatus(`Ready · ${symbol}`);
    } catch (error) {
      console.error(error);
      els.charts.innerHTML = `<div class="error">차트 로드 실패: ${error.message}</div>`;
      setStatus("Chart failed");
    }
  }

  function focusLatestMarker() {
    const marker = selectedMarkers()[0];
    if (!marker) return;
    const range = { from: marker.time - 12 * 3600, to: marker.time + 2 * 3600 };
    state.panels.forEach((panel) => panel.chart.timeScale().setVisibleRange(range));
  }

  function renderSymbols() {
    const symbols = symbolsFromMarkers();
    els.symbolCount.textContent = String(symbols.length);
    if (!symbols.some((item) => item.symbol === state.symbol)) {
      state.symbol = symbols[0]?.symbol || null;
    }
    els.symbolList.innerHTML = symbols.map((item) => `
      <button class="symbol-row ${item.symbol === state.symbol ? "active" : ""}" data-symbol="${item.symbol}">
        <strong>${item.symbol}</strong>
        <small>latest ${shortTime(item.latest)} · bybit ${item.bybit}</small>
        <span class="badges">
          ${item.counts.tier0 ? `<span class="badge tier0">T0 ${item.counts.tier0}</span>` : ""}
          ${item.counts.tier1 ? `<span class="badge tier1">T1 ${item.counts.tier1}</span>` : ""}
          ${item.counts.tier2 ? `<span class="badge tier2">T2 ${item.counts.tier2}</span>` : ""}
        </span>
      </button>
    `).join("") || `<div class="empty">활성 Tier 마커 없음</div>`;
    els.symbolList.querySelectorAll("[data-symbol]").forEach((button) => {
      button.addEventListener("click", () => {
        state.autoFollow = false;
        els.autoFollow.checked = false;
        loadSymbol(button.dataset.symbol);
      });
    });
  }

  function renderMarkers() {
    const markers = selectedMarkers();
    els.markerCount.textContent = String(markers.length);
    els.markerList.innerHTML = markers.slice(0, 80).map((marker) => `
      <button class="marker-row" data-time="${marker.time}">
        <strong><span class="badge ${marker.tier}">${marker.tier.toUpperCase()}</span> ${shortTime(marker.decision_time_utc)} · ${fmt(marker.entry, 8)}</strong>
        <small>${marker.source_model} · bybit ${marker.bybit_status || "-"} · votes ${marker.raw_record?.alert?.vote_count ?? "-"}</small>
      </button>
    `).join("") || `<div class="empty">선택 심볼 마커 없음</div>`;
    els.markerList.querySelectorAll("[data-time]").forEach((button) => {
      button.addEventListener("click", () => {
        const center = Number(button.dataset.time);
        const range = { from: center - 12 * 3600, to: center + 2 * 3600 };
        state.panels.forEach((panel) => panel.chart.timeScale().setVisibleRange(range));
        drawAllOverlays();
      });
    });
  }

  function render() {
    renderSymbols();
    renderMarkers();
    drawAllOverlays();
  }

  async function setupSupabase() {
    const config = await fetchJson("/data/live_supabase_config.json");
    if (!config.enabled) {
      setLiveStatus("Supabase disabled", "warn");
      return;
    }
    if (!window.supabase?.createClient) {
      throw new Error("Supabase JS unavailable");
    }
    state.supabase = window.supabase.createClient(config.supabase_url, config.supabase_publishable_key);
    const { data, error } = await state.supabase
      .from(config.table)
      .select("*")
      .like("source_model", "candle_frequency_tier%")
      .order("decision_time_utc", { ascending: false })
      .limit(1000);
    if (error) throw error;
    (data || []).forEach(mergeMarker);
    setLiveStatus(`Live 연결 · ${state.markers.length} tier markers`, "ok");
    state.channel = state.supabase
      .channel("candle-tier-alert-markers")
      .on("postgres_changes", { event: "*", schema: "public", table: config.table }, (payload) => {
        if (!payload.new || !String(payload.new.source_model || "").startsWith("candle_frequency_tier")) return;
        mergeMarker(payload.new);
        setLiveStatus(`Live 수신 · ${payload.new.symbol} ${shortTime(payload.new.decision_time_utc)}`, "ok");
        if (state.autoFollow && state.activeTiers[tierFromMarker(payload.new)]) {
          loadSymbol(payload.new.symbol);
        } else {
          render();
        }
      })
      .subscribe((status) => {
        if (status === "SUBSCRIBED") setLiveStatus(`Live 구독 · ${state.markers.length} markers`, "ok");
        else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setLiveStatus(`Live ${status}`, "warn");
      });
  }

  function bind() {
    for (const tier of ["tier0", "tier1", "tier2"]) {
      els[tier].addEventListener("change", () => {
        state.activeTiers[tier] = els[tier].checked;
        render();
        loadSymbol(state.symbol);
      });
    }
    els.showMarkers.addEventListener("change", () => {
      state.showMarkers = els.showMarkers.checked;
      drawAllOverlays();
    });
    els.autoFollow.addEventListener("change", () => {
      state.autoFollow = els.autoFollow.checked;
    });
    els.refresh.addEventListener("click", () => loadSymbol(state.symbol));
    window.addEventListener("resize", drawAllOverlays);
  }

  async function init() {
    try {
      bind();
      await setupSupabase();
      state.symbol = symbolsFromMarkers()[0]?.symbol || null;
      render();
      await loadSymbol(state.symbol);
    } catch (error) {
      console.error(error);
      setStatus("Failed");
      setLiveStatus(error.message, "warn");
      els.charts.innerHTML = `<div class="error">초기화 실패: ${error.message}</div>`;
    }
  }

  init();
})();
