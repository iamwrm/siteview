import { parseGitHubURL, sourceURL, shareURL } from "./core.js?v=12";
import { GitHub } from "./github.js?v=12";
import { Preview } from "./preview.js?v=12";

const $ = (id) => document.getElementById(id);
let session;
let generation = 0;
let bridgePort;
let handshake;
let currentFrame;

// Browser storage holds only what the user opts into. Previews run in an
// opaque-origin sandbox and can read none of it.
const KEYS = {
  token: "siteview:token",
  trusted: "siteview:trusted",
  trustAll: "siteview:trust-all",
  recent: "siteview:recent",
};
const store = {
  get(key, fallback = null) {
    try {
      const value = localStorage.getItem(key);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

function status(message, error = false) {
  $("status").hidden = !message;
  $("status").textContent = message;
  $("status").dataset.error = String(error);
}

function view(name) {
  document.body.dataset.view = name;
}

function busy(value) {
  document.body.toggleAttribute("data-busy", value);
  $("go").hidden = value;
  $("cancel").hidden = !value;
}

// Token

function saveToken() {
  store.set(
    KEYS.token,
    $("remember-token").checked && $("token").value ? $("token").value : null,
  );
}

function restoreToken() {
  const saved = store.get(KEYS.token);
  $("token").value = typeof saved === "string" ? saved : "";
  $("remember-token").checked = Boolean($("token").value);
  updateTokenLabel();
}

function updateTokenLabel() {
  const set = Boolean($("token").value);
  $("settings-button").dataset.token = String(set);
  $("settings-button").setAttribute(
    "aria-label",
    set ? "Settings, token set" : "Settings",
  );
}

function openSettings(focusToken = false) {
  updateTrustSummary();
  if (!$("settings").open) $("settings").showModal();
  if (focusToken) $("token").focus();
}

// Trust: asked once per repository, unless the user trusts every repository.

const repoKey = ({ owner, repo }) => `${owner}/${repo}`.toLowerCase();

function updateTrustSummary() {
  const count = store.get(KEYS.trusted, []).length;
  $("trust-all").checked = store.get(KEYS.trustAll) === true;
  $("trusted-count").textContent = count
    ? `${count} trusted ${count === 1 ? "repository" : "repositories"}.`
    : "";
  $("forget-trusted").hidden = !count;
}

function trust(input) {
  const key = repoKey(input);
  if (store.get(KEYS.trustAll) === true) return Promise.resolve(true);
  if (store.get(KEYS.trusted, []).includes(key)) return Promise.resolve(true);
  const dialog = $("trust");
  if (dialog.open) return Promise.resolve(false);
  $("trust-repo").textContent = `${input.owner}/${input.repo}`;
  $("trust-everything").checked = false;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => {
        if (dialog.returnValue !== "run") return resolve(false);
        if ($("trust-everything").checked) store.set(KEYS.trustAll, true);
        else
          store.set(KEYS.trusted, [
            ...new Set([...store.get(KEYS.trusted, []), key]),
          ]);
        resolve(true);
      },
      { once: true },
    );
  });
}

// Recent previews

function addRecent(target) {
  const url = sourceURL(target);
  const entry = {
    url,
    ref: target.ref,
    repo: `${target.owner}/${target.repo}`,
    path: target.path,
  };
  const list = store.get(KEYS.recent, []).filter((item) => item.url !== url);
  store.set(KEYS.recent, [entry, ...list].slice(0, 8));
  renderRecent();
}

function renderRecent() {
  const list = store.get(KEYS.recent, []);
  $("recent").hidden = !list.length;
  $("recent-list").replaceChildren(
    ...list.map((item) => {
      const li = document.createElement("li");
      const open = document.createElement("button");
      open.type = "button";
      open.className = "recent-open";
      open.title = item.url;
      const path = document.createElement("strong");
      path.textContent = item.path;
      const repo = document.createElement("span");
      repo.textContent = item.repo;
      open.append(path, repo);
      open.addEventListener("click", () => {
        $("source").value = item.url;
        start(item.url, item.ref);
      });
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "icon";
      remove.title = "Remove";
      remove.innerHTML =
        '<svg><use href="#i-close" /></svg><span class="sr-only">Remove</span>';
      remove.addEventListener("click", () => {
        store.set(
          KEYS.recent,
          store.get(KEYS.recent, []).filter((entry) => entry.url !== item.url),
        );
        renderRecent();
      });
      li.append(open, remove);
      return li;
    }),
  );
}

// Preview lifecycle

function disconnect() {
  if (handshake) window.removeEventListener("message", handshake);
  handshake = null;
  bridgePort?.close();
  bridgePort = null;
  currentFrame?.remove();
  currentFrame = null;
}

