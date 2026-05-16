import os
import uuid
import threading
from datetime import datetime, timedelta

import numpy as np
import yfinance as yf
from flask import Flask, request, jsonify, render_template
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

alerts = []
alerts_lock = threading.Lock()

config = {"ntfy_topic": os.getenv("NTFY_TOPIC", "")}
config_lock = threading.Lock()

portfolio = {}
portfolio_lock = threading.Lock()


# ── Indicator helpers ──────────────────────────────────────────────

def _calc_sma(values, period):
    result = []
    arr = list(values)
    for i in range(period - 1, len(arr)):
        result.append(np.mean(arr[i - period + 1 : i + 1]))
    return result


def _calc_ema(values, period):
    arr = np.array(values, dtype=float)
    k = 2.0 / (period + 1)
    ema = np.zeros(len(arr))
    ema[period - 1] = np.mean(arr[:period])
    for i in range(period, len(arr)):
        ema[i] = arr[i] * k + ema[i - 1] * (1 - k)
    return ema


def _calc_rsi(closes, period=14):
    arr = np.array(closes, dtype=float)
    deltas = np.diff(arr)
    gains = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)

    rsi = np.full(len(arr), np.nan)
    if len(gains) < period:
        return rsi

    avg_gain = np.mean(gains[:period])
    avg_loss = np.mean(losses[:period])

    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

        rs = avg_gain / avg_loss if avg_loss != 0 else np.inf
        idx = i + 1
        rsi[idx] = 100 - (100 / (1 + rs))

    rs0 = avg_gain / avg_loss if avg_loss != 0 else np.inf
    rsi[period] = 100 - (100 / (1 + rs0))

    return rsi


def _calc_macd(closes, fast=12, slow=26, signal=9):
    arr = np.array(closes, dtype=float)
    if len(arr) < slow:
        empty = np.full(len(arr), np.nan)
        return empty, empty, empty

    ema_fast = _calc_ema(arr, fast)
    ema_slow = _calc_ema(arr, slow)

    macd_line = np.full(len(arr), np.nan)
    macd_line[slow - 1:] = ema_fast[slow - 1:] - ema_slow[slow - 1:]

    valid_macd = macd_line[slow - 1:]
    sig_arr = _calc_ema(valid_macd, signal)
    signal_line = np.full(len(arr), np.nan)
    signal_line[slow - 1:] = sig_arr

    histogram = np.full(len(arr), np.nan)
    histogram[slow - 1:] = macd_line[slow - 1:] - signal_line[slow - 1:]

    return macd_line, signal_line, histogram


PERIOD_INTERVAL_MAP = {
    "1d":  "5m",
    "5d":  "15m",
    "1mo": "1d",
    "3mo": "1d",
    "6mo": "1wk",
    "1y":  "1wk",
}

INTRADAY_INTERVALS = {"5m", "15m"}


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/quote")
def get_quote():
    symbols_param = request.args.get("symbols", "")
    symbols = [s.strip().upper() for s in symbols_param.split(",") if s.strip()]
    if not symbols:
        return jsonify({"error": "No symbols provided"}), 400

    result = {}
    for sym in symbols:
        try:
            ticker = yf.Ticker(sym)
            fi = ticker.fast_info
            price = fi.last_price
            if price is None:
                result[sym] = {"error": "No price data (market may be closed)"}
                continue
            prev_close = fi.previous_close
            change_pct = (
                (price - prev_close) / prev_close * 100 if prev_close else 0
            )
            try:
                name = ticker.info.get("shortName", sym)
            except Exception:
                name = sym
            market_cap = None
            try:
                mc = fi.market_cap
                if mc is not None:
                    market_cap = float(mc)
            except Exception:
                pass
            result[sym] = {
                "price": round(price, 2),
                "change_pct": round(change_pct, 2),
                "name": name,
                "market_cap": market_cap,
            }
        except Exception as e:
            result[sym] = {"error": str(e)}

    return jsonify(result)


