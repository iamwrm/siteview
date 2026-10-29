import { init, parse } from "./vendor/lexer.js?v=11";
import { virtualURL, localPath, applyEdits } from "./core.js?v=11";
import { renderMarkdown, MARKDOWN_STYLE } from "./markdown.js?v=11";

const text = (file) => new TextDecoder().decode(file.bytes);
const escapeAttribute = (value) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
const POLICY =
  "default-src 'none'; script-src 'unsafe-inline' blob: data: https:; worker-src blob:; style-src 'unsafe-inline' blob: data: https:; img-src blob: data: https:; font-src blob: data: https:; media-src blob: data: https:; connect-src blob: data: https:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
const HEAD = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(POLICY)}"><meta name="referrer" content="no-referrer">`;

// This code runs inside the opaque-origin sandbox. It never receives the PAT.
function bridge(base, token) {
  let port;
  let sequence = 0;
  let written = false;
  const waiting = new Map();
  const urls = [];
  const pattern = new RegExp(`${token.replace(/\W/g, "\\$&")}(\\d+)`, "g");
  const substitute = (value) =>
    value.replace(pattern, (match, id) => urls[id] ?? match);
  // The page and its files arrive as raw bytes, and their URLs are made here:
  // parent-origin blob URLs cannot be loaded by an opaque-origin sandbox, and
  // large base64 data URLs are slow to build, parse and decode. Small files
  // use data URLs, which load without a blob-registry round trip per file
  // (costly in long module import chains); large files use blob URLs.
  // Files arrive in order, each after everything it references.
  const resource = ({ type, text, bytes }) => {
    if (text === undefined)
      return urls.push(
        bytes.length < 0x10000 && bytes.toBase64
          ? `data:${type};base64,${bytes.toBase64()}`
          : URL.createObjectURL(new Blob([bytes], { type })),
      );
    const value = substitute(text);
    urls.push(
      value.length < 0x40000
        ? `data:${type};charset=utf-8,${encodeURIComponent(value)}`
        : URL.createObjectURL(
            new Blob([value], { type: `${type};charset=utf-8` }),
          ),
    );
  };
  const write = ({ html }) => {
    const markup = substitute(html);
    const start = () => {
      // document.open() erases listeners, so link handling is added afterwards.
      document.open();
      document.addEventListener("click", click);
      document.addEventListener("mouseover", intent);
      document.addEventListener("pointerdown", intent);
      document.write(markup);
      document.close();
    };
    if (document.readyState === "complete") start();
    else window.addEventListener("load", start, { once: true });
  };
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
        if (data.kind === "resource") {
          if (!written) resource(data);
          return;
        }
        if (data.kind === "document") {
          if (!written) write(data);
          written = true;
          return;
        }
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
  // Ask the host to start loading an internal page the user is about to open:
  // after a short hover, or at once on press, about a round trip before click.
  const prefetched = new Set();
  let hover;
  function intent(event) {
    clearTimeout(hover);
    const link = event.target.closest?.("a[href]");
    const href = link?.getAttribute("href");
    if (!href || href.startsWith("#")) return;
    const url = new URL(href, base);
    if (url.origin !== new URL(base).origin) return;
    const path = decodeURIComponent(url.pathname.slice(1));
    if (prefetched.has(path)) return;
    const send = () => {
      prefetched.add(path);
      port.postMessage({ kind: "prefetch", path });
    };
    if (event.type === "mouseover") hover = setTimeout(send, 65);
    else send();
  }
  async function click(event) {
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
      // Never let a preview replace the app. Ask the host to open external links.
      event.preventDefault();
      if (/^https?:\/\//i.test(href) && link.target !== "_self")
        port.postMessage({ kind: "open", url: url.href });
    }
  }
}

export class Preview {
  // send() delivers files and finally the page to the sandbox, in order.
  constructor(github, send = () => {}) {
    this.github = github;
    this.send = send;
    this.assets = new Map();
    this.modules = new Map();
    this.pending = [];
    this.cssImports = new Map();
    this.warnings = new Set();
    this.disposed = false;
    this.count = 0;
    // Placeholder URLs that the sandbox replaces with URLs it creates.
    this.token = `siteview-resource:${crypto.randomUUID()}:`;
  }

