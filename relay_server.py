"""Screen Relay's web server: serves only the TV page and the remote, nothing else in this folder
(not the repo's history, the recorder or its recordings). Usage: python3 relay_server.py [port]"""
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

HERE = os.path.dirname(os.path.abspath(__file__))
SHARED = {"/": "index.html", "/index.html": "index.html", "/remote.html": "remote.html"}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def log_message(self, *args):
        pass

    def send_head(self):
        name = SHARED.get(urlparse(self.path).path)
        if not name:
            self.send_error(404)
            return None
        self.path = "/" + name
        return super().send_head()

    def list_directory(self, path):
        self.send_error(404)
        return None


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
