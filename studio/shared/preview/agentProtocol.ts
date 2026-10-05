/** Messages exchanged with an authored preview running in an opaque-origin iframe. */
export const PREVIEW_AGENT_CHANNEL = "mpvfx.preview-agent" as const;
export const PREVIEW_AGENT_VERSION = 1 as const;

export type PreviewElementHandle = string;
export type PreviewRect = { x: number; y: number; width: number; height: number };
export type PreviewElementState = {
  handle: PreviewElementHandle;
  tag: string;
  id: string;
  className: string;
  text: string;
  rect: PreviewRect;
  visible: boolean;
  parent: PreviewElementHandle | null;
  selector?: string;
  selectorIndex?: number;
  sourceFile: string;
  compositionPath: string;
  dataAttributes: Record<string, string>;
  inlineStyles: Record<string, string>;
  computedStyles: Record<string, string>;
};

export type PreviewAgentCommand =
  | { kind: "snapshot"; offset?: number; limit?: number }
  | { kind: "hitTest"; x: number; y: number }
  | { kind: "readElement"; handle: PreviewElementHandle }
  | { kind: "setStyle"; handle: PreviewElementHandle; property: string; value: string }
  | { kind: "setText"; handle: PreviewElementHandle; text: string }
  | { kind: "setAttribute"; handle: PreviewElementHandle; name: string; value: string };

export type PreviewAgentInit = {
  channel: typeof PREVIEW_AGENT_CHANNEL;
  version: typeof PREVIEW_AGENT_VERSION;
  type: "init";
  token: string;
};
export type PreviewAgentRequest = {
  channel: typeof PREVIEW_AGENT_CHANNEL;
  version: typeof PREVIEW_AGENT_VERSION;
  type: "request";
  token: string;
  id: number;
  command: PreviewAgentCommand;
};
export type PreviewAgentReply = {
  channel: typeof PREVIEW_AGENT_CHANNEL;
  version: typeof PREVIEW_AGENT_VERSION;
  type: "reply";
  token: string;
  id: number;
  ok: boolean;
  result?: PreviewElementState | PreviewElementState[] | null;
  error?: "invalid-request" | "stale-handle" | "unsupported-action";
};
export type PreviewAgentReady = {
  channel: typeof PREVIEW_AGENT_CHANNEL;
  version: typeof PREVIEW_AGENT_VERSION;
  type: "ready";
  token: string;
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const boundedString = (value: unknown, limit: number): value is string =>
  typeof value === "string" && value.length <= limit;
const handle = (value: unknown): value is string =>
  typeof value === "string" && /^e[1-9]\d{0,8}$/.test(value);

export function isPreviewAgentInit(value: unknown): value is PreviewAgentInit {
  return record(value) && exactKeys(value, ["channel", "version", "type", "token"])
    && value.channel === PREVIEW_AGENT_CHANNEL && value.version === PREVIEW_AGENT_VERSION
    && value.type === "init" && boundedString(value.token, 128) && value.token.length >= 16;
}

export function isPreviewAgentRequest(value: unknown): value is PreviewAgentRequest {
  if (!record(value) || !exactKeys(value, ["channel", "version", "type", "token", "id", "command"])
    || value.channel !== PREVIEW_AGENT_CHANNEL || value.version !== PREVIEW_AGENT_VERSION
    || value.type !== "request" || !boundedString(value.token, 128) || value.token.length < 16
    || !Number.isSafeInteger(value.id) || (value.id as number) < 1 || !record(value.command)) return false;
  const command = value.command;
  switch (command.kind) {
    case "snapshot": return (exactKeys(command, ["kind"])
      || exactKeys(command, ["kind", "offset"])
      || exactKeys(command, ["kind", "limit"])
      || exactKeys(command, ["kind", "offset", "limit"]))
      && (command.offset === undefined || (Number.isSafeInteger(command.offset) && (command.offset as number) >= 0 && (command.offset as number) <= 100000))
      && (command.limit === undefined || (Number.isSafeInteger(command.limit) && (command.limit as number) >= 1 && (command.limit as number) <= 300));
    case "hitTest": return exactKeys(command, ["kind", "x", "y"])
      && typeof command.x === "number" && Number.isFinite(command.x)
      && typeof command.y === "number" && Number.isFinite(command.y);
    case "readElement": return exactKeys(command, ["kind", "handle"]) && handle(command.handle);
    case "setStyle": return exactKeys(command, ["kind", "handle", "property", "value"])
      && handle(command.handle) && boundedString(command.property, 64) && boundedString(command.value, 512);
    case "setText": return exactKeys(command, ["kind", "handle", "text"])
      && handle(command.handle) && boundedString(command.text, 4096);
    case "setAttribute": return exactKeys(command, ["kind", "handle", "name", "value"])
      && handle(command.handle) && boundedString(command.name, 64) && boundedString(command.value, 512);
    default: return false;
  }
}