@app.route("/api/chart/<symbol>")
def get_chart(symbol):
    symbol = symbol.upper()
    period = request.args.get("period", "1mo")
    if period not in PERIOD_INTERVAL_MAP:
        period = "1mo"
    interval = PERIOD_INTERVAL_MAP[period]

    try:
        ticker = yf.Ticker(symbol)
        hist = ticker.history(period=period, interval=interval)
        if hist.empty:
            return jsonify({"error": "No data"}), 404
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    is_intraday = interval in INTRADAY_INTERVALS

    def fmt_time(ts):
        if is_intraday:
            return int(ts.timestamp())
        return ts.strftime("%Y-%m-%d")

    times = [fmt_time(ts) for ts in hist.index]
    closes = hist["Close"].tolist()
    n = len(closes)

    candles = []
    for i, ts in enumerate(hist.index):
        candles.append({
            "time": fmt_time(ts),
            "open":   round(float(hist["Open"].iloc[i]), 4),
            "high":   round(float(hist["High"].iloc[i]), 4),
            "low":    round(float(hist["Low"].iloc[i]), 4),
            "close":  round(float(closes[i]), 4),
            "volume": int(hist["Volume"].iloc[i]),
        })

    ma20_raw = _calc_sma(closes, 20)
    ma20_offset = max(0, n - len(ma20_raw))
    ma20 = [{"time": times[ma20_offset + i], "value": round(float(v), 4)}
            for i, v in enumerate(ma20_raw)]

    ma50_raw = _calc_sma(closes, 50)
    ma50_offset = max(0, n - len(ma50_raw))
    ma50 = [{"time": times[ma50_offset + i], "value": round(float(v), 4)}
            for i, v in enumerate(ma50_raw)]

    rsi_arr = _calc_rsi(closes, 14)
    rsi = []
    for i, v in enumerate(rsi_arr):
        if not np.isnan(v):
            rsi.append({"time": times[i], "value": round(float(v), 2)})

    macd_line, signal_line, histogram = _calc_macd(closes)
    macd_out, sig_out, hist_out = [], [], []
    for i in range(n):
        if not np.isnan(macd_line[i]):
            macd_out.append({"time": times[i], "value": round(float(macd_line[i]), 4)})
            sig_out.append({"time": times[i], "value": round(float(signal_line[i]), 4)})
            hist_out.append({"time": times[i], "value": round(float(histogram[i]), 4)})

    return jsonify({
        "candles": candles, "ma20": ma20, "ma50": ma50, "rsi": rsi,
        "macd": {"macd": macd_out, "signal": sig_out, "histogram": hist_out},
    })


@app.route("/api/alerts", methods=["GET"])
def get_alerts():
    with alerts_lock:
        return jsonify(list(alerts))


@app.route("/api/alerts", methods=["POST"])
def create_alert():
    data = request.get_json(silent=True) or {}
    symbol = data.get("symbol", "").strip().upper()
    alert_type = data.get("type", "price")
    if not symbol:
        return jsonify({"error": "Symbol required"}), 400
    alert = {
        "id": str(uuid.uuid4()), "symbol": symbol, "type": alert_type,
        "status": "active", "created_at": datetime.utcnow().isoformat(),
    }
    if alert_type == "price":
        direction = data.get("direction", "")
        try:
            target_price = float(data.get("target_price", 0))
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid target_price"}), 400
        if target_price <= 0 or direction not in ("above", "below"):
            return jsonify({"error": "Invalid input"}), 400
        alert["target_price"] = target_price
        alert["direction"] = direction
    elif alert_type == "percent":
        direction = data.get("direction", "")
        try:
            percent = float(data.get("percent", 0))
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid percent"}), 400
        if percent <= 0 or direction not in ("above", "below"):
            return jsonify({"error": "Invalid input"}), 400
        try:
            fi = yf.Ticker(symbol).fast_info
            baseline = fi.last_price
            if baseline is None:
                return jsonify({"error": "Cannot fetch current price for baseline"}), 400
        except Exception as e:
            return jsonify({"error": f"Price fetch failed: {e}"}), 400
        alert["percent"] = percent
        alert["direction"] = direction
        alert["baseline_price"] = round(float(baseline), 4)
    elif alert_type in ("rsi_above", "rsi_below"):
        try:
            rsi_threshold = float(data.get("rsi_threshold", 70 if alert_type == "rsi_above" else 30))
        except (TypeError, ValueError):
            return jsonify({"error": "Invalid rsi_threshold"}), 400
        alert["rsi_threshold"] = rsi_threshold
    elif alert_type in ("ma_cross_above", "ma_cross_below"):
        pass
    else:
        return jsonify({"error": f"Unknown alert type: {alert_type}"}), 400
    with alerts_lock:
        alerts.append(alert)
    return jsonify(alert), 201


@app.route("/api/alerts/<alert_id>", methods=["DELETE"])
def delete_alert(alert_id):
    with alerts_lock:
        idx = next((i for i, a in enumerate(alerts) if a["id"] == alert_id), None)
        if idx is None:
            return jsonify({"error": "Not found"}), 404
        alerts.pop(idx)
    return "", 204


@app.route("/api/config", methods=["GET"])
def get_config():
    with config_lock:
        return jsonify({"ntfy_topic": config["ntfy_topic"]})


@app.route("/api/config", methods=["POST"])
def update_config():
    data = request.get_json(silent=True) or {}
    topic = data.get("ntfy_topic", "").strip()
    with config_lock:
        config["ntfy_topic"] = topic
    return jsonify({"ntfy_topic": topic})


# ── Portfolio ───────────────────────────────────────────────────────────────────