function close() {
  generation++;
  disconnect();
  session?.controller.abort();
  session?.preview?.dispose();
  session?.github.dispose();
  session = null;
  $("share").hidePopover?.();
  $("warnings").hidden = true;
  document.title = "Siteview";
  view("home");
  busy(false);
}

function goHome() {
  close();
  status("");
  history.replaceState(null, "", location.pathname + location.search);
  $("source").value = "";
  $("source").focus();
}

function updateLinks(target) {
  $("dev-url").value = shareURL(location.href, target);
  $("pinned-url").value = shareURL(location.href, target, target.sha);
  $("github-link").href = sourceURL(target);
  $("filename").textContent = target.path;
  $("filename").title = target.path;
  $("commit").textContent = target.sha.slice(0, 7);
  $("source").value = sourceURL(target);
  document.title = `${target.path} · Siteview`;
  history.replaceState(null, "", shareURL(location.href, target));
}

async function render(path) {
  const active = session;
  const id = ++generation;
  busy(true);
  disconnect();
  active.preview?.dispose();
  // The sandbox starts loading now and receives each file as soon as it is
  // ready, so its setup overlaps the build instead of following it.
  const outbox = [];
  let send = (message) => outbox.push(message);
  const preview = new Preview(active.github, (message) => send(message));
  active.preview = preview;
  try {
    const frame = document.createElement("iframe");
    // Do not add allow-same-origin. Repository scripts must not inherit the app's origin.
    frame.setAttribute("sandbox", "allow-scripts");
    frame.setAttribute("referrerpolicy", "no-referrer");
    frame.setAttribute("title", `Preview of ${path}`);
    let connected = false;
    handshake = (event) => {
      if (
        event.source !== frame.contentWindow ||
        event.data !== "siteview:ready" ||
        connected
      )
        return;
      connected = true;
      window.removeEventListener("message", handshake);
      const channel = new MessageChannel();
      bridgePort = channel.port1;
      let pending = 0;
      bridgePort.onmessage = async ({ data }) => {
        if (!data || session !== active || id !== generation) return;
        if (data.kind === "open") {
          if (typeof data.url !== "string" || data.url.length > 2048) return;
          let url;
          try {
            url = new URL(data.url);
          } catch {
            return;
          }
          if (!["https:", "http:"].includes(url.protocol)) return;
          const now = Date.now();
          if (now - (active.lastOpen || 0) < 500) return;
          active.lastOpen = now;
          window.open(url.href, "_blank", "noopener,noreferrer");
          return;
        }
        if (typeof data.path !== "string" || data.path.length > 4096) return;
        const next = data.path.endsWith("/")
          ? data.path + "index.html"
          : data.path;
        if (data.kind === "prefetch") {
          active.prefetched ??= new Set();
          if (active.prefetched.has(next) || !active.github.canPrefetch())
            return;
          active.prefetched.add(next);
          // Warm the file cache for a likely navigation; the result is discarded.
          new Preview(active.github).build(next).catch(() => {});
          return;
        }
        if (data.kind === "navigate") {
          if (pending) return;
          await render(next);
          return;
        }
        if (data.kind !== "fetch" || !Number.isSafeInteger(data.id)) return;
        const port = channel.port1;
        if (pending >= 8) {
          port.postMessage({
            id: data.id,
            error: "Too many concurrent file requests.",
          });
          return;
        }
        pending++;
        try {
          const file = await active.github.file(data.path);
          if (session === active && id === generation)
            port.postMessage({
              id: data.id,
              bytes: file.bytes,
              type: file.type,
            });
        } catch (error) {
          port.postMessage({
            id: data.id,
            error:
              error.name === "AbortError" ? "Preview closed." : error.message,
          });
        } finally {
          pending--;
        }
      };
      frame.contentWindow.postMessage("siteview:connect", "*", [channel.port2]);
      send = (message) => channel.port1.postMessage(message);
      for (const message of outbox.splice(0)) send(message);
    };
    window.addEventListener("message", handshake);
    currentFrame = frame;
    frame.srcdoc = preview.shell(path);
    $("frame-host").replaceChildren(frame);
    const page = await preview.build(path);
    if (session !== active || id !== generation) {
      preview.dispose();
      return;
    }
    send(page);
    active.target.path = path;
    updateLinks(active.target);
    view("preview");
    if (document.activeElement === $("source")) $("source").blur();
    $("warnings").textContent = [...preview.warnings].join(" ");
    $("warnings").hidden = !preview.warnings.size;
    status("");
    return true;
  } catch (error) {
    if (session !== active || id !== generation) return;
    disconnect();
    preview.dispose();
    view("home");
    status(
      error.name === "AbortError" ? "Loading canceled." : error.message,
      error.name !== "AbortError",
    );
  } finally {
    if (id === generation) busy(false);
  }
}

