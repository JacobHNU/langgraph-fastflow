import json
import logging
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit


class OrdersHandler(BaseHTTPRequestHandler):
    @staticmethod
    def orders(customer_id, limit=100):
        return {
            "customer_id": customer_id,
            "orders": (
                []
                if customer_id == "CUST-0000"
                else [
                    {"id": "ORD-1001", "status": "paid"},
                    {"id": "ORD-1002", "status": "shipped"},
                    {"id": "ORD-1003", "status": "pending"},
                ]
            )[:limit],
        }

    def do_POST(self):
        parsed = urlsplit(self.path)
        try:
            size = int(self.headers.get("Content-Length", 0))
            if size <= 0 or size > 120000:
                raise ValueError
            body = json.loads(self.rfile.read(size))
            customer_id = body["customer_id"]
            limit = int(parse_qs(parsed.query).get("limit", [100])[0])
            if (
                parsed.path != "/orders/search"
                or not re.fullmatch(r"CUST-[0-9]{4}", customer_id)
                or not 1 <= limit <= 100
            ):
                raise ValueError
            self.send_json({"payload": self.orders(customer_id, limit), "source": "local-demo"}, 200)
        except (ValueError, KeyError, TypeError):
            self.send_json({"error": "invalid query"}, 400)

    def do_GET(self):
        match = re.fullmatch(r"/customers/(CUST-[0-9]{4})/orders", urlsplit(self.path).path)
        if self.path == "/health":
            payload, status = {"service": "fastflow-demo-orders"}, 200
        elif match:
            customer_id = match[1]
            payload, status = (
                self.orders(customer_id),
                200,
            )
        else:
            payload, status = {"error": "not found"}, 404
        self.send_json(payload, status)

    def send_json(self, payload, status):
        encoded = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *args):
        pass


def start_demo_orders(url):
    parsed = urlsplit(url)
    if parsed.hostname != "127.0.0.1" or parsed.path or parsed.scheme != "http":
        return None
    try:
        server = ThreadingHTTPServer(("127.0.0.1", parsed.port or 18765), OrdersHandler)
    except OSError:
        logging.getLogger(__name__).info("Order demo address is in use; leaving its existing service untouched")
        return None
    thread = threading.Thread(target=server.serve_forever, daemon=True, name="demo-orders-http")
    thread.start()
    return server
