import threading
import time
import requests
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


def _check_alerts(alerts, alerts_lock, config, config_lock):
    with alerts_lock:
        active = [a for a in alerts if a["status"] == "active"]

    if not active:
        return

    symbols = list({a["symbol"] for a in active})
    prices = {}
    for sym in symbols:
        try:
            fi = yf.Ticker(sym).fast_info
            price = fi.last_price
            prices[sym] = price if price is not None else None
        except Exception as e:
            print(f"[monitor] Price fetch failed for {sym}: {e}")
            prices[sym] = None

    triggered = []
    with alerts_lock:
        for alert in alerts:
            if alert["status"] != "active":
                continue
            price = prices.get(alert["symbol"])
            if price is None:
                continue
            hit = (
                alert["direction"] == "above" and price >= alert["target_price"]
            ) or (
                alert["direction"] == "below" and price <= alert["target_price"]
            )
            if hit:
                alert["status"] = "triggered"
                triggered.append((dict(alert), price))

    with config_lock:
        ntfy_topic = config.get("ntfy_topic", "")

    for alert_copy, price in triggered:
        _fire_notification(alert_copy, price, ntfy_topic)


def _fire_notification(alert, current_price, ntfy_topic):
    sym = alert["symbol"]
    target = alert["target_price"]
    direction = alert["direction"]
    msg = (
        f"{sym} is now ${current_price:.2f} "
        f"(your target: {direction} ${target:.2f})"
    )

    _notify_toast(sym, msg)
    _notify_sound()
    if ntfy_topic:
        _notify_ntfy(ntfy_topic, sym, msg)


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
