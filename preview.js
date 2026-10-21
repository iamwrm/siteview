import { init, parse } from "./vendor/lexer.js?v=5";
import { virtualURL, localPath, applyEdits } from "./core.js?v=5";

const text = (file) => new TextDecoder().decode(file.bytes);
const escapeAttribute = (value) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");

// This code runs inside the opaque-origin sandbox. It never receives the PAT.
function bridge(base) {
  let port;
  let sequence = 0;
  const waiting = new Map();
  const ready = new Promise((resolve) => {
    const receive = (event) => {
      if (
        event.source !== parent ||
        event.data !== "siteview:connect" ||
        !event.ports[0]
      )
        return;
      window.removeEventListener("message", receive);
      port = event.ports[0];
      port.onmessage = ({ data }) => {
        const pending = waiting.get(data.id);
        if (!pending) return;
        waiting.delete(data.id);
        if (data.error) pending.reject(new TypeError(data.error));
        else
          pending.resolve(
            new Response(data.bytes, {
              status: data.status || 200,
              headers: { "Content-Type": data.type },
            }),
          );
      };
      resolve();
    };
    window.addEventListener("message", receive);
    parent.postMessage("siteview:ready", "*");
  });
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, options = {}) => {
    const value = input instanceof Request ? input.url : String(input);
    const url = new URL(value, base);
    if (url.origin !== new URL(base).origin)
      return nativeFetch(input, {
        ...options,
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
    if (
      (
        options.method || (input instanceof Request ? input.method : "GET")
      ).toUpperCase() !== "GET"
    )
      throw new TypeError("Repository files are read-only.");
    await ready;
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      waiting.set(id, { resolve, reject });
      port.postMessage({
        kind: "fetch",
        id,
        path: decodeURIComponent(url.pathname.slice(1)),
      });
    });
  };
  document.addEventListener("click", async (event) => {
    const link = event.target.closest?.("a[href]");
    if (!link || event.defaultPrevented) return;
    const href = link.getAttribute("href");
    if (!href || href.startsWith("#")) return;
    const url = new URL(href, base);
    if (url.origin === new URL(base).origin) {
      event.preventDefault();
      await ready;
      port.postMessage({
        kind: "navigate",
        path: decodeURIComponent(url.pathname.slice(1)),
        hash: url.hash,
      });
    } else {
      // Do not let a preview replace the app or open a privileged same-origin tab.
      event.preventDefault();
    }
  });
}

export class Preview {
  constructor(github, onProgress = () => {}) {
    this.github = github;
    this.onProgress = onProgress;
    this.assets = new Map();
    this.modules = new Map();
    this.warnings = new Set();
    this.disposed = false;
  }

