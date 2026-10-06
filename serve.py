#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-only
# Copyright (C) 2026 Leo Kuroshita (@kurogedelic), Hügelton Instruments
"""A local server for working on the web pages: this folder, nothing cached (an edited module is what loads).

  serve.py [PORT]        default 8766; then open http://localhost:PORT/app/index.html?mock=1
"""
import http.server
import sys
from functools import partial
from pathlib import Path


class NoCache(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8766
    handler = partial(NoCache, directory=str(Path(__file__).resolve().parent))
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as srv:
        print(f"http://localhost:{port}/app/index.html?mock=1")
        srv.serve_forever()


if __name__ == "__main__":
    main()
