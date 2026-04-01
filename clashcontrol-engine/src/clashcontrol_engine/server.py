"""
HTTP + WebSocket server for ClashControl local clash detection.

- HTTP on PORT (default 19800): GET /status, POST /detect, OPTIONS (CORS)
- WebSocket on PORT+1 (default 19801): progress updates during detection
"""
import asyncio
import json
import multiprocessing
import os
from http.server import HTTPServer, BaseHTTPRequestHandler
from threading import Thread

from . import __version__
from .engine import detect_clashes

PORT = int(os.environ.get('CC_ENGINE_PORT', 19800))
HOST = os.environ.get('CC_ENGINE_HOST', 'localhost')

_ws_clients = set()
_loop = None


class Handler(BaseHTTPRequestHandler):

    def do_GET(self):
        if self.path == '/status':
            self._json_response(200, {
                'status': 'ready',
                'version': __version__,
                'cores': multiprocessing.cpu_count(),
            })
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == '/detect':
            content_length = int(self.headers.get('Content-Length', 0))
            body = self.rfile.read(content_length)

            try:
                payload = json.loads(body)
            except (json.JSONDecodeError, ValueError) as e:
                self._json_response(400, {'error': f'Invalid JSON: {e}'})
                return

            try:
                def on_progress(done, total):
                    self._broadcast_ws({
                        'type': 'progress',
                        'done': done,
                        'total': total,
                        'pct': round(done / total * 100) if total else 0,
                    })

                result = detect_clashes(payload, on_progress=on_progress)
                self._json_response(200, result)

                self._broadcast_ws({
                    'type': 'complete',
                    'clashCount': result['stats']['clashCount'],
                    'duration_ms': result['stats']['duration_ms'],
                })

            except Exception as e:
                self._json_response(500, {'error': str(e)})
        else:
            self.send_response(404)
            self.end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self._cors_headers()
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def _json_response(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self._cors_headers()
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _cors_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')

    def _broadcast_ws(self, msg):
        if not _ws_clients or _loop is None:
            return
        text = json.dumps(msg)
        for ws in list(_ws_clients):
            try:
                asyncio.run_coroutine_threadsafe(ws.send(text), _loop)
            except Exception:
                pass

    def log_message(self, fmt, *args):
        print(f"[CC Engine] {args[0]}")


async def _ws_handler(websocket):
    _ws_clients.add(websocket)
    try:
        async for _ in websocket:
            pass  # Send-only channel
    finally:
        _ws_clients.discard(websocket)


def run_server(host=None, port=None):
    """Start the HTTP + WebSocket server."""
    global _loop

    host = host or HOST
    port = port or PORT
    ws_port = port + 1

    print(f"[CC Engine] ClashControl Local Engine v{__version__}")
    print(f"[CC Engine] HTTP  → http://{host}:{port}")
    print(f"[CC Engine] WS    → ws://{host}:{ws_port}")
    print(f"[CC Engine] Cores → {multiprocessing.cpu_count()}")
    print(f"[CC Engine] Ready for connections")

    # HTTP server in a daemon thread
    http_server = HTTPServer((host, port), Handler)
    http_thread = Thread(target=http_server.serve_forever, daemon=True)
    http_thread.start()

    # WebSocket server in asyncio event loop (main thread)
    _loop = asyncio.new_event_loop()
    asyncio.set_event_loop(_loop)

    try:
        import websockets
        ws_server = websockets.serve(_ws_handler, host, ws_port)
        _loop.run_until_complete(ws_server)
        _loop.run_forever()
    except ImportError:
        print("[CC Engine] websockets not installed — progress updates disabled")
        print("[CC Engine] Install with: pip install websockets")
        # Keep running with just HTTP
        try:
            http_thread.join()
        except KeyboardInterrupt:
            pass
    except KeyboardInterrupt:
        pass
    finally:
        print("\n[CC Engine] Shutting down")
        http_server.shutdown()
