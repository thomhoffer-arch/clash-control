"""CLI entry point for clashcontrol-engine."""
import argparse
import os
import sys


def main():
    parser = argparse.ArgumentParser(
        prog='clashcontrol-engine',
        description='Local clash detection server for ClashControl',
    )
    parser.add_argument(
        '--port', type=int,
        default=int(os.environ.get('CC_ENGINE_PORT', 19800)),
        help='HTTP port (default: 19800, WebSocket on PORT+1)',
    )
    parser.add_argument(
        '--host', type=str,
        default=os.environ.get('CC_ENGINE_HOST', 'localhost'),
        help='Bind address (default: localhost)',
    )

    args = parser.parse_args()

    try:
        from .server import run_server
        run_server(host=args.host, port=args.port)
    except KeyboardInterrupt:
        sys.exit(0)


if __name__ == '__main__':
    main()
