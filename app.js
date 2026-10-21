import { parseGitHubURL, sourceURL, shareURL } from "./core.js?v=10";
import { GitHub } from "./github.js?v=10";
import { Preview } from "./preview.js?v=10";

const $ = (id) => document.getElementById(id);
let session;
let generation = 0;
let bridgePort;
let handshake;
let currentFrame;

function status(message, error = false) {
  $("status").hidden = !message;
  $("status").textContent = message;
  $("status").dataset.error = String(error);
}

function updateTokenLabel() {
  const set = Boolean($("token").value);
  $("token-summary").dataset.token = String(set);
  $("token-summary").setAttribute(
    "aria-label",
    set ? "Token, set" : "Token, not set",
  );
  $("token-summary").title = set
    ? "Token is set for this tab"
    : "Private repository token and preview settings";
}

function busy(value) {
  $("preview-button").disabled = value;
  $("preview-button").textContent = value ? "Loading…" : "Preview ↗";
  $("cancel").hidden = !value;
}

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
  $("viewer").hidden = true;
  $("empty-state").hidden = false;
  $("github-link").hidden = true;
  $("results").hidden = true;
  $("results").open = false;
  $("viewer").classList.remove("expanded");
  $("expand").textContent = "Expand";
  busy(false);
}

function updateLinks(target) {
  $("dev-url").value = shareURL(location.href, target);
  $("pinned-url").value = shareURL(location.href, target, target.sha);
  $("github-link").href = sourceURL(target);
  $("github-link").hidden = false;
  $("filename").textContent = target.path;
  $("commit").textContent = target.sha.slice(0, 7);
  $("results").hidden = false;
  history.replaceState(null, "", shareURL(location.href, target));
}

async function render(path) {
  const active = session;
  const id = ++generation;
  busy(true);
  disconnect();
  active.preview?.dispose();
  const preview = new Preview(active.github);
  active.preview = preview;
  try {
    const html = await preview.build(path);
    if (session !== active || id !== generation) {
      preview.dispose();
      return;
    }
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
        if (data.kind === "navigate") {
          if (pending) return;
          const next = data.path.endsWith("/")
            ? data.path + "index.html"
            : data.path;
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
    };
    window.addEventListener("message", handshake);
    currentFrame = frame;
    frame.srcdoc = html;
    $("frame-host").replaceChildren(frame);
    active.target.path = path;
    updateLinks(active.target);
    $("viewer").hidden = false;
    $("empty-state").hidden = true;
    $("options").open = false;
    $("warnings").textContent = [...preview.warnings].join(" ");
    $("warnings").hidden = !preview.warnings.size;
    status("");
  } catch (error) {
    if (session !== active || id !== generation) return;
    preview.dispose();
    $("viewer").hidden = true;
    $("empty-state").hidden = false;
    $("github-link").hidden = true;
    status(
      error.name === "AbortError" ? "Loading canceled." : error.message,
      error.name !== "AbortError",
    );
  } finally {
    if (id === generation) busy(false);
  }
}

$("preview-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  let input;
  try {
    input = parseGitHubURL($("source").value, $("ref").value);
  } catch (error) {
    status(error.message, true);
    return;
  }
  if (!$("trust").checked) {
    $("options").open = true;
    status(
      "Check “I trust this repo's scripts” under Token before previewing.",
      true,
    );
    return;
  }
  close();
  const controller = new AbortController();
  const github = new GitHub($("token").value, controller.signal);
  const active = { github, controller };
  session = active;
  busy(true);
  status("Resolving repository and commit…");
  try {
    active.target = await github.resolve(input);
    if (session !== active) return;
    await render(active.target.path);
  } catch (error) {
    if (session !== active) return;
    if (
      error.name !== "AbortError" &&
      (error.status === 401 ||
        error.status === 403 ||
        (error.status === 404 && !active.github.token))
    ) {
      $("options").open = true;
      $("token").focus();
    }
    status(
      error.name === "AbortError" ? "Loading canceled." : error.message,
      error.name !== "AbortError",
    );
    busy(false);
  }
});

$("cancel").addEventListener("click", () => {
  close();
  status("Loading canceled.");
});
$("token").addEventListener("input", updateTokenLabel);
$("trust").addEventListener("change", () => {
  if (!$("trust").checked) return;
  $("options").open = false;
  status("");
});
$("clear-token").addEventListener("click", () => {
  close();
  $("token").value = "";
  updateTokenLabel();
  $("options").open = true;
  status("Token cleared.");
});
$("reload").addEventListener("click", () => {
  if (session?.target) {
    $("source").value = sourceURL(session.target);
    $("ref").value = session.target.ref;
  }
  $("preview-form").requestSubmit();
});
$("close-preview").addEventListener("click", () => close());
$("expand").addEventListener("click", () => {
  const expanded = $("viewer").classList.toggle("expanded");
  $("expand").textContent = expanded ? "Collapse" : "Expand";
});
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  $("options").open = false;
  $("results").open = false;
  $("viewer").classList.remove("expanded");
  $("expand").textContent = "Expand";
});
for (const [id, other] of [
  ["options", "results"],
  ["results", "options"],
]) {
  $(id).addEventListener("toggle", () => {
    if ($(id).open) $(other).open = false;
  });
}
for (const button of document.querySelectorAll("[data-copy]"))
  button.addEventListener("click", async () => {
    const field = $(button.dataset.copy);
    try {
      await navigator.clipboard.writeText(field.value);
      button.textContent = "Copied!";
      setTimeout(() => {
        button.textContent = "Copy ↗";
      }, 1600);
    } catch {
      field.focus();
      field.select();
    }
  });

function readLink() {
  const params = new URLSearchParams(location.hash.slice(1));
  if (!params.has("url")) return;
  $("source").value = params.get("url");
  $("ref").value = params.get("ref") || "";
  // A shared link never executes repository code until the viewer opts in.
  status(
    "Link loaded. Add a private repo token under Token if needed, confirm trust, then preview.",
  );
}
// Do not restore credentials or consent from browser form-state restoration.
// Do not restore credentials, consent, or a previous URL from browser form state.
// Browsers refill id-keyed inputs on reload and back-navigation even with autocomplete=off.
function clearRestoredForm() {
  if (session || location.hash.startsWith("#url=")) return;
  $("source").value = "";
}
$("token").value = "";
$("trust").checked = false;
updateTokenLabel();
readLink();
clearRestoredForm();
window.addEventListener("pageshow", clearRestoredForm);
window.addEventListener("hashchange", () => {
  if (!location.hash.startsWith("#url=")) return;
  close();
  $("trust").checked = false;
  readLink();
});
window.addEventListener("pagehide", () => {
  close();
  $("token").value = "";
});
