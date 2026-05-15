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
