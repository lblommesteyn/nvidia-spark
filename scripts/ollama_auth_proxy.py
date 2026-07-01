#!/usr/bin/env python3
"""Bearer-auth reverse proxy in front of local Ollama's OpenAI-compatible /v1 API.

Ollama has no built-in API keys. This listens on a public port and forwards to
Ollama on localhost, requiring `Authorization: Bearer <key>` when NEMOTRON_API_KEY
(or FORECAST_API_KEY) is set — the same header Toronto Monitor already sends.

Env:
  NEMOTRON_API_KEY / FORECAST_API_KEY  required shared secret
  OLLAMA_UPSTREAM                      default http://127.0.0.1:11434
  PROXY_BIND                           default 0.0.0.0
  PROXY_PORT                           default 11435
"""
from __future__ import annotations

import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

API_KEY = os.environ.get("NEMOTRON_API_KEY") or os.environ.get("FORECAST_API_KEY")
OLLAMA = os.environ.get("OLLAMA_UPSTREAM", "http://127.0.0.1:11434").rstrip("/")
LISTEN_HOST = os.environ.get("PROXY_BIND", "0.0.0.0")
LISTEN_PORT = int(os.environ.get("PROXY_PORT", "11435"))
HOP_BY_HOP = frozenset(
    ("connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
     "te", "trailers", "transfer-encoding", "upgrade"),
)


class ProxyHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _authorized(self) -> bool:
        if not API_KEY:
            return True
        return self.headers.get("Authorization", "") == f"Bearer {API_KEY}"

    def _reject(self, code: int, body: bytes) -> None:
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _proxy(self) -> None:
        if not self._authorized():
            self._reject(401, b'{"error":"unauthorized"}')
            return

        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else None
        url = f"{OLLAMA}{self.path}"
        req = urllib.request.Request(url, data=body, method=self.command)
        for name, value in self.headers.items():
            if name.lower() == "host":
                continue
            req.add_header(name, value)

        try:
            with urllib.request.urlopen(req, timeout=600) as resp:
                self.send_response(resp.status)
                for key, value in resp.headers.items():
                    if key.lower() not in HOP_BY_HOP:
                        self.send_header(key, value)
                self.end_headers()
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except urllib.error.HTTPError as e:
            payload = e.read()
            self.send_response(e.code)
            self.send_header("Content-Type", e.headers.get("Content-Type", "application/json"))
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as e:
            msg = f'{{"error":"upstream failed: {e}"}}'.encode()
            self._reject(502, msg)

    def do_GET(self) -> None:
        self._proxy()

    def do_POST(self) -> None:
        self._proxy()

    def log_message(self, fmt: str, *args) -> None:
        print(f"[ollama-proxy] {self.address_string()} - {fmt % args}", flush=True)


def main() -> None:
    if not API_KEY:
        print("ERROR: set NEMOTRON_API_KEY or FORECAST_API_KEY before starting the proxy.",
              file=sys.stderr)
        sys.exit(1)
    print(f"[ollama-proxy] {LISTEN_HOST}:{LISTEN_PORT} → {OLLAMA} (Bearer auth required)",
          flush=True)
    server = ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), ProxyHandler)
    server.serve_forever()


if __name__ == "__main__":
    main()
