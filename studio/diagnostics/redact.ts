/** Shared by both transports. Never collect request bodies, input values or command arguments. */
const PRIVATE_KEY = /password|passwd|secret|token|authorization|cookie|credential|privatekey|apikey|^(?:email|emailaddress|username|hostname|serialnumber|machinename)$/i;
const CONTENT_KEY = /^(env|environment|args|argv|commandline|inputvalue|value|text|innertext|textcontent|html|outerhtml|body|requestbody|responsebody|clipboard|content|source|snapshot|filename|filepath|path|url|href|projectname|projectid|composition|assetname|assetid|selector|selselector|selid)$/i;

export function redactText(input: string): string {
  return input.slice(0, 8192)
    .replace(/-----BEGIN [\s\S]*?(?:-----END [^-]+-----|$)/g, "[redacted key]")
    .replace(/\b(?:https?|file|blob|data):[^\s<>"']+/gi, (url) => {
      const position = url.match(/:(\d+):(\d+)$/);
      const bundle = url.match(/\/assets\/((?:index|chunk)-[A-Za-z0-9_-]+\.js)/);
      if (bundle) return `[app]/${bundle[1]}${position ? `:${position[1]}:${position[2]}` : ""}`;
      return position ? `[url]:${position[1]}:${position[2]}` : "[url]";
    })
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.\-]+/gi, "[credential]")
    .replace(/\b(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s;,]+)/gi, "[credential]")
    .replace(/\b[A-Z]:[\\/][^\n;"'<>]*/gi, "[path]")
    .replace(/\\\\[^\n;"'<>]+/g, "[path]")
    .replace(/\/(?:Users|home|tmp|var|private|Applications|opt|usr|mnt|media|app|snap|workspace|builds)\/[^\n;"'<>]*/g, "[path]")
    .replace(/[^\s"'<>;]*\.(?:mp4|mov|mkv|webm|m4v|mp3|wav|aac|flac|png|jpg|jpeg|gif|heic|srt|vtt)\b/gi, "[media]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .slice(0, 2048);
}

export function redactDiagnostic(value: unknown): unknown {
  const seen = new WeakSet<object>();
  let budget = 400;
  let textBudget = 8000;
  function visit(item: unknown, depth: number): unknown {
    if (--budget < 0 || depth > 6) return "[truncated]";
    if (item === null || item === undefined) return null;
    if (typeof item === "string") { const text = redactText(item).slice(0, Math.max(0, textBudget)); textBudget -= text.length; return text || (item ? "[truncated]" : ""); }
    if (typeof item === "boolean") return item;
    if (typeof item === "number") return Number.isFinite(item) ? item : null;
    if (typeof item !== "object") return `[${typeof item}]`;
    if (seen.has(item)) return "[circular]";
    seen.add(item);
    if (item instanceof Error) return { name: redactText(item.name), message: redactText(item.message), stack: redactText(item.stack ?? ""), cause: visit(item.cause, depth + 1) };
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) return "[binary omitted]";
    if (Array.isArray(item)) {
      const entries = item.slice(0, 40).map((entry) => visit(entry, depth + 1));
      if (item.length > 40) entries.push(`[${item.length - 40} more items omitted]`);
      return entries;
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(item).slice(0, 50)) {
      const normalized = key.replace(/[_\-.$]/g, "");
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      // Do not evaluate arbitrary getters while logging an error.
      result[redactText(key).slice(0, 80)] = PRIVATE_KEY.test(normalized) || CONTENT_KEY.test(normalized)
        ? "[redacted]"
        : descriptor && "value" in descriptor ? visit(descriptor.value, depth + 1) : "[accessor omitted]";
    }
    return result;
  }
  try { return visit(value, 0); } catch { return "[unavailable]"; }
}

/** Only the API's fixed operation names, never project slugs, media paths, queries or hashes. */
export function diagnosticRoute(raw: string): string {
  try {
    const path = new URL(raw, "http://local").pathname;
    const allowed = new Set(["api", "projects", "render", "renders", "cancel", "heartbeat", "upload", "preview", "assets", "files", "save", "events", "diagnostics", "status", "export", "native-project", "timeline", "compositions", "thumbnails", "waveform"]);
    return path.split("/").slice(0, 8).map((part) => part === "" || allowed.has(part) ? part : ":id").join("/");
  } catch { return "[route]"; }
}