  resourceURL(content, type) {
    if (this.disposed) throw new DOMException("Preview closed", "AbortError");
    this.send(
      typeof content === "string"
        ? { kind: "resource", type, text: content }
        : { kind: "resource", type, bytes: content },
    );
    return this.token + this.count++;
  }

  async file(path) {
    return this.github.file(path);
  }

  // Assets load concurrently, so a CSS cycle would otherwise wait on itself.
  // Record which stylesheets wait on which, and refuse an edge that closes a loop.
  reaches(from, to, seen = new Set()) {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    for (const next of this.cssImports.get(from) || [])
      if (this.reaches(next, to, seen)) return true;
    return false;
  }

  async asset(value, from, fromCSS = false) {
    const local = localPath(value, from);
    if (!local) return value;
    const { path, hash } = local;
    if (fromCSS) {
      if (this.reaches(path, from))
        throw new Error(`Circular CSS import: ${path}`);
      if (!this.cssImports.has(from)) this.cssImports.set(from, new Set());
      this.cssImports.get(from).add(path);
    }
    if (!this.assets.has(path))
      this.assets.set(
        path,
        (async () => {
          const file = await this.file(path);
          return this.resourceURL(
            file.type === "text/css"
              ? await this.css(text(file), path, true)
              : file.bytes,
            file.type,
          );
        })(),
      );
    return (await this.assets.get(path)) + hash;
  }

