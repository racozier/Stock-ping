// Watchlist: [{symbol, name}] — persisted in localStorage
let watchlist = JSON.parse(localStorage.getItem("sp_watchlist") || "[]");
// Track previous prices for flash animation
let prevPrices = {};
// Symbol being edited in the alert modal
let alertModalSymbol = null;

// Sort state for watchlist
let sortCol = "change_pct";
let sortDir = -1; // -1 = desc, 1 = asc

// Cached quote data for sorting
let lastQuoteData = {};

// Chart instances — destroyed when modal closes
let priceChart = null, rsiChart = null, macdChart = null;
let priceSeries = null, ma20Series = null, ma50Series = null;
let rsiSeries = null;
let macdHistSeries = null, macdLineSeries = null, macdSigSeries = null;

// Current chart symbol/period
let chartSymbol = null;
let chartPeriod = "1mo";

// Indicator visibility
let indicatorVisible = { ma20: true, ma50: true, rsi: true, macd: true };

// Portfolio refresh timer
let portfolioRefreshTimer = null;

// ── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
    loadConfig();
    refreshAll();
    setInterval(refreshAll, 60000);

    document.getElementById("addWatchBtn").addEventListener("click", addToWatchlist);
    document.getElementById("symbolInput").addEventListener("keydown", e => {
        if (e.key === "Enter") addToWatchlist();
    });

    document.getElementById("watchFilter").addEventListener("input", filterWatchlist);

    document.getElementById("saveAlertBtn").addEventListener("click", saveAlert);
    document.getElementById("saveConfigBtn").addEventListener("click", saveConfig);
    document.getElementById("savePositionBtn").addEventListener("click", savePosition);

    // Auto-uppercase symbol input
    document.getElementById("symbolInput").addEventListener("input", function () {
        this.value = this.value.toUpperCase();
    });
    document.getElementById("ptSymbolInput").addEventListener("input", function () {
        this.value = this.value.toUpperCase();
    });

    // Sortable column headers
    document.querySelectorAll("#watchlistTable th.sortable").forEach(th => {
        th.style.cursor = "pointer";
        th.addEventListener("click", () => {
            const col = th.dataset.col;
            if (sortCol === col) {
                sortDir *= -1;
            } else {
                sortCol = col;
                sortDir = col === "change_pct" ? -1 : 1;
            }
            renderWatchlistRows();
        });
    });

    // Alert type radio toggle
    document.querySelectorAll('input[name="alertType"]').forEach(radio => {
        radio.addEventListener("change", updateAlertTypeUI);
    });

    // Technical indicator type toggle (show/hide RSI threshold)
    document.getElementById("alertTechType").addEventListener("change", updateTechSubUI);

    // Chart modal timeframe buttons
    document.querySelectorAll(".tf-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".tf-btn").forEach(b => b.classList.remove("tf-active", "active"));
            btn.classList.add("tf-active", "active");
            chartPeriod = btn.dataset.period;
            if (chartSymbol) loadChart(chartSymbol, chartPeriod);
        });
    });

    // Chart indicator toggles
    document.querySelectorAll(".indicator-toggle").forEach(btn => {
        btn.addEventListener("click", () => {
            const ind = btn.dataset.indicator;
            indicatorVisible[ind] = !indicatorVisible[ind];
            btn.classList.toggle("active", indicatorVisible[ind]);
            applyIndicatorVisibility();
        });
    });

    // Destroy charts when modal closes
    const chartModalEl = document.getElementById("chartModal");
    chartModalEl.addEventListener("hidden.bs.modal", destroyCharts);

    // Portfolio tab: load data when clicked
    document.getElementById("portfolio-tab").addEventListener("click", () => {
        refreshPortfolio();
        if (portfolioRefreshTimer) clearInterval(portfolioRefreshTimer);
        portfolioRefreshTimer = setInterval(refreshPortfolio, 60000);
    });

    // Stop refreshing portfolio when switching away
    document.getElementById("watchlist-tab").addEventListener("click", () => {
        if (portfolioRefreshTimer) {
            clearInterval(portfolioRefreshTimer);
            portfolioRefreshTimer = null;
        }
    });
});

// ── Alert Type UI ─────────────────────────────────────────────────────────────

