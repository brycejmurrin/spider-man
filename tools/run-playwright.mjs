#!/usr/bin/env node
// Launch Playwright on an automatically allocated port so independent npm test
// commands can run concurrently without sharing a web server or artifact paths.

import { spawn } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { extname, join, resolve as resolvePath, sep } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  // ES modules (vendor/rapier-0.19.3, vendor/three-0.184.0): Chromium enforces
  // a JavaScript MIME type for module scripts — octet-stream imports are
  // rejected outright, so .mjs must be mapped or dynamic import() fails.
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
};

function startStaticServer() {
  return new Promise((done, reject) => {
    const root = resolvePath(ROOT) + sep;
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url || "/", "http://127.0.0.1");
        const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
        const file = resolvePath(ROOT, `.${decodeURIComponent(pathname)}`);
        if (!file.startsWith(root)) {
          res.writeHead(403).end("forbidden");
          return;
        }
        const stat = statSync(file);
        if (!stat.isFile()) throw new Error("not a file");
        res.writeHead(200, {
          "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
          "Content-Length": stat.size,
          "Cache-Control": "no-store",
        });
        const stream = createReadStream(file);
        stream.on("error", () => res.destroy());
        res.on("error", () => stream.destroy());
        res.on("close", () => {
          if (!res.writableEnded) stream.destroy();
        });
        stream.pipe(res);
      } catch {
        res.writeHead(404).end("not found");
      }
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      done({ server, port: server.address().port });
    });
  });
}

const managed = process.env.SPIDEY_PORT ? null : await startStaticServer();
const port = process.env.SPIDEY_PORT || String(managed.port);
const cli = join(ROOT, "node_modules", ".bin", "playwright");
const child = spawn(cli, ["test", ...process.argv.slice(2)], {
  cwd: ROOT,
  env: {
    ...process.env,
    SPIDEY_PORT: port,
    ...(managed ? { SPIDEY_MANAGED_SERVER: "1" } : {}),
  },
  stdio: "inherit",
});

console.error(`[playwright] port=${port} pid=${child.pid}`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    try { child.kill(signal); } catch {}
  });
}

child.on("error", (error) => {
  console.error(`[playwright] failed to start: ${error.message}`);
  managed?.server.close();
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  if (signal) console.error(`[playwright] child exited on ${signal}`);
  managed?.server.close();
  process.exitCode = code ?? 1;
});
