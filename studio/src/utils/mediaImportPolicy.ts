export const SUPPORTED_MEDIA_IMPORT_EXTENSIONS = {
  video: ["mp4", "m4v", "mov", "webm"],
  audio: ["mp3", "wav", "ogg", "m4a", "aac"],
  image: ["jpg", "jpeg", "png", "gif", "webp", "avif", "svg", "ico"],
  font: ["woff", "woff2", "ttf", "ttc", "otf", "eot"],
  lut: ["cube"],
} as const;

export type MediaImportKind = keyof typeof SUPPORTED_MEDIA_IMPORT_EXTENSIONS;
export type TimelineMediaImportKind = Extract<MediaImportKind, "video" | "audio" | "image">;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  avi: "video/x-msvideo",
  mxf: "video/mxf",
  mts: "video/mp2t",
  m2ts: "video/mp2t",
  ts: "video/mp2t",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  flac: "audio/flac",
  opus: "audio/ogg",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  ttc: "font/collection",
  otf: "font/otf",
  eot: "application/vnd.ms-fontobject",
  cube: "text/plain; charset=utf-8",
};

const KIND_BY_EXTENSION = new Map<string, MediaImportKind>(
  Object.entries(SUPPORTED_MEDIA_IMPORT_EXTENSIONS).flatMap(([kind, extensions]) =>
    extensions.map((extension) => [extension, kind as MediaImportKind] as const),
  ),
);

const MAIN_LIBRARY_KINDS = ["video", "audio", "image", "font"] as const;

function acceptFor(kinds: readonly MediaImportKind[]): string {
  return kinds
    .flatMap((kind) => SUPPORTED_MEDIA_IMPORT_EXTENSIONS[kind].map((extension) => `.${extension}`))
    .join(",");
}

export const MEDIA_IMPORT_ACCEPT = acceptFor(MAIN_LIBRARY_KINDS);
export const IMAGE_IMPORT_ACCEPT = acceptFor(["image"]);
export const FONT_IMPORT_ACCEPT = acceptFor(["font"]);
export const LUT_IMPORT_ACCEPT = acceptFor(["lut"]);

export type MediaImportRejectionReason =
  | "empty-file"
  | "unsupported-extension"
  | "mime-type-mismatch";

export type MediaImportInspection =
  | {
      accepted: true;
      kind: MediaImportKind;
      extension: string;
      preferredMimeType: string;
    }
  | { accepted: false; reason: MediaImportRejectionReason };

interface MediaImportFileLike {
  name: string;
  type: string;
  size: number;
}

function extensionFromPath(path: string): string | null {
  const clean = path.split(/[?#]/, 1)[0]?.replace(/\\/g, "/") ?? "";
  const name = clean.slice(clean.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

export function classifyMediaImportPath(path: string): MediaImportKind | null {
  const extension = extensionFromPath(path);
  return extension ? (KIND_BY_EXTENSION.get(extension) ?? null) : null;
}

export function isImportableMediaPath(path: string): boolean {
  const kind = classifyMediaImportPath(path);
  return kind === "video" || kind === "audio" || kind === "image";
}

export function preferredMediaImportMimeType(path: string): string | null {
  const extension = extensionFromPath(path);
  return extension ? (MIME_BY_EXTENSION[extension] ?? null) : null;
}

function mimeMatchesKind(mimeType: string, kind: MediaImportKind): boolean {
  const mime = mimeType.trim().toLowerCase().split(";", 1)[0] ?? "";
  if (!mime || mime === "application/octet-stream") return true;
  if (kind === "video") {
    return mime.startsWith("video/") || mime === "application/x-matroska" || mime === "application/mxf";
  }
  if (kind === "audio") return mime.startsWith("audio/");
  if (kind === "image") return mime.startsWith("image/");
  if (kind === "font") {
    return (
      mime.startsWith("font/") ||
      mime.startsWith("application/font") ||
      mime.startsWith("application/x-font-") ||
      mime === "application/vnd.ms-fontobject"
    );
  }
  return mime === "text/plain" || mime === "application/x-cube";
}

export function inspectMediaImportFile(file: MediaImportFileLike): MediaImportInspection {
  if (file.size === 0) return { accepted: false, reason: "empty-file" };
  const extension = extensionFromPath(file.name);
  const kind = extension ? KIND_BY_EXTENSION.get(extension) : undefined;
  if (!extension || !kind) return { accepted: false, reason: "unsupported-extension" };
  if (!mimeMatchesKind(file.type, kind)) {
    return { accepted: false, reason: "mime-type-mismatch" };
  }
  return {
    accepted: true,
    kind,
    extension,
    preferredMimeType: MIME_BY_EXTENSION[extension] ?? "application/octet-stream",
  };
}

export function partitionMediaImportFiles<T extends MediaImportFileLike>(files: Iterable<T>): {
  accepted: Array<{ file: T; kind: MediaImportKind; extension: string }>;
  rejected: Array<{ file: T; reason: MediaImportRejectionReason }>;
} {
  const accepted: Array<{ file: T; kind: MediaImportKind; extension: string }> = [];
  const rejected: Array<{ file: T; reason: MediaImportRejectionReason }> = [];
  for (const file of files) {
    const inspection = inspectMediaImportFile(file);
    if (inspection.accepted) {
      accepted.push({ file, kind: inspection.kind, extension: inspection.extension });
    } else {
      rejected.push({ file, reason: inspection.reason });
    }
  }
  return { accepted, rejected };
}

export function mediaImportExtensionPattern(kinds: readonly MediaImportKind[]): RegExp {
  const extensions = kinds.flatMap((kind) => [...SUPPORTED_MEDIA_IMPORT_EXTENSIONS[kind]]);
  return new RegExp(`\\.(?:${extensions.join("|")})(?=$|[?#])`, "i");
}
