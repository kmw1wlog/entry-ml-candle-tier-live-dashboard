(function () {
  const { createChart, CrosshairMode, LineStyle } = LightweightCharts;

  const REMOTE_ORIGIN = "https://tv-local-macro-onchain-vercel.vercel.app";
  const DATA_ROOT = `${REMOTE_ORIGIN}/data/entry_ml_v2_2`;
  const CHART_ROOT = `${DATA_ROOT}/chart_store`;
  const MAX_MODEL_LINES = 120;

  const els = {
    status: document.getElementById("eml2Status"),
    month: document.getElementById("eml2Month"),
    type: document.getElementById("eml2Type"),
    showModel: document.getElementById("eml2ShowModel"),
    showLabel: document.getElementById("eml2ShowLabel"),
    showWindows: document.getElementById("eml2ShowWindows"),
    showOutcome: document.getElementById("eml2ShowOutcome"),
    showLive: document.getElementById("eml2ShowLive"),
    tier0: document.getElementById("eml2Tier0"),
    tier1: document.getElementById("eml2Tier1"),
    tier2: document.getElementById("eml2Tier2"),
    liveStatus: document.getElementById("eml2LiveStatus"),
    symbolCount: document.getElementById("eml2SymbolCount"),
    symbolList: document.getElementById("eml2SymbolList"),
    title: document.getElementById("eml2Title"),
    meta: document.getElementById("eml2Meta"),
    legend: document.getElementById("eml2Legend"),
    charts: document.getElementById("eml2Charts"),
    queryCount: document.getElementById("eml2QueryCount"),
    query: document.getElementById("eml2Query"),
    evidence: document.getElementById("eml2Evidence"),
  };

  const colors = {
    up: "#22ab94",
    down: "#f23645",
    grid: "rgba(255,255,255,0.07)",
    text: "#d7dce2",
    ma25: "#ff9800",
    ma50: "#4caf50",
    ma200: "#ff2f4b",
    ma400: "#8bdcff",
    vwap: "#f8fafc",
    vwma100: "#a78bfa",
    rsi: "#8b5cf6",
    macd: "#3b82f6",
    signal: "#ff9800",
    volume: "#64748b",
    volumeHot: "#38bdf8",
  };

  const state = {
    index: null,
    taxonomy: null,
    month: null,
    symbol: null,
    type: "all",
    showModel: true,
    showLabel: false,
    showWindows: true,
    showOutcome: false,
    showLive: true,
    activeTiers: { tier0: true, tier1: true, tier2: true },
    overlays: null,
    evidence: null,
    neighbors: null,
    liveMarkers: [],
    liveChannel: null,
    supabaseClient: null,
    selectedQueryId: null,
    charts: [],
    panels: [],
    syncing: false,
    lastSyncedRange: null,
  };

  function setStatus(text) {
    els.status.textContent = text;
  }

  function setLiveStatus(text, klass) {
    if (!els.liveStatus) return;
    els.liveStatus.textContent = text;
    els.liveStatus.className = `eml2-live-status ${klass || ""}`;
  }

  function resolveUrl(url) {
    if (typeof url === "string" && url.startsWith("/data/")) return `${REMOTE_ORIGIN}${url}`;
    return url;
  }

  async function fetchJson(url) {
    const response = await fetch(resolveUrl(url));
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${url}`);
    if (url.endsWith(".gz")) {
      if (!("DecompressionStream" in window)) {
        throw new Error("gzip artifact requires DecompressionStream support");
      }
      const stream = response.body.pipeThrough(new DecompressionStream("gzip"));
      const text = await new Response(stream).text();
      return JSON.parse(text);
    }
    return response.json();
  }

  function fmt(value, digits = 2) {
    if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
    return Number(value).toLocaleString("en-US", { maximumFractionDigits: digits });
  }

  function shortTime(value) {
    return String(value || "").replace("T", " ").replace("Z", "").slice(5, 16);
  }

  function epoch(iso) {
    return Math.floor(new Date(iso).getTime() / 1000);
  }

  function markerTier(marker) {
    const source = String(marker?.source_model || "");
    if (!source.startsWith("candle_frequency_tier")) return null;
    if (source.includes("tier0")) return "tier0";
    if (source.includes("tier1")) return "tier1";
    if (source.includes("tier2")) return "tier2";
    return null;
  }

  function isVisibleTierMarker(marker) {
    const tier = markerTier(marker);
    return Boolean(tier && state.activeTiers[tier]);
  }

  function visibleLiveMarkers(symbol = null) {
    return state.liveMarkers.filter((marker) => isVisibleTierMarker(marker) && (!symbol || marker.symbol === symbol));
  }

  function plusHours(iso, hours) {
    return new Date(new Date(iso).getTime() + hours * 3600 * 1000).toISOString().replace(".000Z", "Z");
  }

  function minusHours(iso, hours) {
    return new Date(new Date(iso).getTime() - hours * 3600 * 1000).toISOString().replace(".000Z", "Z");
  }

  function chartOptions(height) {
    return {
      autoSize: true,
      height,
      layout: { background: { color: "#111317" }, textColor: colors.text, fontFamily: "Inter, system-ui, sans-serif" },
      grid: { vertLines: { color: colors.grid, style: LineStyle.Solid }, horzLines: { color: colors.grid, style: LineStyle.Solid } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#2a2d33" },
      timeScale: { borderColor: "#2a2d33", timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 4 },
      localization: { locale: "en-US" },
      handleScroll: { horzTouchDrag: true, mouseWheel: true, pressedMouseMove: true, vertTouchDrag: true },
      handleScale: { axisDoubleClickReset: true, axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      kineticScroll: { mouse: true, touch: true },
    };
  }

  function lineOptions(color, width = 1) {
    return { color, lineWidth: width, lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false };
  }

  function pointRows(rows, key) {
    return rows.filter((row) => row[key] !== null && row[key] !== undefined).map((row) => ({ time: row.time, value: Number(row[key]) }));
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

  function enrichRows(rows) {
    const out = rows.map((row) => ({ ...row }));
    for (const [field, period] of [["ma25", 25], ["ma50", 50], ["ma200", 200], ["ma400", 400]]) {
      const values = sma(out, "close", period);
      values.forEach((value, idx) => { out[idx][field] = value; });
    }
    for (let i = 0; i < out.length; i += 1) {
      const vwapStart = Math.max(0, i - 95);
      const vwmaStart = Math.max(0, i - 99);
      const vwapSlice = out.slice(vwapStart, i + 1);
      const vwmaSlice = out.slice(vwmaStart, i + 1);
      const vwapDen = vwapSlice.reduce((sum, row) => sum + Number(row.quoteVolume || 0), 0);
      const vwmaDen = vwmaSlice.reduce((sum, row) => sum + Number(row.quoteVolume || 0), 0);
      out[i].vwap = vwapDen ? vwapSlice.reduce((sum, row) => sum + Number(row.close || 0) * Number(row.quoteVolume || 0), 0) / vwapDen : null;
      out[i].vwma100 = vwmaDen ? vwmaSlice.reduce((sum, row) => sum + Number(row.close || 0) * Number(row.quoteVolume || 0), 0) / vwmaDen : null;
    }
    const close = out.map((row) => row.close);
    const fast = ema(close, 12);
    const slow = ema(close, 26);
    const macd = close.map((_, idx) => (fast[idx] !== null && slow[idx] !== null ? (fast[idx] - slow[idx]) / close[idx] : null));
    const signalRaw = ema(macd.map((value) => value === null ? NaN : value), 9);
    for (let i = 0; i < out.length; i += 1) {
      out[i].macd = macd[i];
      out[i].signal = signalRaw[i];
      out[i].hist = macd[i] !== null && signalRaw[i] !== null ? macd[i] - signalRaw[i] : null;
    }
    const gains = [];
    const losses = [];
    for (let i = 0; i < out.length; i += 1) {
      const delta = i === 0 ? 0 : close[i] - close[i - 1];
      gains.push(Math.max(delta, 0));
      losses.push(Math.max(-delta, 0));
    }
    const avgGain = ema(gains, 14);
    const avgLoss = ema(losses, 14);
    for (let i = 0; i < out.length; i += 1) {
      if (avgGain[i] !== null && avgLoss[i] !== null && avgLoss[i] !== 0) {
        const rs = avgGain[i] / avgLoss[i];
        out[i].rsi = 100 - (100 / (1 + rs));
      }
    }
    const volMean = sma(out, "quoteVolume", 48);
    for (let i = 0; i < out.length; i += 1) {
      const start = Math.max(0, i - 47);
      const slice = out.slice(start, i + 1).map((row) => Number(row.quoteVolume)).filter(Number.isFinite);
      const mean = volMean[i];
      if (slice.length >= 10 && mean !== null) {
        const variance = slice.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / slice.length;
        const std = Math.sqrt(variance);
        out[i].volumeZ = std ? (out[i].quoteVolume - mean) / std : null;
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

  function chartRows(payload) {
    if (Array.isArray(payload.bars)) {
      return enrichRows(payload.bars.map((row) => ({ ...row })));
    }
    const b = payload.bars || {};
    const count = (b.t || []).length;
    const at = (key, idx) => Array.isArray(b[key]) ? b[key][idx] : null;
    const rows = [];
    for (let i = 0; i < count; i += 1) {
      rows.push({
        time: at("t", i),
        open: at("o", i),
        high: at("h", i),
        low: at("l", i),
        close: at("c", i),
        ma25: at("ma25", i),
        ma50: at("ma50", i),
        ma200: at("ma200", i),
        ma400: at("ma400", i),
        vwap: at("vwap", i),
        vwma100: at("vwma100", i),
        quoteVolume: at("qv", i),
        volumeZ: at("qvz", i),
        rsi: at("rsi", i),
        macd: at("macd", i),
        signal: at("signal", i),
        hist: at("hist", i),
        adx: at("adx", i),
        dip: at("dip", i),
        dim: at("dim", i),
      });
    }
    return rows;
  }

  function monthMeta() {
    return state.index?.symbol_meta?.[state.month] || [];
  }

  function typeStatus(key) {
    if (!key || key === "all") return "all";
    const groups = state.taxonomy?.status_groups || {};
    for (const status of ["positive", "conditional", "risk", "hidden"]) {
      if ((groups[status] || []).includes(key)) return status;
    }
    return "hidden";
  }

  function filteredMeta() {
    const meta = monthMeta();
    if (state.type === "all") return meta;
    return meta.filter((item) => {
      const clusters = item.prediction_cluster_count || 0;
      if (state.type === "has_model") return clusters > 0;
      if (state.type === "has_label") return (item.label_event_count || 0) > 0;
      return false;
    });
  }

  function currentMeta() {
    return monthMeta().find((item) => item.symbol === state.symbol) || null;
  }

  function preferredDefaultSymbol() {
    const meta = filteredMeta();
    return (meta.find((item) => (item.emitted_query_count || 0) > 0) || meta[0] || monthMeta()[0] || null)?.symbol || null;
  }

  function preferredLiveSymbol() {
    const available = new Set(monthMeta().map((item) => item.symbol));
    return (visibleLiveMarkers().find((marker) => available.has(marker.symbol)) || null)?.symbol || null;
  }

  function renderControls() {
    els.month.replaceChildren(...state.index.months.map((month) => {
      const option = document.createElement("option");
      option.value = month;
      option.textContent = month;
      option.selected = month === state.month;
      return option;
    }));
    const options = [
      ["all", "All universe"],
      ["has_model", "Model clusters"],
      ["has_label", "Label events"],
    ];
    els.type.replaceChildren(...options.map(([value, label]) => {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = label;
      option.selected = value === state.type;
      return option;
    }));
  }

  function renderLegend() {
    els.legend.innerHTML = `
      <span><i class="eml2-swatch" style="background:#38bdf8"></i>live model</span>
      <span><i class="eml2-swatch" style="background:#facc15"></i>realtime alert</span>
      <span><i class="eml2-swatch" style="background:#a78bfa"></i>score-max model</span>
      <span><i class="eml2-swatch" style="background:#22ab94"></i>label</span>
      <span><i class="eml2-swatch" style="background:rgba(56,189,248,.24)"></i>window</span>
    `;
  }

  function renderSidebar() {
    const symbols = filteredMeta();
    els.symbolCount.textContent = `${symbols.length}/${monthMeta().length}`;
    els.symbolList.replaceChildren(...symbols.map((item) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `eml2-symbol${item.symbol === state.symbol ? " active" : ""}${item.chart_files_ready ? "" : " missing"}`;
      const source = item.chart_data_source === "raw_bars_fallback" ? "raw" : "feat";
      button.innerHTML = `
        <span class="eml2-rank">#${item.rank || "-"}</span>
        <strong>${item.symbol}</strong>
        <span class="eml2-badge ${item.is_major_watchlist ? "major" : ""}">${item.is_major_watchlist ? "MAJOR" : source}</span>
        <small>${item.prediction_cluster_count || 0} model · ${item.label_event_count || 0} label · ${item.emitted_query_count || 0} evidence · ${visibleLiveMarkers(item.symbol).length} live</small>
      `;
      button.addEventListener("click", () => {
        state.symbol = item.symbol;
        state.selectedQueryId = null;
        renderSidebar();
        loadSymbol();
      });
      return button;
    }));
  }

  function clearCharts() {
    for (const chart of state.charts) chart.remove();
    state.charts = [];
    state.panels = [];
    els.charts.replaceChildren();
  }

  function addPanel(container, klass) {
    const panel = document.createElement("div");
    panel.className = `eml2-panel ${klass}`;
    const mount = document.createElement("div");
    mount.className = "eml2-mount";
    const overlay = document.createElement("div");
    overlay.className = "eml2-overlay";
    panel.append(mount, overlay);
    container.appendChild(panel);
    const entry = { panel, mount, overlay, klass };
    state.panels.push(entry);
    return entry;
  }

  function drawInterval(interval, payload) {
    const rows = chartRows(payload);
    const isPrimary = interval === "5m" || interval === "Live 5m";
    const section = document.createElement("section");
    section.className = `eml2-interval ${isPrimary ? "" : "compact"}`;
    section.innerHTML = `<header><h3>${interval}</h3><span>${rows.length} bars</span></header>`;
    els.charts.appendChild(section);

    const panels = [addPanel(section, "price"), addPanel(section, "volume"), addPanel(section, "rsi"), addPanel(section, "macd")];
    const price = createChart(panels[0].mount, chartOptions(isPrimary ? 300 : 220));
    const volume = createChart(panels[1].mount, chartOptions(78));
    const rsi = createChart(panels[2].mount, chartOptions(78));
    const macd = createChart(panels[3].mount, chartOptions(78));
    state.charts.push(price, volume, rsi, macd);

    const candleSeries = price.addCandlestickSeries({
      upColor: colors.up,
      downColor: colors.down,
      borderUpColor: colors.up,
      borderDownColor: colors.down,
      wickUpColor: colors.up,
      wickDownColor: colors.down,
    });
    candleSeries.setData(rows.map((row) => ({ time: row.time, open: row.open, high: row.high, low: row.low, close: row.close })));
    panels[0].priceSeries = candleSeries;
    [
      ["ma25", colors.ma25],
      ["ma50", colors.ma50],
      ["ma200", colors.ma200],
      ["ma400", colors.ma400],
      ["vwap", colors.vwap],
      ["vwma100", colors.vwma100],
    ].forEach(([key, color]) => price.addLineSeries(lineOptions(color)).setData(pointRows(rows, key)));

    volume.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false }).setData(
      rows.map((row) => ({ time: row.time, value: row.quoteVolume || 0, color: Number(row.volumeZ || 0) >= 1.5 ? colors.volumeHot : colors.volume }))
    );
    volume.addLineSeries(lineOptions("#facc15")).setData(pointRows(rows, "volumeZ"));

    rsi.addLineSeries(lineOptions(colors.rsi, 2)).setData(pointRows(rows, "rsi"));
    rsi.addLineSeries(lineOptions("rgba(255,255,255,0.28)", 1)).setData(rows.map((row) => ({ time: row.time, value: 50 })));

    macd.addLineSeries(lineOptions(colors.macd, 2)).setData(pointRows(rows, "macd"));
    macd.addLineSeries(lineOptions(colors.signal, 1)).setData(pointRows(rows, "signal"));
    macd.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false }).setData(
      rows.filter((row) => row.hist !== null && row.hist !== undefined).map((row) => ({ time: row.time, value: row.hist, color: Number(row.hist) >= 0 ? colors.up : colors.down }))
    );
    macd.addLineSeries(lineOptions("rgba(255,255,255,0.2)", 1)).setData(rows.map((row) => ({ time: row.time, value: 0 })));
  }

  async function drawLiveChart(symbol) {
    if (!visibleLiveMarkers(symbol).length) return;
    try {
      const payload = await fetchLiveKlines(symbol);
      drawInterval("Live 5m", payload);
    } catch (error) {
      console.warn("live chart unavailable", error);
      const note = document.createElement("div");
      note.className = "eml2-error";
      note.textContent = `Live chart unavailable: ${error.message}`;
      els.charts.appendChild(note);
    }
  }

  async function fetchLiveKlines(symbol) {
    try {
      return await fetchJson(`/api/live-klines?symbol=${encodeURIComponent(symbol)}&interval=5m&limit=288`);
    } catch (serverError) {
      const binance = await fetch(`https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=5m&limit=288`);
      if (binance.ok) {
        const rows = await binance.json();
        return {
          symbol,
          interval: "5m",
          source: "binance_browser",
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
      const bybit = await fetch(`https://api.bybit.com/v5/market/kline?category=spot&symbol=${encodeURIComponent(symbol)}&interval=5&limit=288`);
      if (bybit.ok) {
        const payload = await bybit.json();
        return {
          symbol,
          interval: "5m",
          source: "bybit_browser",
          bars: (payload?.result?.list || []).map((row) => ({
            time: Math.floor(Number(row[0]) / 1000),
            open: Number(row[1]),
            high: Number(row[2]),
            low: Number(row[3]),
            close: Number(row[4]),
            quoteVolume: Number(row[6]),
          })).sort((a, b) => a.time - b.time),
        };
      }
      throw serverError;
    }
  }

  function syncCharts() {
    function sameRange(a, b) {
      if (!a || !b) return false;
      return Math.abs(Number(a.from) - Number(b.from)) < 1 && Math.abs(Number(a.to) - Number(b.to)) < 1;
    }
    state.charts.forEach((chart) => {
      chart.timeScale().subscribeVisibleTimeRangeChange((range) => {
        if (state.syncing || !range) return;
        if (sameRange(range, state.lastSyncedRange)) return;
        state.syncing = true;
        state.lastSyncedRange = { from: range.from, to: range.to };
        state.charts.filter((item) => item !== chart).forEach((item) => item.timeScale().setVisibleRange(range));
        scheduleOverlayDraw();
        requestAnimationFrame(() => {
          state.syncing = false;
        });
      });
    });
  }

  function currentQuery() {
    const id = state.selectedQueryId;
    if (!id) return null;
    const evidence = (state.evidence?.queries || []).find((item) => item.query_id === id) || null;
    const neighbors = (state.neighbors?.queries || []).find((item) => item.query_id === id) || null;
    const cluster = (state.overlays?.model_layer?.prediction_clusters || []).find((item) => item.cluster_id === id) || null;
    return { evidence, neighbors, cluster };
  }

  function xFor(chart, panel, iso) {
    const x = chart.timeScale().timeToCoordinate(epoch(iso));
    if (x === null) return null;
    return Math.max(-2000, Math.min(panel.clientWidth + 2000, x));
  }

  function addVline(overlay, x, klass) {
    if (x === null) return;
    const line = document.createElement("div");
    line.className = `eml2-vline ${klass}`;
    line.style.left = `${x}px`;
    overlay.appendChild(line);
  }

  function addPriceDot(panel, overlay, x, price, label, klass) {
    if (x === null || !panel.priceSeries || price === null || price === undefined) return;
    const y = panel.priceSeries.priceToCoordinate(Number(price));
    if (y === null) return;
    const dot = document.createElement("div");
    dot.className = `eml2-price-dot ${klass || ""}`;
    dot.style.left = `${x}px`;
    dot.style.top = `${y}px`;
    dot.title = label;
    overlay.appendChild(dot);
  }

  function addBox(chart, panel, overlay, start, end, klass) {
    const x1 = xFor(chart, panel, start);
    const x2 = xFor(chart, panel, end);
    if (x1 === null || x2 === null) return;
    const left = Math.min(x1, x2);
    const width = Math.abs(x2 - x1);
    if (width < 1) return;
    const box = document.createElement("div");
    box.className = `eml2-window ${klass || ""}`;
    box.style.left = `${left}px`;
    box.style.width = `${width}px`;
    overlay.appendChild(box);
  }

  function drawOverlays() {
    if (!state.charts.length) return;
    const clusters = (state.overlays?.model_layer?.prediction_clusters || []).slice(0, MAX_MODEL_LINES);
    const labels = state.overlays?.label_layer?.events || [];
    const selected = currentQuery()?.cluster || null;
    state.panels.forEach(({ overlay }) => overlay.replaceChildren());
    state.charts.forEach((chart, idx) => {
      const { panel, overlay } = state.panels[idx];
      if (state.showModel) {
        clusters.forEach((cluster) => {
          const live = cluster.live_alert_representative?.decision_time_utc;
          const offline = cluster.offline_representative?.decision_time_utc;
          addVline(overlay, xFor(chart, panel, live), "model-live");
          if (cluster.cluster_id === state.selectedQueryId) addVline(overlay, xFor(chart, panel, offline), "model-offline");
        });
      }
      if (state.showWindows && selected) {
        const time = selected.offline_representative?.decision_time_utc || selected.live_alert_representative?.decision_time_utc;
        addBox(chart, panel, overlay, minusHours(time, 2), time, "model");
      }
      if (state.showLabel) {
        labels.forEach((event) => {
          const time = event.decision_time_utc;
          addVline(overlay, xFor(chart, panel, time), "label");
          if (state.showWindows) addBox(chart, panel, overlay, time, plusHours(time, 1), "label");
        });
      }
      if (state.showLive) {
        visibleLiveMarkers(state.symbol).forEach((marker) => {
          const time = marker.decision_time_utc;
          const x = xFor(chart, panel, time);
          addVline(overlay, x, "live-alert");
          if (state.panels[idx]?.klass === "price") {
            const label = `${marker.symbol} ${marker.source_model} ${shortTime(time)} @ ${fmt(marker.entry_reference_price, 6)}`;
            addPriceDot(state.panels[idx], overlay, x, marker.entry_reference_price, label, marker.source_model);
          }
        });
      }
    });
  }

  let overlayFrame = null;
  function scheduleOverlayDraw() {
    if (overlayFrame) cancelAnimationFrame(overlayFrame);
    overlayFrame = requestAnimationFrame(drawOverlays);
  }

  function focusSelectedQuery() {
    const latestLive = state.showLive ? visibleLiveMarkers(state.symbol)[0] : null;
    if (latestLive?.decision_time_utc) {
      const center = epoch(latestLive.decision_time_utc);
      const range = { from: center - 12 * 3600, to: center + 2 * 3600 };
      state.lastSyncedRange = range;
      state.charts.forEach((chart) => chart.timeScale().setVisibleRange(range));
      return;
    }
    const query = currentQuery()?.cluster;
    const time = query?.offline_representative?.decision_time_utc || query?.live_alert_representative?.decision_time_utc;
    if (!time) {
      state.charts.forEach((chart) => chart.timeScale().fitContent());
      return;
    }
    const center = epoch(time);
    const range = { from: center - 36 * 3600, to: center + 18 * 3600 };
    state.lastSyncedRange = range;
    state.charts.forEach((chart) => chart.timeScale().setVisibleRange(range));
  }

  function renderQuerySelect() {
    const clusters = state.overlays?.model_layer?.prediction_clusters || [];
    const options = clusters.map((cluster) => {
      const option = document.createElement("option");
      option.value = cluster.cluster_id;
      const score = cluster.offline_representative?.model_score;
      option.textContent = `${shortTime(cluster.offline_representative?.decision_time_utc)} · ${fmt(score, 3)} · ${cluster.primary_archetype || "mixed"}`;
      option.selected = cluster.cluster_id === state.selectedQueryId;
      return option;
    });
    els.query.replaceChildren(...options);
    els.query.disabled = options.length === 0;
    els.queryCount.textContent = `${options.length}`;
  }

  function tagHtml(label, status) {
    return `<span class="eml2-tag ${status || ""}">${label}</span>`;
  }

  function neighborHtml(items, title) {
    const rows = (items || []).slice(0, 5).map((item) => {
      const outcome = state.showOutcome ? ` · MFE ${fmt(item.outcome?.future_1h_mfe_pct)} · MAE ${fmt(item.outcome?.future_1h_mae_pct)}` : "";
      return `<div class="eml2-row ${item.hit_miss || ""}">
        <strong>${item.symbol}</strong> ${shortTime(item.decision_time_utc)} · sim ${fmt(item.similarity, 3)} · ${item.hit_miss || "-"}${outcome}
        <div class="eml2-muted">${item.primary_archetype || "-"} · ${item.basis || "-"}</div>
      </div>`;
    }).join("");
    return `<div class="eml2-card"><h3>${title}</h3><div class="eml2-list">${rows || '<div class="eml2-muted">없음</div>'}</div></div>`;
  }

  function renderEvidence() {
    const q = currentQuery();
    if (!q?.cluster) {
      els.evidence.innerHTML = `<div class="eml2-empty">선택 가능한 model query가 없습니다.</div>`;
      return;
    }
    const ev = q.evidence;
    const nb = q.neighbors;
    const cluster = q.cluster;
    const outcome = state.showOutcome ? `
      <span>positive</span><strong>${cluster.offline_outcome?.positive_label ?? "-"}</strong>
      <span>MFE/MAE</span><strong>${fmt(cluster.offline_outcome?.future_1h_mfe_pct)} / ${fmt(cluster.offline_outcome?.future_1h_mae_pct)}</strong>
    ` : `<span>outcome</span><strong>숨김</strong>`;
    const contributors = (ev?.model_evidence?.score_context_contributors || []).slice(0, 8).map((item) => `
      <div class="eml2-row">
        <strong>${item.feature}</strong> · ${item.family} · z ${fmt(item.robust_z_vs_past_pool, 2)} · pct ${fmt((item.percentile_vs_past_pool || 0) * 100, 0)}%
      </div>
    `).join("");
    const tags = [
      ...(ev?.archetype_tags || []).map((tag) => tagHtml(tag, typeStatus(tag))),
      ...(ev?.risk_tags_live || []).map((tag) => tagHtml(tag, "risk")),
    ].join("");
    const liveRows = visibleLiveMarkers(state.symbol).slice(0, 8).map((marker) => `
      <div class="eml2-row">
        <strong>${shortTime(marker.decision_time_utc)}</strong> · ${marker.source_model} · ${markerTier(marker)?.toUpperCase() || "-"} · score ${fmt(marker.model_score, 4)}
        <div class="eml2-muted">entry ${fmt(marker.entry_reference_price, 8)} · bybit ${marker.bybit_status || "-"} · okx ${marker.okx_status || "-"}</div>
      </div>
    `).join("");
    els.evidence.innerHTML = `
      <div class="eml2-card">
        <h3>Selected Query (기존 v2.2 모델)</h3>
        <div class="eml2-kv">
          <span>cluster</span><strong>${cluster.cluster_id}</strong>
          <span>live / score-max</span><strong>${shortTime(cluster.live_alert_representative?.decision_time_utc)} / ${shortTime(cluster.offline_representative?.decision_time_utc)}</strong>
          <span>score / threshold</span><strong>${fmt(cluster.offline_representative?.model_score, 4)} / ${fmt(cluster.threshold, 4)}</strong>
          <span>archetype</span><strong>${cluster.primary_archetype || "-"}</strong>
          <span>status</span><strong>${cluster.primary_archetype_status || "-"}</strong>
          ${outcome}
        </div>
        <div class="eml2-tags" style="margin-top:8px">${tags}</div>
      </div>
      <div class="eml2-card">
        <h3>Model Evidence Contract (기존 v2.2)</h3>
        <div class="eml2-kv">
          <span>exact ablation</span><strong>${ev?.model_evidence?.exact_model_ablation_supported ? "yes" : "deferred"}</strong>
          <span>proxy contributors</span><strong>${ev?.model_evidence?.score_context_contributors?.length || 0}</strong>
        </div>
      </div>
      <div class="eml2-card"><h3>Score Context Contributors</h3><div class="eml2-list">${contributors || '<div class="eml2-muted">없음</div>'}</div></div>
      <div class="eml2-card"><h3>Tier Realtime Alert Markers</h3><div class="eml2-list">${liveRows || '<div class="eml2-muted">현재 선택 심볼 알람 없음</div>'}</div></div>
      ${neighborHtml(nb?.model_neighbors, "Model-Matched Cases")}
      ${neighborHtml(nb?.chart_neighbors, "Chart-Similar Cases")}
      ${neighborHtml(nb?.failure_twins, "Failure Twins")}
    `;
  }

  async function loadSymbol() {
    const meta = currentMeta();
    if (!meta) return;
    setStatus(`Loading ${state.month} ${state.symbol}`);
    clearCharts();
    els.evidence.innerHTML = `<div class="eml2-empty">Loading evidence...</div>`;
    els.title.textContent = `${state.symbol} · ${state.month}`;
    els.meta.textContent = `rank ${meta.rank || "-"} · ${meta.prediction_cluster_count || 0} model · ${meta.label_event_count || 0} label · ${meta.chart_data_source || "chart"}`;
    if (!meta.chart_files_ready || !meta.chart_files) {
      els.charts.innerHTML = `<div class="eml2-error">chart data unavailable for ${state.symbol} ${state.month}</div>`;
      return;
    }
    try {
      const [chart5, overlays, evidence, neighbors] = await Promise.all([
        fetchJson(meta.chart_files["5m"]),
        fetchJson(meta.overlay_file),
        fetchJson(meta.evidence_file),
        fetchJson(meta.neighbors_file),
      ]);
      state.overlays = overlays;
      state.evidence = evidence;
      state.neighbors = neighbors;
      const clusters = overlays.model_layer?.prediction_clusters || [];
      if (!state.selectedQueryId || !clusters.some((item) => item.cluster_id === state.selectedQueryId)) {
        const firstWithEvidence = clusters.find((item) => item.has_evidence_neighbors) || clusters[0] || null;
        state.selectedQueryId = firstWithEvidence?.cluster_id || null;
      }
      await drawLiveChart(state.symbol);
      const rows5 = chartRows(chart5);
      drawInterval("5m", { bars: { t: rows5.map((r) => r.time), o: rows5.map((r) => r.open), h: rows5.map((r) => r.high), l: rows5.map((r) => r.low), c: rows5.map((r) => r.close), ma25: rows5.map((r) => r.ma25), ma50: rows5.map((r) => r.ma50), ma200: rows5.map((r) => r.ma200), ma400: rows5.map((r) => r.ma400), vwap: rows5.map((r) => r.vwap), vwma100: rows5.map((r) => r.vwma100), qv: rows5.map((r) => r.quoteVolume), qvz: rows5.map((r) => r.volumeZ), rsi: rows5.map((r) => r.rsi), macd: rows5.map((r) => r.macd), signal: rows5.map((r) => r.signal), hist: rows5.map((r) => r.hist) } });
      const rows15 = resampleRows(rows5, 15 * 60);
      const rows1h = resampleRows(rows5, 60 * 60);
      drawInterval("15m", { bars: { t: rows15.map((r) => r.time), o: rows15.map((r) => r.open), h: rows15.map((r) => r.high), l: rows15.map((r) => r.low), c: rows15.map((r) => r.close), ma25: rows15.map((r) => r.ma25), ma50: rows15.map((r) => r.ma50), ma200: rows15.map((r) => r.ma200), ma400: rows15.map((r) => r.ma400), vwap: rows15.map((r) => r.vwap), vwma100: rows15.map((r) => r.vwma100), qv: rows15.map((r) => r.quoteVolume), qvz: rows15.map((r) => r.volumeZ), rsi: rows15.map((r) => r.rsi), macd: rows15.map((r) => r.macd), signal: rows15.map((r) => r.signal), hist: rows15.map((r) => r.hist) } });
      drawInterval("1h", { bars: { t: rows1h.map((r) => r.time), o: rows1h.map((r) => r.open), h: rows1h.map((r) => r.high), l: rows1h.map((r) => r.low), c: rows1h.map((r) => r.close), ma25: rows1h.map((r) => r.ma25), ma50: rows1h.map((r) => r.ma50), ma200: rows1h.map((r) => r.ma200), ma400: rows1h.map((r) => r.ma400), vwap: rows1h.map((r) => r.vwap), vwma100: rows1h.map((r) => r.vwma100), qv: rows1h.map((r) => r.quoteVolume), qvz: rows1h.map((r) => r.volumeZ), rsi: rows1h.map((r) => r.rsi), macd: rows1h.map((r) => r.macd), signal: rows1h.map((r) => r.signal), hist: rows1h.map((r) => r.hist) } });
      syncCharts();
      renderQuerySelect();
      renderEvidence();
      focusSelectedQuery();
      scheduleOverlayDraw();
      window.setTimeout(drawOverlays, 200);
      window.setTimeout(drawOverlays, 600);
      setStatus(`Ready · ${state.month} ${state.symbol}`);
    } catch (error) {
      console.error(error);
      els.charts.innerHTML = `<div class="eml2-error">로드 실패: ${error.message}</div>`;
      setStatus("Error");
    }
  }

  function bindEvents() {
    els.month.addEventListener("change", () => {
      state.month = els.month.value;
      state.symbol = preferredDefaultSymbol();
      state.selectedQueryId = null;
      renderSidebar();
      loadSymbol();
    });
    els.type.addEventListener("change", () => {
      state.type = els.type.value;
      state.symbol = preferredDefaultSymbol();
      state.selectedQueryId = null;
      renderSidebar();
      loadSymbol();
    });
    for (const [input, key] of [
      [els.showModel, "showModel"],
      [els.showLabel, "showLabel"],
      [els.showWindows, "showWindows"],
      [els.showOutcome, "showOutcome"],
      [els.showLive, "showLive"],
    ]) {
      if (!input) continue;
      input.addEventListener("change", () => {
        state[key] = input.checked;
        drawOverlays();
        renderEvidence();
      });
    }
    for (const tier of ["tier0", "tier1", "tier2"]) {
      if (!els[tier]) continue;
      els[tier].addEventListener("change", () => {
        state.activeTiers[tier] = els[tier].checked;
        state.symbol = preferredLiveSymbol() || state.symbol;
        renderSidebar();
        loadSymbol();
      });
    }
    els.query.addEventListener("change", () => {
      state.selectedQueryId = els.query.value;
      renderEvidence();
      focusSelectedQuery();
      drawOverlays();
    });
    window.addEventListener("resize", () => window.setTimeout(drawOverlays, 100));
  }

  function mergeLiveMarker(marker) {
    if (!marker?.alert_id) return;
    if (!markerTier(marker)) return;
    const idx = state.liveMarkers.findIndex((item) => item.alert_id === marker.alert_id);
    if (idx >= 0) state.liveMarkers[idx] = marker;
    else state.liveMarkers.unshift(marker);
    state.liveMarkers.sort((a, b) => new Date(b.decision_time_utc) - new Date(a.decision_time_utc));
    state.liveMarkers = state.liveMarkers.slice(0, 1200);
  }

  async function setupLiveMarkers() {
    try {
      const config = await fetchJson(`${DATA_ROOT}/live_supabase_config.json`);
      if (!config.enabled) {
        setLiveStatus("Live 비활성", "warn");
        return;
      }
      if (!window.supabase?.createClient) {
        setLiveStatus("Supabase JS 없음", "warn");
        return;
      }
      state.supabaseClient = window.supabase.createClient(config.supabase_url, config.supabase_publishable_key);
      const { data, error } = await state.supabaseClient
        .from(config.table)
        .select("*")
        .like("source_model", "candle_frequency_tier%")
        .order("decision_time_utc", { ascending: false })
        .limit(500);
      if (error) throw error;
      (data || []).forEach(mergeLiveMarker);
      setLiveStatus(`Live 연결 · ${state.liveMarkers.length} markers`, "ok");
      renderEvidence();
      scheduleOverlayDraw();
      state.liveChannel = state.supabaseClient
        .channel("entry-ml-v2-alert-markers")
        .on("postgres_changes", { event: "*", schema: "public", table: config.table }, (payload) => {
          if (payload.new && markerTier(payload.new)) {
            mergeLiveMarker(payload.new);
            setLiveStatus(`Live 수신 · ${shortTime(payload.new.decision_time_utc)} ${payload.new.symbol}`, "ok");
            renderEvidence();
            scheduleOverlayDraw();
          }
        })
        .subscribe((status) => {
          if (status === "SUBSCRIBED") setLiveStatus(`Live 구독 · ${state.liveMarkers.length} markers`, "ok");
          else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") setLiveStatus(`Live ${status}`, "warn");
        });
    } catch (error) {
      console.error(error);
      setLiveStatus(`Live 실패: ${error.message}`, "warn");
    }
  }

  async function init() {
    try {
      const [index, taxonomy] = await Promise.all([
        fetchJson(`${CHART_ROOT}/index.json`),
        fetchJson(`${DATA_ROOT}/taxonomy/taxonomy_registry.json`),
      ]);
      state.index = index;
      state.taxonomy = taxonomy;
      state.month = index.months[index.months.length - 1];
      state.type = "all";
      state.symbol = preferredDefaultSymbol();
      renderControls();
      renderLegend();
      renderSidebar();
      bindEvents();
      await setupLiveMarkers();
      state.symbol = preferredLiveSymbol() || state.symbol;
      renderSidebar();
      await loadSymbol();
    } catch (error) {
      console.error(error);
      setStatus("Failed");
      els.charts.innerHTML = `<div class="eml2-error">초기화 실패: ${error.message}</div>`;
    }
  }

  init();
})();