function updateAlertTypeUI() {
    const type = document.querySelector('input[name="alertType"]:checked').value;
    document.getElementById("alertPriceFields").classList.toggle("d-none", type !== "price");
    document.getElementById("alertPercentFields").classList.toggle("d-none", type !== "percent");
    document.getElementById("alertTechFields").classList.toggle("d-none", type !== "technical");
}

function updateTechSubUI() {
    const techType = document.getElementById("alertTechType").value;
    const isRsi = techType === "rsi_above" || techType === "rsi_below";
    document.getElementById("alertRsiThresholdWrap").classList.toggle("d-none", !isRsi);
    if (isRsi) {
        document.getElementById("alertRsiThreshold").value = techType === "rsi_above" ? 70 : 30;
    }
}

// ── Watchlist ─────────────────────────────────────────────────────────────────

async function addToWatchlist() {
    const input = document.getElementById("symbolInput");
    const symbol = input.value.trim().toUpperCase();
    if (!symbol) return;

    if (watchlist.find(w => w.symbol === symbol)) {
        showToast(`${symbol} is already in your watchlist.`, "warning");
        input.value = "";
        return;
    }

    const btn = document.getElementById("addWatchBtn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';

    try {
        const resp = await fetch(`/api/quote?symbols=${symbol}`);
        const data = await resp.json();
        const q = data[symbol];

        if (!q || q.error || q.price == null) {
            showToast(`Ticker not found: ${symbol}`, "danger");
            return;
        }

        watchlist.push({ symbol, name: q.name || symbol });
        saveWatchlist();
        input.value = "";
        await refreshWatchlist();
    } catch (e) {
        showToast("Network error. Try again.", "danger");
    } finally {
        btn.disabled = false;
        btn.innerHTML = "Add to Watchlist";
    }
}

function removeFromWatchlist(symbol) {
    watchlist = watchlist.filter(w => w.symbol !== symbol);
    saveWatchlist();
    refreshWatchlist();
}

function saveWatchlist() {
    localStorage.setItem("sp_watchlist", JSON.stringify(watchlist));
}

function filterWatchlist() {
    const q = document.getElementById("watchFilter").value.toLowerCase();
    document.querySelectorAll("#watchlistBody tr").forEach(tr => {
        if (tr.classList.contains("empty-row")) return;
        tr.style.display = tr.textContent.toLowerCase().includes(q) ? "" : "none";
    });
}

async function refreshWatchlist() {
    const tbody = document.getElementById("watchlistBody");

    if (watchlist.length === 0) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="7">Add a ticker above to get started.</td></tr>`;
        return;
    }

    const symbols = watchlist.map(w => w.symbol).join(",");
    try {
        const resp = await fetch(`/api/quote?symbols=${symbols}`);
        lastQuoteData = await resp.json();
    } catch (e) {
        return;
    }

    // Cache updated names
    watchlist.forEach(item => {
        const q = lastQuoteData[item.symbol] || {};
        if (q.name && q.name !== item.symbol) item.name = q.name;
    });
    saveWatchlist();

    renderWatchlistRows();
}

function renderWatchlistRows() {
    const tbody = document.getElementById("watchlistBody");
    if (watchlist.length === 0) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="7">Add a ticker above to get started.</td></tr>`;
        return;
    }

    // Build enriched list for sorting
    const rows = watchlist.map(item => {
        const q = lastQuoteData[item.symbol] || {};
        return { ...item, ...q };
    });

    // Sort
    rows.sort((a, b) => {
        let av = a[sortCol], bv = b[sortCol];
        if (sortCol === "symbol" || sortCol === "name") {
            av = (av || "").toLowerCase();
            bv = (bv || "").toLowerCase();
            return av < bv ? -sortDir : av > bv ? sortDir : 0;
        }
        av = av != null ? av : (sortDir === 1 ? Infinity : -Infinity);
        bv = bv != null ? bv : (sortDir === 1 ? Infinity : -Infinity);
        return (av - bv) * sortDir;
    });

    // Update sort icons
    document.querySelectorAll("#watchlistTable th.sortable").forEach(th => {
        const icon = th.querySelector(".sort-icon");
        if (th.dataset.col === sortCol) {
            icon.textContent = sortDir === 1 ? " ▲" : " ▼";
        } else {
            icon.textContent = "";
        }
    });

    tbody.innerHTML = "";
    rows.forEach(item => {
        const q = lastQuoteData[item.symbol] || {};

        const hasPrice = q.price != null;
        const priceStr = hasPrice ? `$${q.price.toFixed(2)}` : "—";
        const prev = prevPrices[item.symbol];
        let flashClass = "";
        if (hasPrice && prev != null) {
            if (q.price > prev) flashClass = "price-up";
            else if (q.price < prev) flashClass = "price-down";
        }
        if (hasPrice) prevPrices[item.symbol] = q.price;

        const changePct = q.change_pct != null ? q.change_pct : null;
        const isPositive = changePct != null && changePct >= 0;
        const isBig = changePct != null && Math.abs(changePct) > 2;
        const changeClass = changePct == null ? "" :
            (isPositive ? "text-success" : "text-danger") + (isBig ? " fw-bold" : " fw-semibold");
        const changeStr = changePct != null
            ? `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`
            : "—";

        const mcStr = formatMarketCap(q.market_cap);

        const tr = document.createElement("tr");
        tr.style.cursor = "pointer";
        tr.title = "Click to view chart";
        tr.addEventListener("click", (e) => {
            // Don't open chart if clicking a button
            if (e.target.closest("button")) return;
            openChartModal(item.symbol, item.name || item.symbol);
        });

        tr.innerHTML = `
            <td><span class="symbol-badge">${item.symbol}</span></td>
            <td class="text-truncate" style="max-width:140px;" title="${item.name || ""}">${item.name || ""}</td>
            <td class="price-cell ${flashClass}">${priceStr}</td>
            <td class="${changeClass}">${changeStr}</td>
            <td class="text-muted">${mcStr}</td>
            <td>
                <button class="btn btn-sm btn-outline-warning"
                    onclick="openAlertModal('${item.symbol}')">
                    Set Alert
                </button>
            </td>
            <td>
                <button class="btn btn-sm btn-outline-danger"
                    onclick="removeFromWatchlist('${item.symbol}')"
                    title="Remove">×</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    filterWatchlist();
}

function formatMarketCap(mc) {
    if (mc == null) return "—";
    if (mc >= 1e12) return (mc / 1e12).toFixed(2) + "T";
    if (mc >= 1e9)  return (mc / 1e9).toFixed(1) + "B";
    if (mc >= 1e6)  return (mc / 1e6).toFixed(0) + "M";
    return mc.toLocaleString();
}

// ── Chart Modal ───────────────────────────────────────────────────────────────

const CHART_THEME = {
    background: "#1a1a2e",
    text: "#d1d5db",
    grid: "#2d2d4e",
    border: "#3d3d5e",
};

function openChartModal(symbol, name) {
    chartSymbol = symbol;
    chartPeriod = "1mo";

    // Reset timeframe buttons
    document.querySelectorAll(".tf-btn").forEach(b => {
        b.classList.remove("tf-active", "active");
        if (b.dataset.period === "1mo") b.classList.add("tf-active", "active");
    });

    // Reset indicator toggles
    indicatorVisible = { ma20: true, ma50: true, rsi: true, macd: true };
    document.querySelectorAll(".indicator-toggle").forEach(b => b.classList.add("active"));

    document.getElementById("chartModalLabel").textContent = `${symbol} — ${name}`;
    const modal = new bootstrap.Modal(document.getElementById("chartModal"));
    modal.show();

    // Load chart after modal is shown (so divs have dimensions)
    document.getElementById("chartModal").addEventListener("shown.bs.modal", function handler() {
        this.removeEventListener("shown.bs.modal", handler);
        loadChart(symbol, chartPeriod);
    });
}

function destroyCharts() {
    if (priceChart) { try { priceChart.remove(); } catch(e){} priceChart = null; }
    if (rsiChart)   { try { rsiChart.remove();   } catch(e){} rsiChart   = null; }
    if (macdChart)  { try { macdChart.remove();  } catch(e){} macdChart  = null; }
    priceSeries = ma20Series = ma50Series = null;
    rsiSeries = null;
    macdHistSeries = macdLineSeries = macdSigSeries = null;
}

async function loadChart(symbol, period) {
    document.getElementById("chartLoading").classList.remove("d-none");
    document.getElementById("chartError").classList.add("d-none");
    document.getElementById("chartWrap").style.visibility = "hidden";

    destroyCharts();

    let data;
    try {
        const resp = await fetch(`/api/chart/${symbol}?period=${period}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        data = await resp.json();
        if (data.error) throw new Error(data.error);
    } catch (e) {
        document.getElementById("chartLoading").classList.add("d-none");
        const errEl = document.getElementById("chartError");
        errEl.textContent = `Failed to load chart: ${e.message}`;
        errEl.classList.remove("d-none");
        return;
    }

    document.getElementById("chartLoading").classList.add("d-none");
    document.getElementById("chartWrap").style.visibility = "visible";

    const chartOpts = {
        layout: {
            background: { color: CHART_THEME.background },
            textColor: CHART_THEME.text,
        },
        grid: {
            vertLines: { color: CHART_THEME.grid },
            horzLines: { color: CHART_THEME.grid },
        },
        crosshair: { mode: 0 },
        rightPriceScale: { borderColor: CHART_THEME.border },
        timeScale: { borderColor: CHART_THEME.border, timeVisible: true },
        handleScroll: true,
        handleScale: true,
    };

    // ── Price chart ──────────────────────────────────────────────────────────
    const priceDiv = document.getElementById("priceChartDiv");
    priceChart = LightweightCharts.createChart(priceDiv, {
        ...chartOpts,
        width: priceDiv.clientWidth,
        height: 380,
    });

    priceSeries = priceChart.addCandlestickSeries({
        upColor: "#26a69a", downColor: "#ef5350",
        borderVisible: false,
        wickUpColor: "#26a69a", wickDownColor: "#ef5350",
    });
    priceSeries.setData(data.candles);

    ma20Series = priceChart.addLineSeries({
        color: "#f59e0b", lineWidth: 1.5, title: "MA20",
    });
    ma20Series.setData(data.ma20);

    ma50Series = priceChart.addLineSeries({
        color: "#3b82f6", lineWidth: 1.5, title: "MA50",
    });
    ma50Series.setData(data.ma50);

    priceChart.timeScale().fitContent();

    // ── RSI chart ────────────────────────────────────────────────────────────
    const rsiDiv = document.getElementById("rsiChartDiv");
    rsiChart = LightweightCharts.createChart(rsiDiv, {
        ...chartOpts,
        width: rsiDiv.clientWidth,
        height: 130,
        timeScale: { ...chartOpts.timeScale, visible: false },
    });

    rsiSeries = rsiChart.addLineSeries({ color: "#a78bfa", lineWidth: 1.5, title: "RSI" });
    rsiSeries.setData(data.rsi);

    // Horizontal lines at 70 and 30
    rsiSeries.createPriceLine({ price: 70, color: "#ef5350", lineWidth: 1, lineStyle: 2, title: "70" });
    rsiSeries.createPriceLine({ price: 30, color: "#26a69a", lineWidth: 1, lineStyle: 2, title: "30" });

    rsiChart.timeScale().fitContent();

    // ── MACD chart ───────────────────────────────────────────────────────────
    const macdDiv = document.getElementById("macdChartDiv");
    macdChart = LightweightCharts.createChart(macdDiv, {
        ...chartOpts,
        width: macdDiv.clientWidth,
        height: 130,
        timeScale: { ...chartOpts.timeScale, visible: false },
    });

    macdHistSeries = macdChart.addHistogramSeries({
        color: "#26a69a",
        title: "Hist",
        priceFormat: { type: "price", precision: 4 },
    });
    // Color histogram bars green/red based on value
    const histData = data.macd.histogram.map(d => ({
        time: d.time,
        value: d.value,
        color: d.value >= 0 ? "#26a69a" : "#ef5350",
    }));
    macdHistSeries.setData(histData);

    macdLineSeries = macdChart.addLineSeries({ color: "#3b82f6", lineWidth: 1.5, title: "MACD" });
    macdLineSeries.setData(data.macd.macd);

    macdSigSeries = macdChart.addLineSeries({ color: "#f97316", lineWidth: 1.5, title: "Signal" });
    macdSigSeries.setData(data.macd.signal);

    macdChart.timeScale().fitContent();

    // Sync timescales: when price chart scrolls, sync RSI and MACD
    priceChart.timeScale().subscribeVisibleLogicalRangeChange(range => {
        if (range) {
            rsiChart.timeScale().setVisibleLogicalRange(range);
            macdChart.timeScale().setVisibleLogicalRange(range);
        }
    });

    applyIndicatorVisibility();
}

function applyIndicatorVisibility() {
    if (ma20Series)     ma20Series.applyOptions({ visible: indicatorVisible.ma20 });
    if (ma50Series)     ma50Series.applyOptions({ visible: indicatorVisible.ma50 });
    if (rsiSeries) {
        document.getElementById("rsiChartDiv").style.display =
            indicatorVisible.rsi ? "" : "none";
    }
    if (macdHistSeries) {
        document.getElementById("macdChartDiv").style.display =
            indicatorVisible.macd ? "" : "none";
    }
}

// ── Alerts ────────────────────────────────────────────────────────────────────

function openAlertModal(symbol) {
    alertModalSymbol = symbol;
    document.getElementById("alertModalSymbol").textContent = symbol;
    document.getElementById("alertTargetPrice").value = "";
    document.getElementById("alertDirection").value = "below";
    document.getElementById("alertPercentValue").value = "";
    document.getElementById("alertRsiThreshold").value = "70";

    // Reset to price type
    document.getElementById("alertTypePrice").checked = true;
    updateAlertTypeUI();
    updateTechSubUI();

    // Clear validation states
    ["alertTargetPrice", "alertPercentValue", "alertRsiThreshold"].forEach(id => {
        document.getElementById(id).classList.remove("is-invalid");
    });

    new bootstrap.Modal(document.getElementById("alertModal")).show();
}

async function saveAlert() {
    const type = document.querySelector('input[name="alertType"]:checked').value;
    let body = { symbol: alertModalSymbol };
    let valid = true;

    if (type === "price") {
        const rawPrice = document.getElementById("alertTargetPrice").value;
        const targetPrice = parseFloat(rawPrice);
        const direction = document.getElementById("alertDirection").value;
        if (!rawPrice || isNaN(targetPrice) || targetPrice <= 0) {
            document.getElementById("alertTargetPrice").classList.add("is-invalid");
            valid = false;
        } else {
            document.getElementById("alertTargetPrice").classList.remove("is-invalid");
        }
        if (!valid) return;
        body = { ...body, type: "price", target_price: targetPrice, direction };

    } else if (type === "percent") {
        const rawPct = document.getElementById("alertPercentValue").value;
        const pct = parseFloat(rawPct);
        const direction = document.querySelector('input[name="percentDir"]:checked').value;
        if (!rawPct || isNaN(pct) || pct <= 0) {
            document.getElementById("alertPercentValue").classList.add("is-invalid");
            valid = false;
        } else {
            document.getElementById("alertPercentValue").classList.remove("is-invalid");
        }
        if (!valid) return;
        body = { ...body, type: "percent", percent: pct, direction };

    } else if (type === "technical") {
        const techType = document.getElementById("alertTechType").value;
        body = { ...body, type: techType };
        if (techType === "rsi_above" || techType === "rsi_below") {
            const rawRsi = document.getElementById("alertRsiThreshold").value;
            const rsiVal = parseFloat(rawRsi);
            if (!rawRsi || isNaN(rsiVal) || rsiVal < 1 || rsiVal > 99) {
                document.getElementById("alertRsiThreshold").classList.add("is-invalid");
                return;
            }
            document.getElementById("alertRsiThreshold").classList.remove("is-invalid");
            body.rsi_threshold = rsiVal;
        }
    }

    try {
        const resp = await fetch("/api/alerts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.error || "Server error");
        }
        bootstrap.Modal.getInstance(document.getElementById("alertModal")).hide();
        showToast(`Alert set for ${alertModalSymbol}`, "success");
        await refreshAlerts();
    } catch (e) {
        showToast(`Failed to save alert: ${e.message}`, "danger");
    }
}

async function deleteAlert(id) {
    await fetch(`/api/alerts/${id}`, { method: "DELETE" });
    await refreshAlerts();
}

async function refreshAlerts() {
    let alerts = [];
    try {
        const resp = await fetch("/api/alerts");
        alerts = await resp.json();
    } catch (e) {
        return;
    }

    const tbody = document.getElementById("alertsBody");
    tbody.innerHTML = "";

    if (alerts.length === 0) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="5">No alerts set yet.</td></tr>`;
        return;
    }

    alerts.forEach(a => {
        const isTriggered = a.status === "triggered";
        const badgeClass = isTriggered ? "badge-status-triggered" : "badge-status-active";
        const badgeLabel = isTriggered ? "Triggered" : "Active";

        let typeLabel = "Price";
        let targetStr = "";

        if (a.type === "price" || !a.type) {
            typeLabel = "Price";
            const dirIcon = a.direction === "above" ? "▲" : "▼";
            targetStr = `${dirIcon} $${(a.target_price || 0).toFixed(2)}`;
        } else if (a.type === "percent") {
            typeLabel = "% Change";
            const dirIcon = a.direction === "above" ? "▲" : "▼";
            targetStr = `${dirIcon} ${a.percent}%`;
        } else if (a.type === "rsi_above") {
            typeLabel = "RSI";
            targetStr = `▲ ${a.rsi_threshold}`;
        } else if (a.type === "rsi_below") {
            typeLabel = "RSI";
            targetStr = `▼ ${a.rsi_threshold}`;
        } else if (a.type === "ma_cross_above") {
            typeLabel = "MA Cross";
            targetStr = "MA20 > MA50";
        } else if (a.type === "ma_cross_below") {
            typeLabel = "MA Cross";
            targetStr = "MA20 < MA50";
        }

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><span class="symbol-badge">${a.symbol}</span></td>
            <td><small class="text-muted">${typeLabel}</small></td>
            <td class="fw-semibold">${targetStr}</td>
            <td><span class="badge ${badgeClass}">${badgeLabel}</span></td>
            <td>
                <button class="btn btn-sm btn-outline-danger"
                    onclick="deleteAlert('${a.id}')" title="Delete">×</button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// ── Portfolio ─────────────────────────────────────────────────────────────────

async function savePosition() {
    const symbol = document.getElementById("ptSymbolInput").value.trim().toUpperCase();
    const shares = parseFloat(document.getElementById("ptSharesInput").value);
    const avgCost = parseFloat(document.getElementById("ptAvgCostInput").value);

    let valid = true;
    if (!symbol) {
        document.getElementById("ptSymbolInput").classList.add("is-invalid");
        valid = false;
    } else {
        document.getElementById("ptSymbolInput").classList.remove("is-invalid");
    }
    if (isNaN(shares) || shares <= 0) {
        document.getElementById("ptSharesInput").classList.add("is-invalid");
        valid = false;
    } else {
        document.getElementById("ptSharesInput").classList.remove("is-invalid");
    }
    if (isNaN(avgCost) || avgCost <= 0) {
        document.getElementById("ptAvgCostInput").classList.add("is-invalid");
        valid = false;
    } else {
        document.getElementById("ptAvgCostInput").classList.remove("is-invalid");
    }
    if (!valid) return;

    const btn = document.getElementById("savePositionBtn");
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner-border spinner-border-sm"></span>';

    try {
        const resp = await fetch("/api/portfolio", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ symbol, shares, avg_cost: avgCost }),
        });
        if (!resp.ok) {
            const err = await resp.json();
            throw new Error(err.error || "Server error");
        }
        bootstrap.Modal.getInstance(document.getElementById("portfolioModal")).hide();
        showToast(`Position added: ${symbol}`, "success");

        // Clear inputs
        document.getElementById("ptSymbolInput").value = "";
        document.getElementById("ptSharesInput").value = "";
        document.getElementById("ptAvgCostInput").value = "";

        await refreshPortfolio();
    } catch (e) {
        showToast(`Failed to add position: ${e.message}`, "danger");
    } finally {
        btn.disabled = false;
        btn.innerHTML = "Add Position";
    }
}

async function removePosition(symbol) {
    if (!confirm(`Remove ${symbol} from portfolio?`)) return;
    try {
        await fetch(`/api/portfolio/${symbol}`, { method: "DELETE" });
        await refreshPortfolio();
    } catch (e) {
        showToast("Failed to remove position.", "danger");
    }
}

async function refreshPortfolio() {
    const tbody = document.getElementById("portfolioBody");
    tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted"><span class="spinner-border spinner-border-sm"></span> Loading…</td></tr>`;

    let data;
    try {
        const resp = await fetch("/api/portfolio");
        data = await resp.json();
    } catch (e) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="9">Failed to load portfolio.</td></tr>`;
        return;
    }

    const positions = data.positions || [];
    const summary = data.summary || {};

    // Update summary cards
    document.getElementById("ptTotalValue").textContent =
        summary.total_value != null ? `$${summary.total_value.toLocaleString("en-US", {minimumFractionDigits:2, maximumFractionDigits:2})}` : "—";

    const pnl = summary.total_pnl;
    const pnlEl = document.getElementById("ptTotalPnl");
    if (pnl != null) {
        pnlEl.textContent = `${pnl >= 0 ? "+" : ""}$${Math.abs(pnl).toLocaleString("en-US", {minimumFractionDigits:2, maximumFractionDigits:2})}`;
        pnlEl.className = "fs-4 fw-bold " + (pnl >= 0 ? "text-success" : "text-danger");
    } else {
        pnlEl.textContent = "—";
        pnlEl.className = "fs-4 fw-bold";
    }

    const ret = summary.total_pnl_pct;
    const retEl = document.getElementById("ptTotalReturn");
    if (ret != null) {
        retEl.textContent = `${ret >= 0 ? "+" : ""}${ret.toFixed(2)}%`;
        retEl.className = "fs-4 fw-bold " + (ret >= 0 ? "text-success" : "text-danger");
    } else {
        retEl.textContent = "—";
        retEl.className = "fs-4 fw-bold";
    }

    document.getElementById("ptPositionCount").textContent = positions.length;

    // Render table
    tbody.innerHTML = "";
    if (positions.length === 0) {
        tbody.innerHTML = `<tr class="empty-row"><td colspan="9">No positions yet. Add one above.</td></tr>`;
        return;
    }

    positions.forEach(pos => {
        const pnlClass = pos.pnl >= 0 ? "text-success" : "text-danger";
        const pnlSign = pos.pnl >= 0 ? "+" : "";
        const pnlPctSign = pos.pnl_pct >= 0 ? "+" : "";

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><span class="symbol-badge">${pos.symbol}</span></td>
            <td class="text-truncate" style="max-width:120px;" title="${pos.name}">${pos.name}</td>
            <td>${pos.shares}</td>
            <td>$${pos.avg_cost.toFixed(2)}</td>
            <td>$${pos.current_price.toFixed(2)}</td>
            <td>$${pos.current_value.toFixed(2)}</td>
            <td class="${pnlClass} fw-semibold">${pnlSign}$${Math.abs(pos.pnl).toFixed(2)}</td>
            <td class="${pnlClass} fw-semibold">${pnlPctSign}${pos.pnl_pct.toFixed(2)}%</td>
            <td>
                <button class="btn btn-sm btn-outline-danger"
                    onclick="removePosition('${pos.symbol}')" title="Remove">
                    🗑
                </button>
            </td>
        `;
        tbody.appendChild(tr);
    });
}

