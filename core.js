export const VIRTUAL_ORIGIN = "https://siteview.invalid";

export function parseGitHubURL(input, refOverride = "") {
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Paste a complete GitHub file URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    throw new Error("Use an HTTPS GitHub URL without credentials.");
  const parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        throw new Error("The URL contains invalid encoding.");
      }
    });
  const raw = url.hostname === "raw.githubusercontent.com";
  if (!raw && url.hostname !== "github.com")
    throw new Error(
      "Only github.com and raw.githubusercontent.com URLs are supported.",
    );
  if (
    parts.length < (raw ? 4 : 5) ||
    (!raw && !["blob", "raw"].includes(parts[2]))
  )
    throw new Error(
      "Use a file URL, such as https://github.com/owner/repo/blob/main/index.html.",
    );
  const [owner, repo] = parts;
  if (
    !/^[\w.-]+$/.test(owner) ||
    !/^[\w.-]+$/.test(repo) ||
    [owner, repo].some((x) => x === "." || x === "..")
  )
    throw new Error("Invalid repository name.");
  const tail = parts.slice(raw ? 2 : 3).join("/");
  if (
    parts.some((p) => !p || p === "." || p === ".." || /[\x00-\x1f\\]/.test(p))
  )
    throw new Error("Invalid file path.");
  const override = refOverride.trim();
  if (override && !tail.startsWith(`${override}/`))
    throw new Error(
      "The ref override must match the start of the ref and path in the URL.",
    );
  return { owner, repo, tail, refOverride: override };
}

export function chooseRef(tail, refs) {
  return refs
    .filter((ref) => tail.startsWith(`${ref}/`))
    .sort((a, b) => b.length - a.length)[0];
}

export function sourceURL({ owner, repo, ref, path }) {
  return `https://github.com/${owner}/${repo}/blob/${ref.split("/").map(encodeURIComponent).join("/")}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function shareURL(base, target, ref = target.ref) {
  const url = new URL(base);
  url.search = "";
  url.hash = new URLSearchParams({
    url: sourceURL({ ...target, ref }),
    ref,
  }).toString();
  return url.href;
}

export function virtualURL(path) {
  return `${VIRTUAL_ORIGIN}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function localPath(value, from) {
  if (
    !value ||
    value.startsWith("#") ||
    /^(data:|blob:|javascript:|mailto:|tel:)/i.test(value)
  )
    return null;
  const url = new URL(value, virtualURL(from));
  if (url.origin !== VIRTUAL_ORIGIN) return null;
  return {
    path: decodeURIComponent(url.pathname.slice(1)),
    hash: url.hash,
    search: url.search,
  };
}

const types = {
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  md: "text/markdown",
  markdown: "text/markdown",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  txt: "text/plain",
  wasm: "application/wasm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  mp4: "video/mp4",
  webm: "video/webm",
  mp3: "audio/mpeg",
  pdf: "application/pdf",
  xml: "application/xml",
};
export function mime(path) {
  return (
    types[path.split(".").pop().toLowerCase()] || "application/octet-stream"
  );
}

export function applyEdits(source, edits) {
  // One pass over non-overlapping edits; repeated slicing is quadratic on large files.
  const parts = [];
  let last = 0;
  for (const { start, end, value } of edits.sort((a, b) => a.start - b.start)) {
    parts.push(source.slice(last, start), value);
    last = end;
  }
  parts.push(source.slice(last));
  return parts.join("");
}
