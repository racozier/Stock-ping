// Watchlist: [{symbol, name}] — persisted in localStorage
let watchlist = JSON.parse(localStorage.getItem("sp_watchlist") || "[]");
// Track previous prices for flash animation
let prevPrices = {};
// Symbol being edited in the alert modal
let alertModalSymbol = null;

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

    // Auto-uppercase symbol input
    document.getElementById("symbolInput").addEventListener("input", function () {
        this.value = this.value.toUpperCase();
    });
});

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
        tbody.innerHTML = `<tr class="empty-row"><td colspan="6">Add a ticker above to get started.</td></tr>`;
        return;
    }

    const symbols = watchlist.map(w => w.symbol).join(",");
    let data = {};
    try {
        const resp = await fetch(`/api/quote?symbols=${symbols}`);
        data = await resp.json();
    } catch (e) {
        // keep stale rows visible, just don't update
        return;
    }

    tbody.innerHTML = "";
    watchlist.forEach(item => {
        const q = data[item.symbol] || {};

        // Cache updated name
        if (q.name && q.name !== item.symbol) item.name = q.name;

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
        const changeClass = changePct >= 0 ? "text-success" : "text-danger";
        const changeStr = changePct != null
            ? `${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%`
            : "—";

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><span class="symbol-badge">${item.symbol}</span></td>
            <td class="text-truncate" style="max-width:140px;" title="${item.name || ""}">${item.name || ""}</td>
            <td class="price-cell ${flashClass}">${priceStr}</td>
            <td class="${changeClass} fw-semibold">${changeStr}</td>
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

    // Persist cached names
    saveWatchlist();
    // Re-apply active filter
    filterWatchlist();
}

// ── Alerts ────────────────────────────────────────────────────────────────────

function openAlertModal(symbol) {
    alertModalSymbol = symbol;
    document.getElementById("alertModalSymbol").textContent = symbol;
    document.getElementById("alertTargetPrice").value = "";
    document.getElementById("alertDirection").value = "below";
    new bootstrap.Modal(document.getElementById("alertModal")).show();
}

async function saveAlert() {
    const rawPrice = document.getElementById("alertTargetPrice").value;
    const targetPrice = parseFloat(rawPrice);
    const direction = document.getElementById("alertDirection").value;

    if (!rawPrice || isNaN(targetPrice) || targetPrice <= 0) {
        document.getElementById("alertTargetPrice").classList.add("is-invalid");
        return;
    }
    document.getElementById("alertTargetPrice").classList.remove("is-invalid");

    try {
        const resp = await fetch("/api/alerts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                symbol: alertModalSymbol,
                target_price: targetPrice,
                direction,
            }),
        });
        if (!resp.ok) throw new Error("Server error");
        bootstrap.Modal.getInstance(document.getElementById("alertModal")).hide();
        showToast(`Alert set: ${alertModalSymbol} ${direction} $${targetPrice.toFixed(2)}`, "success");
        await refreshAlerts();
    } catch (e) {
        showToast("Failed to save alert.", "danger");
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
        const dirIcon = a.direction === "above" ? "▲" : "▼";

        const tr = document.createElement("tr");
        tr.innerHTML = `
            <td><span class="symbol-badge">${a.symbol}</span></td>
            <td class="fw-semibold">$${a.target_price.toFixed(2)}</td>
            <td>${dirIcon} ${a.direction}</td>
            <td><span class="badge ${badgeClass}">${badgeLabel}</span></td>
            <td>
                <button class="btn btn-sm btn-outline-danger"
                    onclick="deleteAlert('${a.id}')" title="Delete">×</button>
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
