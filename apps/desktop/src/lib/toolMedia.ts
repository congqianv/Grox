/* Ported from vscode-supergrok (MIT) media extractors */
export type MediaKind = "image" | "video";
export type MediaRef =
  | { media: MediaKind; kind: "data"; mimeType: string; data: string }
  | { media: MediaKind; kind: "path"; path: string; mimeType?: string }
  | { media: MediaKind; kind: "uri"; uri: string; mimeType?: string };

export type UpdateRoute =
  | { event: "messageChunk"; text: string }
  | { event: "userMessageChunk"; text: string }
  | { event: "thoughtChunk"; text: string }
  | { event: "mediaContent"; media: MediaRef }
  | { event: "toolCall"; payload: any }
  | { event: "toolCallUpdate"; payload: any }
  | { event: "plan"; payload: any }
  | { event: "modeChanged"; modeId: string }
  | { event: "commandsUpdate"; commands: any[] }
  | { event: "update"; payload: any };

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const VIDEO_EXT_RE = /\.(mp4|mov|webm|m4v)$/i;

const MEDIA_PATH_IN_TEXT_RE =
  /(?:\\\\\?\\)?(?:[A-Za-z]:[\\/]|\/|\\\\)[^\r\n"'<>|?*]*?\.(?:png|jpe?g|gif|webp|bmp|svg|mp4|mov|webm|m4v)(?=$|[\s.,;:)"'\]])/gi;

function cleanMediaPath(p: string): string {
  return p.replace(/^\\\\\?\\/, "");
}

function isImageMime(m: unknown): boolean {
  return typeof m === "string" && m.toLowerCase().startsWith("image/");
}

function mediaKindForPath(p: string): MediaKind | null {
  if (IMAGE_EXT_RE.test(p)) return "image";
  if (VIDEO_EXT_RE.test(p)) return "video";
  return null;
}

function refFromUri(media: MediaKind, uri: string, mimeType?: string): MediaRef {
  if (uri.startsWith("file://")) {
    try {
      return { media, kind: "path", path: decodeURIComponent(new URL(uri).pathname), mimeType };
    } catch {
      return { media, kind: "path", path: uri.replace(/^file:\/\//, ""), mimeType };
    }
  }
  if (/^[a-z]+:\/\//i.test(uri)) return { media, kind: "uri", uri, mimeType };
  return { media, kind: "path", path: uri, mimeType };
}

export function extractImageContent(block: any): MediaRef | null {
  if (!block || typeof block !== "object") return null;
  if (block.type === "image" && typeof block.data === "string") {
    return { media: "image", kind: "data", mimeType: block.mimeType || "image/png", data: block.data };
  }
  if (block.type === "resource" && block.resource && typeof block.resource === "object") {
    const r = block.resource;
    if (typeof r.blob === "string" && (isImageMime(r.mimeType) || IMAGE_EXT_RE.test(String(r.uri ?? "")))) {
      return { media: "image", kind: "data", mimeType: isImageMime(r.mimeType) ? r.mimeType : "image/png", data: r.blob };
    }
    if (typeof r.uri === "string" && (isImageMime(r.mimeType) || IMAGE_EXT_RE.test(r.uri))) {
      return refFromUri("image", r.uri, isImageMime(r.mimeType) ? r.mimeType : undefined);
    }
  }
  if (block.type === "resource_link" && typeof block.uri === "string" &&
      (isImageMime(block.mimeType) || IMAGE_EXT_RE.test(block.uri))) {
    return refFromUri("image", block.uri, isImageMime(block.mimeType) ? block.mimeType : undefined);
  }
  return null;
}

export function collectToolImages(payload: any): MediaRef[] {
  const arr = payload?.content;
  if (!Array.isArray(arr)) return [];
  const out: MediaRef[] = [];
  for (const item of arr) {
    const ref = extractImageContent(item?.type === "content" ? item.content : item);
    if (ref) out.push(ref);
  }
  return out;
}

export function isMediaGenToolCall(payload: any): boolean {
  if (!payload || typeof payload !== "object") return false;
  const title = String(payload.title ?? "");
  if (/^imagine(-video|-edit)?:/i.test(title)) return true;
  if (/^(image_gen|image_edit|video_gen|image_to_video|reference_to_video)\b/i.test(title)) return true;
  if (/^(image-to-video:|reference-to-video:)/i.test(title)) return true;
  const ri = payload.rawInput;
  return !!(ri && typeof ri === "object" && typeof ri.variant === "string" &&
    /imagegen|imageedit|videogen|imagetovideo|referencetovideo/i.test(ri.variant));
}

export function extractGeneratedMediaPaths(payload: any): MediaRef[] {
  const arr = payload?.content;
  if (!Array.isArray(arr)) return [];
  const out: MediaRef[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const p = cleanMediaPath(raw);
    const media = mediaKindForPath(p);
    if (media && !seen.has(p)) { seen.add(p); out.push({ media, kind: "path", path: p }); }
  };
  for (const item of arr) {
    const block = item?.type === "content" ? item.content : item;
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    let parsed: any;
    try { parsed = JSON.parse(block.text); } catch {  }
    if (parsed && typeof parsed.path === "string") {
      add(parsed.path);
    } else if (parsed === undefined) {
      for (const m of block.text.matchAll(MEDIA_PATH_IN_TEXT_RE)) add(m[0]);
    }
  }
  return out;
}

