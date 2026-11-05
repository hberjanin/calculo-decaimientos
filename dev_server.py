"""Restricted development server for the static PWA."""

from __future__ import annotations

import argparse
import posixpath
import socket
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit


DOCUMENT_CSP = (
    "default-src 'self'; "
    "base-uri 'none'; "
    "connect-src 'self'; "
    "font-src 'self' data:; "
    "form-action 'self'; "
    "frame-ancestors 'none'; "
    "frame-src 'none'; "
    "img-src 'self' data:; "
    "manifest-src 'self'; "
    "object-src 'none'; "
    "script-src 'self'; "
    # html2canvas crea estilos calculados en un documento aislado para rasterizar el informe.
    "style-src 'self' 'unsafe-inline'; "
    "worker-src 'self'"
)

PUBLIC_FILES = {
    "/",
    "/app.js",
    "/index.html",
    "/inventario_radiactivo.csv",
    "/isotopos.csv",
    "/manifest.webmanifest",
    "/precache-manifest.js",
    "/styles.css",
    "/sw.js",
}
PUBLIC_PREFIXES = ("/assets/", "/icons/", "/src/")


class PwaRequestHandler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".csv": "text/csv; charset=utf-8",
        ".webmanifest": "application/manifest+json; charset=utf-8",
    }

    def _request_path(self) -> str:
        raw_path = unquote(urlsplit(self.path).path)
        if "\\" in raw_path:
            return ""
        return posixpath.normpath(raw_path)

    def _is_public_path(self) -> bool:
        path = self._request_path()
        return path in PUBLIC_FILES or any(path.startswith(prefix) for prefix in PUBLIC_PREFIXES)

    def send_head(self):
        if not self._is_public_path():
            self.send_error(404, "File not found")
            return None
        return super().send_head()

    def list_directory(self, path):
        self.send_error(404, "Directory listing disabled")
        return None

    def end_headers(self) -> None:
        path = self._request_path()
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Permissions-Policy", "camera=(), geolocation=(), microphone=()")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("X-Content-Type-Options", "nosniff")
        if path in {"/", "/index.html"}:
            self.send_header("Content-Security-Policy", DOCUMENT_CSP)
            self.send_header("X-Frame-Options", "DENY")
        super().end_headers()


class IPv6ThreadingHTTPServer(ThreadingHTTPServer):
    address_family = socket.AF_INET6


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Serve the PWA for local development.")
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--directory", default=".")
    parser.add_argument("--port", type=int, default=8080)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    handler = partial(PwaRequestHandler, directory=args.directory)
    server_class = IPv6ThreadingHTTPServer if ":" in args.bind else ThreadingHTTPServer
    try:
        server = server_class((args.bind, args.port), handler)
    except OSError as error:
        print(f"No se puede iniciar el servidor en {args.bind}:{args.port}: {error}", file=sys.stderr)
        raise SystemExit(1) from error
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
