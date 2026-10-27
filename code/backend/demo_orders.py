import json
import logging
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit


class OrdersHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        match = re.fullmatch(r"/customers/(CUST-[0-9]{4})/orders", self.path)
        if self.path == "/health":
            payload, status = {"service": "fastflow-demo-orders"}, 200
        elif match:
            customer_id = match[1]
            payload, status = (
                {
                    "customer_id": customer_id,
                    "orders": []
                    if customer_id == "CUST-0000"
                    else [
                        {"id": "ORD-1001", "status": "paid"},
                        {"id": "ORD-1002", "status": "shipped"},
                        {"id": "ORD-1003", "status": "pending"},
                    ],
                },
                200,
            )
        else:
            payload, status = {"error": "not found"}, 404
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
