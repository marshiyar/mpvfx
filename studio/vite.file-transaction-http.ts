import { realpath } from "node:fs/promises";
import {
  createDurableFileTransactionStore,
  type DurableFileTransactionInput,
  type DurableFileTransactionStore,
} from "./vite.file-transaction";

export interface DurableFileTransactionResolvedProject {
  id?: string;
  dir: string;
}

export interface DurableFileTransactionHttpRequest {
  method?: string;
  pathname: string;
  body?: string | Uint8Array;
}

export interface DurableFileTransactionHttpControllerOptions {
  resolveProject: (
    projectId: string,
  ) =>
    | DurableFileTransactionResolvedProject
    | null
    | Promise<DurableFileTransactionResolvedProject | null>;
  createStore?: (projectRoot: string) => DurableFileTransactionStore;
}

export interface DurableFileTransactionHttpController {
  /** Returns a JSON failure response, or null when the request may continue. */
  ensureRecoveredForProjectPath(pathname: string): Promise<Response | null>;
  /** Handles only `/projects/:id/file-transactions/**`; unrelated routes return null. */
  handle(request: DurableFileTransactionHttpRequest): Promise<Response | null>;
}

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const JSON_HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json(body, { status, headers: { ...JSON_HEADERS, ...headers } });
}

function errorResponse(error: unknown): Response {
  if (error instanceof HttpFailure) return json({ error: error.message }, error.status);
  const message = error instanceof Error ? error.message : String(error);
  if (/changed before commit|already belongs to a different payload/i.test(message)) {
    return json({ error: "Transaction conflicts with newer project content" }, 409);
  }
  if (
    /unsafe|reserved|requires|must be|requires exact|duplicate transaction target|unexpected fields|non-empty|at least one target/i.test(
      message,
    )
  ) {
    return json({ error: message }, 400);
  }
  return json({ error: "Durable transaction service failed" }, 500);
}

function decodeSafeSegment(raw: string, kind: "project" | "transaction"): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new HttpFailure(400, `Malformed ${kind} identifier encoding`);
  }
  if (
    decoded.length === 0 ||
    decoded.length > 512 ||
    decoded === "." ||
    decoded === ".." ||
    decoded.includes("/") ||
    decoded.includes("\\") ||
    /[\0-\x1f\x7f]/.test(decoded)
  ) {
    throw new HttpFailure(400, `Unsafe ${kind} identifier`);
  }
  return decoded;
}

function rawProjectSegment(pathname: string): string | null {
  if (!pathname.startsWith("/projects/")) return null;
  return pathname.slice("/projects/".length).split("/", 1)[0] ?? "";
}

function projectIdFromPath(pathname: string): string | null {
  const raw = rawProjectSegment(pathname);
  return raw === null ? null : decodeSafeSegment(raw, "project");
}

function bodyText(body: string | Uint8Array | undefined): string {
  if (body === undefined) throw new HttpFailure(400, "A JSON transaction body is required");
  if (typeof body === "string") return body;
  return new TextDecoder().decode(body);
}

function parseCommitBody(body: string | Uint8Array | undefined): DurableFileTransactionInput {
  const source = bodyText(body);
  if (!source.trim()) throw new HttpFailure(400, "A JSON transaction body is required");
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new HttpFailure(400, "Transaction body must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpFailure(400, "Transaction body must be a JSON object");
  }
  return value as DurableFileTransactionInput;
}

function transactionRoute(pathname: string):
  | { projectId: string; action: "commit" | "pending-history" }
  | { projectId: string; action: "status" | "acknowledge"; transactionId: string }
  | { projectId: string; action: "unknown" }
  | null {
  const pieces = pathname.split("/");
  if (pieces.length < 4 || pieces[1] !== "projects" || pieces[3] !== "file-transactions") {
    return null;
  }
  const projectId = decodeSafeSegment(pieces[2] ?? "", "project");
  if (pieces.length === 5 && pieces[4] === "commit") return { projectId, action: "commit" };
  if (pieces.length === 5 && pieces[4] === "pending-history") {
    return { projectId, action: "pending-history" };
  }
  if (pieces.length === 5 && pieces[4]) {
    return {
      projectId,
      action: "status",
      transactionId: decodeSafeSegment(pieces[4], "transaction"),
    };
  }
  if (pieces.length === 6 && pieces[4] && pieces[5] === "acknowledge") {
    return {
      projectId,
      action: "acknowledge",
      transactionId: decodeSafeSegment(pieces[4], "transaction"),
    };
  }
  return { projectId, action: "unknown" };
}