async function start(source, ref = $("ref").value) {
  let input;
  try {
    input = parseGitHubURL(source, ref);
  } catch (error) {
    status(error.message, true);
    return;
  }
  if (!(await trust(input))) return;
  close();
  const controller = new AbortController();
  const github = new GitHub($("token").value, controller.signal);
  const active = { github, controller };
  session = active;
  busy(true);
  status("");
  try {
    active.target = await github.resolve(input);
    if (session !== active) return;
    if (await render(active.target.path)) addRecent(active.target);
  } catch (error) {
    if (session !== active) return;
    if (
      error.name !== "AbortError" &&
      (error.status === 401 ||
        error.status === 403 ||
        (error.status === 404 && !active.github.token))
    )
      openSettings(true);
    status(
      error.name === "AbortError" ? "Loading canceled." : error.message,
      error.name !== "AbortError",
    );
    busy(false);
  }
}

// Events

$("form").addEventListener("submit", (event) => {
  event.preventDefault();
  start($("source").value);
});
// Pasting a GitHub URL over the whole field previews it right away.
$("source").addEventListener("paste", () => {
  const field = $("source");
  const whole =
    !field.value ||
    (field.selectionStart === 0 && field.selectionEnd === field.value.length);
  if (!whole) return;
  setTimeout(() => {
    try {
      parseGitHubURL(field.value);
    } catch {
      return;
    }
    field.form.requestSubmit();
  });
});
$("cancel").addEventListener("click", () => {
  close();
  status("Loading canceled.");
});
$("reload").addEventListener("click", () => {
  if (session?.target) start(sourceURL(session.target), session.target.ref);
});
$("close").addEventListener("click", goHome);
$("settings-button").addEventListener("click", () => openSettings());
$("settings-link").addEventListener("click", () => openSettings(true));
$("token").addEventListener("input", () => {
  updateTokenLabel();
  saveToken();
});
$("remember-token").addEventListener("change", saveToken);
$("clear-token").addEventListener("click", () => {
  const open = Boolean(session);
  close();
  $("token").value = "";
  saveToken();
  updateTokenLabel();
  $("token").focus();
  status(open ? "Token cleared. Preview closed." : "Token cleared.");
});
$("trust-all").addEventListener("change", () => {
  store.set(KEYS.trustAll, $("trust-all").checked || null);
});
$("forget-trusted").addEventListener("click", () => {
  store.set(KEYS.trusted, null);
  updateTrustSummary();
});
$("clear-recent").addEventListener("click", () => {
  store.set(KEYS.recent, null);
  renderRecent();
});
for (const button of document.querySelectorAll("[data-copy]"))
  button.addEventListener("click", async () => {
    const field = $(button.dataset.copy);
    try {
      await navigator.clipboard.writeText(field.value);
      button.textContent = "Copied";
      setTimeout(() => {
        button.textContent = "Copy";
      }, 1400);
    } catch {
      field.focus();
      field.select();
    }
  });
// Popovers open in the top layer; anchor the share menu under its button.
$("share").addEventListener("beforetoggle", (event) => {
  if (event.newState !== "open") return;
  const rect = $("share-button").getBoundingClientRect();
  $("share").style.top = `${rect.bottom + 6}px`;
  $("share").style.right = `${Math.max(8, innerWidth - rect.right)}px`;
});
window.addEventListener("keydown", (event) => {
  if (document.querySelector("dialog[open]")) return;
  const typing = event.target.closest?.("input, textarea, [contenteditable]");
  if (event.key === "/" && !typing) {
    event.preventDefault();
    $("source").focus();
    $("source").select();
  }
  if (event.key === "Escape" && document.body.hasAttribute("data-busy")) {
    close();
    status("Loading canceled.");
  }
});

// Share links

function readLink() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has("url")) return;
  $("source").value = params.get("url");
  // Shared links ask before running a repository the user has not trusted.
  start(params.get("url"), params.get("ref") || "");
}
// Do not restore a previous URL from browser form state. Browsers refill
// id-keyed inputs on reload and back-navigation even with autocomplete=off.
function clearRestoredForm() {
  if (session || location.hash.startsWith("#url=")) return;
  $("source").value = "";
  $("ref").value = "";
}
restoreToken();
renderRecent();
clearRestoredForm();
readLink();
window.addEventListener("pageshow", (event) => {
  clearRestoredForm();
  restoreToken();
  if (event.persisted) readLink();
});
window.addEventListener("hashchange", () => {
  if (location.hash.startsWith("#url=")) readLink();
});
window.addEventListener("pagehide", () => {
  close();
  $("token").value = "";
});
