#!/usr/bin/env python3
"""
Wrapper for the `mcp-vultr` PyPI package (rsp2k/mcp-vultr).

The package's own structlog setup falls back to structlog's default
PrintLoggerFactory, which writes to stdout. Every log line it emits -
including one on every single tool call and API request, not just at
startup - corrupts the stdio JSON-RPC stream the MCP protocol depends on,
so the client (OpenClaw) silently sees 0 tools/resources/prompts even
though the process runs fine.

This must run before `mcp_vultr` is imported, since structlog locks in
its logger_factory/wrapper_class on first configure() call and
cache_logger_on_first_use=True in the package's own (unused-by-default)
config path means a later reconfigure wouldn't reliably override an
already-cached logger.
"""
import sys
import logging

import structlog

logging.basicConfig(stream=sys.stderr, level=logging.WARNING)
structlog.configure(
    logger_factory=structlog.PrintLoggerFactory(file=sys.stderr),
    wrapper_class=structlog.make_filtering_bound_logger(logging.WARNING),
    cache_logger_on_first_use=True,
)

from mcp_vultr.fastmcp_server import run_server  # noqa: E402

if __name__ == "__main__":
    sys.argv[0] = sys.argv[0].removesuffix(".exe")
    sys.exit(run_server())
