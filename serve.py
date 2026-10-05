#!/usr/bin/env python3
"""Static server with cross-origin isolation headers (COOP/COEP) so the WASM depth
fallback can use multiple threads. Usage: python3 serve.py [port]  ->  http://localhost:8000"""
import http.server, sys

class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'credentialless')
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

H.extensions_map.update({'.js': 'text/javascript', '.mjs': 'text/javascript', '.wasm': 'application/wasm'})
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
print(f'DotFX Builder on http://localhost:{port}  (Ctrl+C to stop)')
http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