  async css(source, from, fromCSS = false) {
    // Covers CSS url() and quoted @import. Complex generated CSS should be built before previewing.
    const pattern =
      /url\(\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\s)'"\n]*))\s*\)|@import\s+(?:"([^"\n]+)"|'([^'\n]+)')/gi;
    const edits = await Promise.all(
      [...source.matchAll(pattern)].map(async (match) => {
        const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
        const replacement = await this.asset(value, from, fromCSS);
        return {
          start: match.index,
          end: match.index + match[0].length,
          value: match[0].startsWith("@")
            ? `@import "${replacement}"`
            : `url("${replacement}")`,
        };
      }),
    );
    return applyEdits(source, edits);
  }

  // Starts loading a module without waiting for it. Imports are rewritten to
  // import-map names, so only finish() needs their resource URLs; settle() waits.
  module(path) {
    if (this.modules.has(path)) return;
    // Reserve the name first so cyclic ES module graphs can use the import map.
    this.modules.set(path, null);
    const loading = (async () => {
      const file = await this.file(path);
      const source = await this.javascript(text(file), path);
      this.modules.set(path, this.resourceURL(source, "text/javascript"));
    })();
    loading.catch(() => {}); // Reported by settle(); avoid unhandled rejections.
    this.pending.push(loading);
  }

  async settle() {
    for (let done = 0; done < this.pending.length;) {
      const batch = this.pending.slice(done);
      await Promise.all(batch);
      done += batch.length;
    }
  }

  async javascript(source, from) {
    await init;
    const [imports] = parse(source);
    const edits = [];
    const assets = [];
    for (const item of imports) {
      if (item.d === -2) continue; // import.meta
      if (!item.n) {
        this.warnings.add("Computed dynamic imports cannot be resolved.");
        continue;
      }
      if (!/^(\.\.?\/|\/)/.test(item.n)) continue; // external URLs and bare import-map names
      const local = localPath(item.n, from);
      if (!local) continue;
      this.module(local.path);
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
      assets.push(
        this.asset(match[2], from).then((url) => ({
          start: match.index,
          end: match.index + match[0].length,
          value: `new URL(${JSON.stringify(url)}, ${JSON.stringify(virtualURL(from))})`,
        })),
      );
    }
    edits.push(...(await Promise.all(assets)));
    return applyEdits(source, edits);
  }

  async build(path) {
    const file = await this.file(path);
    if (file.type === "text/markdown") return this.markdown(text(file), path);
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
      return this.finish(doc);
    }
    const doc = new DOMParser().parseFromString(text(file), "text/html");
    for (const node of doc.querySelectorAll(
      "base, meta[http-equiv], frame, object, embed",
    ))
      node.remove();
    // Inline srcdoc frames (e.g. SingleFile saves) stay; they inherit this
    // document's CSP and get their own opaque-origin sandbox. Others go.
    for (const node of doc.querySelectorAll("iframe")) {
      if (!node.hasAttribute("srcdoc")) {
        node.remove();
        continue;
      }
      node.removeAttribute("src");
      node.setAttribute("sandbox", "allow-scripts");
    }
    for (const node of doc.querySelectorAll("[integrity]"))
      node.removeAttribute("integrity");
    for (const node of doc.querySelectorAll(
      'link[rel="preload"], link[rel="modulepreload"], link[rel="prefetch"], link[rel="manifest"]',
    ))
      node.remove();
    // Every rewrite starts now and runs concurrently; the document is
    // serialized only after all of them, and all modules, have finished.
    const tasks = [];
    const rewrite = (node, attr, load) =>
      tasks.push(load.then((value) => node.setAttribute(attr, value)));
    const moduleScripts = [];
    for (const style of doc.querySelectorAll("style"))
      tasks.push(
        this.css(style.textContent, path).then((value) => {
          style.textContent = value;
        }),
      );
    for (const node of doc.querySelectorAll("[style]"))
      rewrite(node, "style", this.css(node.getAttribute("style"), path));
    for (const node of doc.querySelectorAll("link[href]")) {
      if (["stylesheet", "icon", "apple-touch-icon"].includes(node.rel))
        rewrite(node, "href", this.asset(node.getAttribute("href"), path));
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
            this.module(local.path);
            moduleScripts.push([node, local.path]);
          }
        } else
          tasks.push(
            this.javascript(node.textContent, path).then((value) => {
              node.textContent = value;
            }),
          );
      } else if (src) rewrite(node, "src", this.asset(src, path));
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
        rewrite(node, attr, this.asset(node.getAttribute(attr), path));
    }
    for (const node of doc.querySelectorAll("[srcset]")) {
      const value = node.getAttribute("srcset");
      if (value.includes("data:")) {
        this.warnings.add("Data URLs in srcset are left unchanged.");
        continue;
      }
      const entries = value.split(",").map(async (entry) => {
        const [url, ...descriptor] = entry.trim().split(/\s+/);
        return [await this.asset(url, path), ...descriptor].join(" ");
      });
      rewrite(
        node,
        "srcset",
        Promise.all(entries).then((list) => list.join(", ")),
      );
    }
    await Promise.all(tasks);
    await this.settle();
    for (const [node, local] of moduleScripts)
      node.setAttribute("src", this.modules.get(local));
    return this.finish(doc);
  }

  async markdown(source, path) {
    const { html, title } = renderMarkdown(source);
    const doc = document.implementation.createHTMLDocument(title || path);
    const article = doc.createElement("article");
    article.className = "markdown-body";
    // The renderer escapes repository HTML, so this only contains generated tags.
    article.innerHTML = html;
    doc.body.append(article);
    const style = doc.createElement("style");
    style.textContent = MARKDOWN_STYLE;
    doc.head.append(style);
    await Promise.all(
      [...doc.querySelectorAll("img[src]")].map(async (image) =>
        image.setAttribute(
          "src",
          await this.asset(image.getAttribute("src"), path),
        ),
      ),
    );
    for (const link of doc.querySelectorAll("a[href]")) {
      const local = localPath(link.getAttribute("href"), path);
      if (local && !link.getAttribute("href").startsWith("#"))
        link.setAttribute(
          "href",
          virtualURL(local.path) + local.search + local.hash,
        );
    }
    return this.finish(doc);
  }

  // A small srcdoc that connects the bridge and then writes the page it is sent.
  shell(path) {
    const args = [virtualURL(path), this.token]
      .map((value) => JSON.stringify(value).replaceAll("<", "\\u003c"))
      .join(", ");
    return `<!doctype html>\n${HEAD}<script>(${bridge.toString()})(${args})<\/script>`;
  }

  finish(doc) {
    const imports = {};
    for (const [name, url] of this.modules) imports[virtualURL(name)] = url;
    doc.head.insertAdjacentHTML(
      "afterbegin",
      `${HEAD}<script type="importmap">${JSON.stringify({ imports }).replaceAll("<", "\\u003c")}<\/script>`,
    );
    return {
      kind: "document",
      html: "<!doctype html>\n" + doc.documentElement.outerHTML,
    };
  }

  dispose() {
    this.disposed = true;
    this.assets.clear();
    this.modules.clear();
  }
}