@app.route("/api/portfolio", methods=["GET"])
def get_portfolio():
    with portfolio_lock:
        positions = dict(portfolio)
    if not positions:
        return jsonify({"positions": [], "summary": {
            "total_cost": 0, "total_value": 0, "total_pnl": 0, "total_pnl_pct": 0,
        }})
    result_positions = []
    total_cost = total_value = 0.0
    for sym, pos in positions.items():
        try:
            current_price = float(yf.Ticker(sym).fast_info.last_price or 0)
        except Exception:
            current_price = 0.0
        shares, avg_cost = pos["shares"], pos["avg_cost"]
        cost_basis = shares * avg_cost
        current_val = shares * current_price
        pnl = current_val - cost_basis
        pnl_pct = (pnl / cost_basis * 100) if cost_basis else 0.0
        total_cost += cost_basis
        total_value += current_val
        result_positions.append({
            "symbol": sym, "name": pos.get("name", sym), "shares": shares,
            "avg_cost": round(avg_cost, 4), "current_price": round(current_price, 2),
            "current_value": round(current_val, 2), "pnl": round(pnl, 2), "pnl_pct": round(pnl_pct, 2),
        })
    total_pnl = total_value - total_cost
    total_pnl_pct = (total_pnl / total_cost * 100) if total_cost else 0.0
    return jsonify({"positions": result_positions, "summary": {
        "total_cost": round(total_cost, 2), "total_value": round(total_value, 2),
        "total_pnl": round(total_pnl, 2), "total_pnl_pct": round(total_pnl_pct, 2),
    }})