  resourceURL(content, type) {
    if (this.disposed) throw new DOMException("Preview closed", "AbortError");
    const bytes =
      typeof content === "string" ? new TextEncoder().encode(content) : content;
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 0x8000)
      chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
    // Parent-origin blob URLs cannot be loaded by an opaque-origin sandbox.
    return `data:${type};base64,${btoa(chunks.join(""))}`;
  }

  async file(path) {
    this.onProgress(path);
    return this.github.file(path);
  }

  async asset(value, from, stack = []) {
    const local = localPath(value, from);
    if (!local) return value;
    const { path, hash } = local;
    if (stack.includes(path)) throw new Error(`Circular CSS import: ${path}`);
    if (!this.assets.has(path))
      this.assets.set(
        path,
        (async () => {
          const file = await this.file(path);
          return this.resourceURL(
            file.type === "text/css"
              ? await this.css(text(file), path, [...stack, path])
              : file.bytes,
            file.type,
          );
        })(),
      );
    return (await this.assets.get(path)) + hash;
  }

  async css(source, from, stack = []) {
    const edits = [];
    // Covers CSS url() and quoted @import. Complex generated CSS should be built before previewing.
    const pattern =
      /url\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s)'"\n]*))\s*\)|@import\s+(?:"([^"\n]+)"|'([^'\n]+)')/gi;
    for (const match of source.matchAll(pattern)) {
      const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
      const replacement = await this.asset(value, from, stack);
      edits.push({
        start: match.index,
        end: match.index + match[0].length,
        value: match[0].startsWith("@")
          ? `@import "${replacement}"`
          : `url("${replacement}")`,
      });
    }
    return applyEdits(source, edits);
  }

  async module(path) {
    if (this.modules.has(path)) return;
    // Reserve the name first so cyclic ES module graphs can use the import map.
    this.modules.set(path, null);
    const file = await this.file(path);
    const source = await this.javascript(text(file), path);
    this.modules.set(path, this.resourceURL(source, "text/javascript"));
  }

  async javascript(source, from) {
    await init;
    const [imports] = parse(source);
    const edits = [];
    for (const item of imports) {
      if (item.d === -2) continue; // import.meta
      if (!item.n) {
        this.warnings.add("Computed dynamic imports cannot be resolved.");
        continue;
      }
      if (!/^(\.\.?\/|\/)/.test(item.n)) continue; // external URLs and bare import-map names
      const local = localPath(item.n, from);
      if (!local) continue;
      await this.module(local.path);
      const url = virtualURL(local.path);
      edits.push({
        start: item.s,
        end: item.e,
        value: item.d >= 0 ? JSON.stringify(url) : url,
      });
    }
    // Common asset idiom used by native modules and build tools.
    for (const match of source.matchAll(
      /new\s+URL\(\s*(['"])([^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)/g,
    )) {
      const url = await this.asset(match[2], from);
      edits.push({
        start: match.index,
        end: match.index + match[0].length,
        value: `new URL(${JSON.stringify(url)}, ${JSON.stringify(virtualURL(from))})`,
      });
    }
    return applyEdits(source, edits);
  }

  async build(path) {
    const file = await this.file(path);
    if (!["text/html"].includes(file.type)) {
      const doc = document.implementation.createHTMLDocument(path);
      if (file.type.startsWith("image/")) {
        const image = doc.createElement("img");
        image.src = this.resourceURL(file.bytes, file.type);
        image.style.maxWidth = "100%";
        image.alt = path;
        doc.body.append(image);
      } else {
        const pre = doc.createElement("pre");
        pre.textContent = text(file);
        pre.style.cssText =
          "white-space:pre-wrap;overflow-wrap:anywhere;padding:24px";
        doc.body.append(pre);
      }
      return this.finish(doc, path);
    }
    const doc = new DOMParser().parseFromString(text(file), "text/html");
    for (const node of doc.querySelectorAll(
      "base, meta[http-equiv], iframe, frame, object, embed",
    ))
      node.remove();
    for (const node of doc.querySelectorAll("[integrity]"))
      node.removeAttribute("integrity");
    for (const node of doc.querySelectorAll(
      'link[rel="preload"], link[rel="modulepreload"], link[rel="prefetch"], link[rel="manifest"]',
    ))
      node.remove();
    for (const style of doc.querySelectorAll("style"))
      style.textContent = await this.css(style.textContent, path);
    for (const node of doc.querySelectorAll("[style]"))
      node.setAttribute(
        "style",
        await this.css(node.getAttribute("style"), path),
      );
    for (const node of doc.querySelectorAll("link[href]")) {
      if (["stylesheet", "icon", "apple-touch-icon"].includes(node.rel))
        node.setAttribute(
          "href",
          await this.asset(node.getAttribute("href"), path),
        );
    }
    for (const node of doc.querySelectorAll("script")) {
      if (node.type === "importmap") {
        this.warnings.add(
          "Repository import maps are not supported. Use relative module imports or full CDN URLs.",
        );
        node.remove();
        continue;
      }
      if (
        node.type &&
        !["module", "text/javascript", "application/javascript"].includes(
          node.type,
        )
      )
        continue;
      const src = node.getAttribute("src");
      if (node.type === "module") {
        if (src) {
          const local = localPath(src, path);
          if (local) {
            await this.module(local.path);
            node.setAttribute("src", this.modules.get(local.path));
          }
        } else node.textContent = await this.javascript(node.textContent, path);
      } else if (src) node.setAttribute("src", await this.asset(src, path));
    }
    const attributes = [
      ["img", "src"],
      ["source", "src"],
      ["video", "src"],
      ["video", "poster"],
      ["audio", "src"],
      ["track", "src"],
      ['input[type="image"]', "src"],
      ["image", "href"],
      ["use", "href"],
    ];
    for (const [selector, attr] of attributes) {
      for (const node of doc.querySelectorAll(`${selector}[${attr}]`))
        node.setAttribute(
          attr,
          await this.asset(node.getAttribute(attr), path),
        );
    }
    for (const node of doc.querySelectorAll("[srcset]")) {
      const value = node.getAttribute("srcset");
      if (value.includes("data:")) {
        this.warnings.add("Data URLs in srcset are left unchanged.");
        continue;
      }
      const entries = [];
      for (const entry of value.split(",")) {
        const [url, ...descriptor] = entry.trim().split(/\s+/);
        entries.push([await this.asset(url, path), ...descriptor].join(" "));
      }
      node.setAttribute("srcset", entries.join(", "));
    }
    return this.finish(doc, path);
  }

  finish(doc, path) {
    const imports = {};
    for (const [name, url] of this.modules) imports[virtualURL(name)] = url;
    const policy =
      "default-src 'none'; script-src 'unsafe-inline' data: https:; worker-src blob:; style-src 'unsafe-inline' data: https:; img-src blob: data: https:; font-src blob: data: https:; media-src blob: data: https:; connect-src blob: data: https:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
    const prefix = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}"><meta name="referrer" content="no-referrer"><script>(${bridge.toString()})(${JSON.stringify(virtualURL(path)).replaceAll("<", "\\u003c")})<\/script><script type="importmap">${JSON.stringify({ imports }).replaceAll("<", "\\u003c")}<\/script>`;
    doc.head.insertAdjacentHTML("afterbegin", prefix);
    return "<!doctype html>\n" + doc.documentElement.outerHTML;
  }

  dispose() {
    this.disposed = true;
    this.assets.clear();
    this.modules.clear();
  }
}
