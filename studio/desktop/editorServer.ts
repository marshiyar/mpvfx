import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createStudioHttpService } from "../studio.http-service";

export interface RunningStudioServer {
  origin: string;
  close(): Promise<void>;
}

interface StartStudioServerOptions {
  staticDir: string;
  projectsDir: string;
  studioDir: string;
  version: string;
}

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function isWithin(root: string, candidate: string): boolean {
  const offset = relative(root, candidate);
  return (
    offset === "" ||
    (!isAbsolute(offset) && offset !== ".." && !offset.startsWith(`..${sep}`))
  );
}

const EDITOR_CONTENT_SECURITY_POLICY = [
  "default-src 'self' blob: data:",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "connect-src 'self'",
  "frame-src 'self' blob:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join("; ");

function serveStatic(staticDir: string, requestPath: string, response: import("node:http").ServerResponse) {
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    response.writeHead(400);
    response.end("bad path");
    return;
  }
  const relativePath = decodedPath === "/" ? "index.html" : decodedPath.replace(/^\/+/, "");
  let filePath = resolve(staticDir, relativePath);
  if (!isWithin(staticDir, filePath)) {
    response.writeHead(404);
    response.end("not found");
    return;
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    if (extname(relativePath)) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    filePath = resolve(staticDir, "index.html");
  }
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    response.writeHead(404);
    response.end("editor build not found");
    return;
  }
  const type = CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  response.writeHead(200, {
    "Content-Type": type,
    "Content-Length": statSync(filePath).size,
    "Content-Security-Policy": EDITOR_CONTENT_SECURITY_POLICY,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    // This is a local packaged application, not a CDN. Reusing a same-named
    // bundle after an in-place app update can resurrect deleted UI code.
    "Cache-Control": "no-store",
  });
  createReadStream(filePath).pipe(response);
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Desktop server has no TCP address");
  return address.port;
}

export async function startStudioServer(
  options: StartStudioServerOptions,
): Promise<RunningStudioServer> {
  const service = createStudioHttpService({
    projectsDir: options.projectsDir,
    version: options.version,
    adapterHost: {
      studioDir: options.studioDir,
      async loadModule<T>(specifier: string): Promise<T> {
        const moduleUrl = isAbsolute(specifier) ? pathToFileURL(specifier).href : specifier;
        return (await import(moduleUrl)) as T;
      },
    },
  });
  let trustedOrigin = "";
  const server = createServer(async (request, response) => {
    const requestOrigin = request.headers.origin;
    const trustedHost = trustedOrigin ? new URL(trustedOrigin).host : "";
    if (
      (trustedHost && request.headers.host !== trustedHost) ||
      (requestOrigin !== undefined && requestOrigin !== trustedOrigin)
    ) {
      response.writeHead(403, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      response.end(JSON.stringify({ error: "Untrusted desktop request origin" }));
      return;
    }
    if (await service.handle(request, response)) return;
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    serveStatic(options.staticDir, requestUrl.pathname, response);
  });
  try {
    const port = await listen(server);
    trustedOrigin = `http://127.0.0.1:${port}`;
    let closePromise: Promise<void> | null = null;
    return {
      origin: trustedOrigin,
      close() {
        if (closePromise) return closePromise;
        closePromise = (async () => {
          await service.close();
          await new Promise<void>((resolvePromise, reject) => {
            server.close((error) => (error ? reject(error) : resolvePromise()));
            server.closeAllConnections?.();
          });
        })();
        return closePromise;
      },
    };
  } catch (error) {
    await service.close();
    throw error;
  }
}
