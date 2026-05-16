import threading
import time
import requests
import numpy as np
import yfinance as yf


def start_monitor(alerts, alerts_lock, config, config_lock):
    t = threading.Thread(
        target=_monitor_loop,
        args=(alerts, alerts_lock, config, config_lock),
        daemon=True,
    )
    t.start()


def _monitor_loop(alerts, alerts_lock, config, config_lock):
    time.sleep(60)  # let Flask finish starting before first poll
    while True:
        try:
            _check_alerts(alerts, alerts_lock, config, config_lock)
        except Exception as e:
            print(f"[monitor] Unexpected error: {e}")
        time.sleep(60)


# ── Indicator helpers ──────────────────────────────────────────────────────────

def _calc_rsi(closes, period=14):
    """RSI using Wilder's smoothing."""
    arr = np.array(closes, dtype=float)
    if len(arr) <= period:
        return None
    deltas = np.diff(arr)
    gains = np.where(deltas > 0, deltas, 0.0)
    losses = np.where(deltas < 0, -deltas, 0.0)

    avg_gain = np.mean(gains[:period])
    avg_loss = np.mean(losses[:period])

    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period

    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def _calc_ma(closes, period):
    """Simple moving average of last `period` values."""
    arr = np.array(closes, dtype=float)
    if len(arr) < period:
        return None
    return float(np.mean(arr[-period:]))


def _fetch_history_closes(symbol, period="30d", interval="1d"):
    hist = yf.Ticker(symbol).history(period=period, interval=interval)
    if hist.empty:
        return []
    return hist["Close"].tolist()


# ── Alert checking ─────────────────────────────────────────────────────────────

def _check_alerts(alerts, alerts_lock, config, config_lock):
    with alerts_lock:
        active = [a for a in alerts if a["status"] == "active"]

    if not active:
        return

    # Group by type to minimise API calls
    price_symbols = set()
    tech_symbols = set()
    for a in active:
        t = a.get("type", "price")
        if t in ("price", "percent"):
            price_symbols.add(a["symbol"])
        elif t in ("rsi_above", "rsi_below", "ma_cross_above", "ma_cross_below"):
            tech_symbols.add(a["symbol"])

    # Fetch spot prices
    prices = {}
    for sym in price_symbols:
        try:
            fi = yf.Ticker(sym).fast_info
            p = fi.last_price
            prices[sym] = float(p) if p is not None else None
        except Exception as e:
            print(f"[monitor] Price fetch failed for {sym}: {e}")
            prices[sym] = None

    # Fetch historical data for tech indicators (last 60 daily bars for MA50)
    hist_data = {}
    for sym in tech_symbols:
        try:
            closes = _fetch_history_closes(sym, period="60d", interval="1d")
            hist_data[sym] = closes
        except Exception as e:
            print(f"[monitor] History fetch failed for {sym}: {e}")
            hist_data[sym] = []

    triggered = []
    with alerts_lock:
        for alert in alerts:
            if alert["status"] != "active":
                continue

            sym = alert["symbol"]
            alert_type = alert.get("type", "price")
            hit = False
            msg = None

            try:
                if alert_type == "price":
                    price = prices.get(sym)
                    if price is None:
                        continue
                    direction = alert["direction"]
                    target = alert["target_price"]
                    hit = (direction == "above" and price >= target) or \
                          (direction == "below" and price <= target)
                    if hit:
                        dir_icon = "▲" if direction == "above" else "▼"
                        msg = (f"{sym} is now ${price:.2f} "
                               f"(target: {dir_icon} ${target:.2f})")

                elif alert_type == "percent":
                    price = prices.get(sym)
                    if price is None:
                        continue
                    baseline = alert["baseline_price"]
                    pct_change = (price - baseline) / baseline * 100
                    direction = alert["direction"]
                    threshold = alert["percent"]
                    if direction == "above":
                        hit = pct_change >= threshold
                    else:
                        hit = pct_change <= -threshold
                    if hit:
                        sign = "+" if pct_change >= 0 else ""
                        msg = (f"{sym} moved {sign}{pct_change:.1f}% "
                               f"(from ${baseline:.2f} to ${price:.2f})")

                elif alert_type in ("rsi_above", "rsi_below"):
                    closes = hist_data.get(sym, [])
                    if len(closes) < 16:
                        continue
                    rsi_val = _calc_rsi(closes, 14)
                    if rsi_val is None:
                        continue
                    threshold = alert["rsi_threshold"]
                    if alert_type == "rsi_above":
                        hit = rsi_val >= threshold
                        if hit:
                            msg = (f"{sym} RSI(14) = {rsi_val:.1f}, "
                                   f"exceeded threshold of {threshold}")
                    else:
                        hit = rsi_val <= threshold
                        if hit:
                            msg = (f"{sym} RSI(14) = {rsi_val:.1f}, "
                                   f"dropped below threshold of {threshold}")

                elif alert_type in ("ma_cross_above", "ma_cross_below"):
                    closes = hist_data.get(sym, [])
                    if len(closes) < 52:
                        continue
                    # Check last 2 data points for crossing
                    ma20_prev = _calc_ma(closes[:-1], 20)
                    ma50_prev = _calc_ma(closes[:-1], 50)
                    ma20_curr = _calc_ma(closes, 20)
                    ma50_curr = _calc_ma(closes, 50)
                    if None in (ma20_prev, ma50_prev, ma20_curr, ma50_curr):
                        continue
                    if alert_type == "ma_cross_above":
                        hit = (ma20_prev <= ma50_prev) and (ma20_curr > ma50_curr)
                        if hit:
                            msg = (f"{sym} MA20 (${ma20_curr:.2f}) crossed above "
                                   f"MA50 (${ma50_curr:.2f}) — bullish signal")
                    else:
                        hit = (ma20_prev >= ma50_prev) and (ma20_curr < ma50_curr)
                        if hit:
                            msg = (f"{sym} MA20 (${ma20_curr:.2f}) crossed below "
                                   f"MA50 (${ma50_curr:.2f}) — bearish signal")

            except Exception as e:
                print(f"[monitor] Error evaluating alert {alert['id']}: {e}")
                continue

            if hit and msg:
                alert["status"] = "triggered"
                triggered.append((dict(alert), msg))

    with config_lock:
        ntfy_topic = config.get("ntfy_topic", "")

    for alert_copy, msg in triggered:
        _fire_notification(alert_copy, msg, ntfy_topic)


def _fire_notification(alert, message, ntfy_topic):
    sym = alert["symbol"]
    _notify_toast(sym, message)
    _notify_sound()
    if ntfy_topic:
        _notify_ntfy(ntfy_topic, sym, message)


def _notify_toast(title, message):
    try:
        from plyer import notification
        notification.notify(
            title=f"Stock-Ping: {title}",
            message=message,
            app_name="Stock-Ping",
            timeout=10,
        )
    except Exception as e:
        print(f"[monitor] Toast failed: {e}")


def _notify_sound():
    try:
        import winsound
        winsound.MessageBeep(winsound.MB_ICONEXCLAMATION)
    except ImportError:
        pass  # not Windows
    except Exception as e:
        print(f"[monitor] Sound failed: {e}")


def _notify_ntfy(topic, title, message):
    try:
        requests.post(
            f"https://ntfy.sh/{topic}",
            data=message.encode("utf-8"),
            headers={
                "Title": f"Stock-Ping: {title}",
                "Priority": "high",
                "Tags": "bell,chart_with_upwards_trend",
            },
            timeout=10,
        )
    except Exception as e:
        print(f"[monitor] ntfy.sh failed: {e}")