// ── Config ────────────────────────────────────────────────────────────────────

async function loadConfig() {
    try {
        const resp = await fetch("/api/config");
        const cfg = await resp.json();
        document.getElementById("ntfyTopicInput").value = cfg.ntfy_topic || "";
        const banner = document.getElementById("setupBanner");
        if (!cfg.ntfy_topic) {
            banner.classList.remove("d-none");
        } else {
            banner.classList.add("d-none");
        }
    } catch (e) { /* ignore */ }
}

async function saveConfig() {
    const topic = document.getElementById("ntfyTopicInput").value.trim();
    try {
        await fetch("/api/config", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ntfy_topic: topic }),
        });
        bootstrap.Modal.getInstance(document.getElementById("settingsModal")).hide();
        showToast("Settings saved.", "success");
        loadConfig();
    } catch (e) {
        showToast("Failed to save settings.", "danger");
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function refreshAll() {
    await Promise.all([refreshWatchlist(), refreshAlerts()]);
    document.getElementById("lastUpdated").textContent =
        "Last updated: " + new Date().toLocaleTimeString();
}

function showToast(message, type = "info") {
    const container = document.getElementById("toastContainer");
    const id = "toast-" + Date.now();
    const colors = {
        success: "text-bg-success",
        danger:  "text-bg-danger",
        warning: "text-bg-warning",
        info:    "text-bg-info",
    };
    const div = document.createElement("div");
    div.id = id;
    div.className = `toast align-items-center ${colors[type] || "text-bg-info"} border-0`;
    div.setAttribute("role", "alert");
    div.setAttribute("aria-live", "assertive");
    div.innerHTML = `
        <div class="d-flex">
            <div class="toast-body fw-semibold">${message}</div>
            <button type="button" class="btn-close btn-close-white me-2 m-auto"
                data-bs-dismiss="toast"></button>
        </div>
    `;
    container.appendChild(div);
    const toast = new bootstrap.Toast(div, { delay: 4000 });
    toast.show();
    div.addEventListener("hidden.bs.toast", () => div.remove());
}