export function createDurableFileTransactionHttpController(
  options: DurableFileTransactionHttpControllerOptions,
): DurableFileTransactionHttpController {
  const stores = new Map<string, DurableFileTransactionStore>();
  const recovered = new Map<string, Promise<void>>();
  const makeStore = options.createStore ?? ((root) => createDurableFileTransactionStore({ projectRoot: root }));

  const storeForProject = async (
    projectId: string,
  ): Promise<{ root: string; store: DurableFileTransactionStore }> => {
    const project = await options.resolveProject(projectId);
    if (!project) throw new HttpFailure(404, "Project not found");
    let root: string;
    try {
      root = await realpath(project.dir);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : null;
      if (code === "ENOENT") throw new HttpFailure(404, "Project not found");
      throw error;
    }
    let store = stores.get(root);
    if (!store) {
      store = makeStore(root);
      stores.set(root, store);
    }
    let recovery = recovered.get(root);
    if (!recovery) {
      recovery = store.recover().then((results) => {
        if (results.some((result) => result.action === "corrupt")) {
          throw new HttpFailure(500, "Project transaction recovery found corrupt journal data");
        }
      });
      recovered.set(root, recovery);
      void recovery.catch(() => {
        if (recovered.get(root) === recovery) recovered.delete(root);
      });
    }
    await recovery;
    return { root, store };
  };

  const ensureRecoveredForProjectPath = async (pathname: string): Promise<Response | null> => {
    try {
      const projectId = projectIdFromPath(pathname);
      if (projectId === null) return null;
      await storeForProject(projectId);
      return null;
    } catch (error) {
      return errorResponse(error);
    }
  };

  const handle = async (request: DurableFileTransactionHttpRequest): Promise<Response | null> => {
    let route: ReturnType<typeof transactionRoute>;
    try {
      route = transactionRoute(request.pathname);
    } catch (error) {
      // A malformed project segment is ours when the transaction namespace is present.
      if (request.pathname.split("/")[3] !== "file-transactions") return null;
      return errorResponse(error);
    }
    if (!route) return null;
    if (route.action === "unknown") return json({ error: "Transaction endpoint not found" }, 404);

    const method = (request.method ?? "GET").toUpperCase();
    const expectedMethod =
      route.action === "commit" || route.action === "acknowledge" ? "POST" : "GET";
    if (method !== expectedMethod) {
      return json({ error: "Method not allowed" }, 405, { Allow: expectedMethod });
    }

    try {
      const { store } = await storeForProject(route.projectId);
      if (route.action === "commit") {
        try {
          return json(await store.commit(parseCommitBody(request.body)));
        } catch (commitError) {
          // A process crash is recovered on the next start, but ordinary I/O or
          // injected failures happen while this server is still alive. Restore
          // PREPARED bytes before any later project read can observe half an edit.
          const recovery = await store.recover();
          if (recovery.some((result) => result.action === "corrupt")) {
            throw new HttpFailure(500, "Project transaction recovery found corrupt journal data");
          }
          throw commitError;
        }
      }
      if (route.action === "pending-history") {
        return json({ receipts: await store.listCommittedPendingHistory() });
      }
      if (route.action === "status") {
        const receipt = await store.status(route.transactionId);
        return receipt ? json(receipt) : json({ error: "Transaction not found" }, 404);
      }
      if (route.action === "acknowledge") {
        const acknowledged = await store.acknowledge(route.transactionId);
        return acknowledged ? json({ ok: true }) : json({ error: "Transaction not found" }, 404);
      }
      return json({ error: "Transaction endpoint not found" }, 404);
    } catch (error) {
      return errorResponse(error);
    }
  };

  return { ensureRecoveredForProjectPath, handle };
}