@app.route("/api/portfolio", methods=["POST"])
def add_position():
    data = request.get_json(silent=True) or {}
    symbol = data.get("symbol", "").strip().upper()
    try:
        shares = float(data.get("shares", 0))
        avg_cost = float(data.get("avg_cost", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid shares or avg_cost"}), 400
    if not symbol or shares <= 0 or avg_cost <= 0:
        return jsonify({"error": "Invalid input"}), 400
    try:
        ticker = yf.Ticker(symbol)
        price = ticker.fast_info.last_price
        if price is None:
            return jsonify({"error": f"Cannot validate symbol: {symbol}"}), 400
        try:
            name = ticker.info.get("shortName", symbol)
        except Exception:
            name = symbol
    except Exception as e:
        return jsonify({"error": str(e)}), 400
    with portfolio_lock:
        if symbol in portfolio:
            existing = portfolio[symbol]
            total_shares = existing["shares"] + shares
            new_avg = (existing["shares"] * existing["avg_cost"] + shares * avg_cost) / total_shares
            portfolio[symbol] = {"shares": total_shares, "avg_cost": new_avg, "name": name}
        else:
            portfolio[symbol] = {"shares": shares, "avg_cost": avg_cost, "name": name}
    return jsonify({"symbol": symbol, "shares": shares, "avg_cost": avg_cost}), 201


@app.route("/api/portfolio/<symbol>", methods=["DELETE"])
def remove_position(symbol):
    symbol = symbol.upper()
    with portfolio_lock:
        if symbol not in portfolio:
            return jsonify({"error": "Not found"}), 404
        del portfolio[symbol]
    return "", 204


# ── News & Events ────────────────────────────────────────────────────────────────

def _parse_symbols(args_str):
    return [s.strip().upper() for s in args_str.split(",") if s.strip()]


def _parse_news_item(item, symbol):
    if "content" in item:
        c = item["content"]
        title = c.get("title", "")
        publisher = (c.get("provider") or {}).get("displayName", "")
        link = (c.get("canonicalUrl") or {}).get("url", "") or (c.get("clickThroughUrl") or {}).get("url", "")
        pub_date = c.get("pubDate", "")
        try:
            dt = datetime.fromisoformat(pub_date.replace("Z", "+00:00"))
            published_at = int(dt.timestamp())
        except Exception:
            published_at = 0
        thumb = None
        tn = c.get("thumbnail") or {}
        for res in tn.get("resolutions", []):
            if res.get("url"):
                thumb = res["url"]
                break
        if not thumb and tn.get("originalUrl"):
            thumb = tn["originalUrl"]
    else:
        title = item.get("title", "")
        publisher = item.get("publisher", "")
        link = item.get("link", "")
        published_at = item.get("providerPublishTime", 0)
        thumb = None
        tn = item.get("thumbnail") or {}
        for res in tn.get("resolutions", []):
            if res.get("url"):
                thumb = res["url"]
                break
    if not title:
        return None
    return {"symbol": symbol, "title": title, "publisher": publisher,
            "link": link, "published_at": published_at, "thumbnail": thumb}


@app.route("/api/news")
def get_news():
    symbols = _parse_symbols(request.args.get("symbols", ""))
    if not symbols:
        return jsonify([])
    all_news = []
    for symbol in symbols[:15]:
        try:
            for item in (yf.Ticker(symbol).news or [])[:6]:
                parsed = _parse_news_item(item, symbol)
                if parsed:
                    all_news.append(parsed)
        except Exception:
            pass
    all_news.sort(key=lambda x: x["published_at"], reverse=True)
    return jsonify(all_news)


@app.route("/api/debug/news/<symbol>")
def debug_news(symbol):
    ticker = yf.Ticker(symbol.upper())
    items = ticker.news or []
    return jsonify({"count": len(items), "first": items[0] if items else None})


@app.route("/api/earnings")
def get_earnings():
    symbols = _parse_symbols(request.args.get("symbols", ""))
    results = []
    for symbol in symbols[:15]:
        try:
            ticker = yf.Ticker(symbol)
            cal = ticker.calendar
            if not cal:
                continue
            dates = cal.get("Earnings Date", [])
            if not dates:
                continue
            name = ticker.info.get("shortName", symbol)
            eps_list = cal.get("EPS Estimate", [])
            rev_list = cal.get("Revenue Estimate", [])
            results.append({
                "symbol": symbol, "name": name,
                "earnings_date": dates[0].isoformat() if dates else None,
                "eps_estimate": float(eps_list[0]) if eps_list and eps_list[0] is not None else None,
                "revenue_estimate": float(rev_list[0]) if rev_list and rev_list[0] is not None else None,
            })
        except Exception:
            pass
    results.sort(key=lambda x: x["earnings_date"] or "9999")
    return jsonify(results)


@app.route("/api/analyst")
def get_analyst():
    symbols = _parse_symbols(request.args.get("symbols", ""))
    results = []
    cutoff = datetime.now() - timedelta(days=90)
    for symbol in symbols[:15]:
        try:
            ticker = yf.Ticker(symbol)
            df = ticker.upgrades_downgrades
            if df is None or df.empty:
                continue
            recent = df[df.index >= cutoff].head(8)
            for date, row in recent.iterrows():
                results.append({
                    "symbol": symbol, "date": date.strftime("%Y-%m-%d"),
                    "firm": str(row.get("Firm", "")), "from_grade": str(row.get("FromGrade", "")),
                    "to_grade": str(row.get("ToGrade", "")), "action": str(row.get("Action", "")),
                })
        except Exception:
            pass
    results.sort(key=lambda x: x["date"], reverse=True)
    return jsonify(results[:60])


@app.route("/api/insider")
def get_insider():
    symbols = _parse_symbols(request.args.get("symbols", ""))
    results = []
    for symbol in symbols[:10]:
        try:
            ticker = yf.Ticker(symbol)
            df = ticker.insider_transactions
            if df is None or df.empty:
                continue
            for _, row in df.head(8).iterrows():
                shares = row.get("Shares")
                value = row.get("Value")
                results.append({
                    "symbol": symbol, "insider": str(row.get("Insider Trading", "")),
                    "position": str(row.get("Position", "")), "date": str(row.get("Start Date", "")),
                    "shares": int(shares) if shares is not None and str(shares) != 'nan' else None,
                    "value": float(value) if value is not None and str(value) != 'nan' else None,
                    "text": str(row.get("Text", "")),
                })
        except Exception:
            pass
    return jsonify(results[:50])


@app.route("/api/options-activity")
def get_options_activity():
    symbols = _parse_symbols(request.args.get("symbols", ""))
    results = []
    for symbol in symbols[:5]:
        try:
            ticker = yf.Ticker(symbol)
            expirations = ticker.options
            if not expirations:
                continue
            for expiry in expirations[:2]:
                chain = ticker.option_chain(expiry)
                for opt_type, df in [("CALL", chain.calls), ("PUT", chain.puts)]:
                    df = df.copy()
                    df = df[df["volume"] > 50]
                    oi = df["openInterest"].replace(0, 1)
                    df["ratio"] = df["volume"] / oi
                    unusual = df[df["ratio"] > 1.5].nlargest(3, "volume")
                    for _, row in unusual.iterrows():
                        results.append({
                            "symbol": symbol, "type": opt_type,
                            "strike": float(row["strike"]), "expiry": expiry,
                            "volume": int(row["volume"]), "open_interest": int(row["openInterest"]),
                            "vol_oi_ratio": round(float(row["ratio"]), 1),
                            "last_price": float(row["lastPrice"]),
                            "implied_volatility": round(float(row.get("impliedVolatility", 0)) * 100, 1),
                        })
        except Exception:
            pass
    results.sort(key=lambda x: x["volume"], reverse=True)
    return jsonify(results[:30])


# ── Startup ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    from monitor import start_monitor
    start_monitor(alerts, alerts_lock, config, config_lock)
    print("Stock-Ping running at http://localhost:5000")
    app.run(debug=False, port=5000, use_reloader=False)
