import os
import uuid
import threading
from datetime import datetime

import yfinance as yf
from flask import Flask, request, jsonify, render_template
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)

alerts = []
alerts_lock = threading.Lock()

config = {"ntfy_topic": os.getenv("NTFY_TOPIC", "")}
config_lock = threading.Lock()


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
            # shortName only fetched here (on watchlist add); client caches it
            try:
                name = ticker.info.get("shortName", sym)
            except Exception:
                name = sym
            result[sym] = {
                "price": round(price, 2),
                "change_pct": round(change_pct, 2),
                "name": name,
            }
        except Exception as e:
            result[sym] = {"error": str(e)}

    return jsonify(result)


@app.route("/api/alerts", methods=["GET"])
def get_alerts():
    with alerts_lock:
        return jsonify(list(alerts))


@app.route("/api/alerts", methods=["POST"])
def create_alert():
    data = request.get_json(silent=True) or {}
    symbol = data.get("symbol", "").strip().upper()
    direction = data.get("direction", "")

    try:
        target_price = float(data.get("target_price", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "Invalid target_price"}), 400

    if not symbol or target_price <= 0 or direction not in ("above", "below"):
        return jsonify({"error": "Invalid input"}), 400

    alert = {
        "id": str(uuid.uuid4()),
        "symbol": symbol,
        "target_price": target_price,
        "direction": direction,
        "status": "active",
        "created_at": datetime.utcnow().isoformat(),
    }
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


@app.route("/api/news")
def get_news():
    symbols_param = request.args.get("symbols", "")
    symbols = [s.strip().upper() for s in symbols_param.split(",") if s.strip()]
    if not symbols:
        return jsonify([])

    articles = []
    seen = set()
    for sym in symbols[:10]:  # cap at 10 symbols to avoid slow responses
        try:
            news = yf.Ticker(sym).news or []
            for item in news[:8]:
                # yfinance >=0.2.40 may nest content under a 'content' key
                if "content" in item and isinstance(item["content"], dict):
                    item = item["content"]
                link = item.get("canonicalUrl", {}).get("url") or item.get("link", "")
                title = item.get("title", "")
                publisher = (
                    item.get("provider", {}).get("displayName")
                    or item.get("publisher", "")
                )
                pub_time = item.get("pubDate") or item.get("providerPublishTime")
                if not title or not link or link in seen:
                    continue
                seen.add(link)
                articles.append({
                    "symbol": sym,
                    "title": title,
                    "publisher": publisher,
                    "link": link,
                    "published_at": pub_time,
                })
        except Exception:
            continue

    # sort newest-first when timestamps are integers (Unix) or ISO strings
    def sort_key(a):
        t = a.get("published_at")
        if t is None:
            return 0
        if isinstance(t, (int, float)):
            return t
        try:
            from datetime import timezone
            return datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp()
        except Exception:
            return 0

    articles.sort(key=sort_key, reverse=True)
    return jsonify(articles[:30])


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


# ── Startup ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    from monitor import start_monitor
    start_monitor(alerts, alerts_lock, config, config_lock)
    print("Stock-Ping running at http://localhost:5000")
    app.run(debug=False, port=5000, use_reloader=False)
