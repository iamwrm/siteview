import { test, expect } from "@playwright/test";

const SHA = "a".repeat(40);
const files = {
  "site/index.html": `<!doctype html><link rel="stylesheet" href="./styles.css"><h1>Private demo</h1><img src="./dot.svg"><img id="via-module"><a href="./next.html">Next</a><script src="./classic.js"></script><script type="module" src="./main.js"></script>`,
  "site/styles.css":
    '@import "./theme.css"; h1 { color: rgb(100, 20, 200); } body {background-image:url(./dot.svg)}',
  "site/theme.css": "h1 { font-size: 32px; }",
  "site/dot.svg":
    '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>',
  "site/classic.js": `document.body.dataset.classic = 'yes'; fetch('./data.json').then(r=>r.json()).then(d=>document.body.dataset.fetch=d.message); try {parent.document.body.dataset.pwned='yes'} catch {document.body.dataset.isolated='yes'}; try {localStorage.setItem('pwned','yes')} catch {document.body.dataset.storage='blocked'}`,
  "site/main.js": `import { message } from './module.js'; import { value } from './cycle-a.js'; document.body.dataset.cycle=value; document.body.dataset.module=message; import('./dynamic.js').then(d=>document.body.dataset.dynamic=d.message); document.querySelector('#via-module').src = new URL('./dot.svg', import.meta.url).href; const worker = new Worker(URL.createObjectURL(new Blob(["self.onmessage = () => self.postMessage('worker works')"], { type: 'text/javascript' }))); worker.onmessage = e => document.body.dataset.worker = e.data; worker.postMessage(1);`,
  "site/cycle-a.js": `import { b } from './cycle-b.js'; export function a(){ return 'a'; } export const value = b();`,
  "site/cycle-b.js": `import { a } from './cycle-a.js'; export function b(){ return a() + 'b'; }`,
  "site/module.js": `export const message='modules work';`,
  "site/dynamic.js": `export const message='dynamic works';`,
  "site/data.json": '{"message":"fetch works"}',
  "site/next.html": '<h1>Second page</h1><a href="./index.html">Back</a>',
  "site/cyclic.html": `<link rel="stylesheet" href="./cycle-root.css"><h1>Cyclic</h1>`,
  "site/cycle-root.css": '@import "./cycle-x.css"; @import "./cycle-y.css";',
  "site/cycle-x.css": '@import "./cycle-y.css";',
  "site/cycle-y.css": '@import "./cycle-x.css";',
  "site/life.html": `<!doctype html><link rel="stylesheet" href="./big.css"><h1>Life</h1><script>window.order = ["inline"]; document.addEventListener("DOMContentLoaded", () => { document.body.dataset.ready = document.readyState; window.order.push("ready"); }); addEventListener("load", () => { document.body.dataset.loaded = "yes"; document.body.dataset.order = window.order.join(","); }); addEventListener("securitypolicyviolation", (e) => { document.body.dataset.csp = e.violatedDirective; });</script><script src="./order.js"></script><script defer src="./deferred.js"></script><script type="module" src="./utf.js"></script>`,
  "site/order.js": `window.order.push("classic");`,
  "site/deferred.js": `window.order.push("defer");`,
  "site/utf.js": `document.body.dataset.utf = "héllo ✓"; new Image().src = "http://127.0.0.1:9/blocked.png";`,
  "site/big.css": `/* ${"x".repeat(300000)} */ h1 { color: rgb(1, 2, 3); }`,
  "site/framed.html": `<!doctype html><h1>Outer</h1><iframe id="inline" srcdoc="&lt;h2&gt;Inner&lt;/h2&gt;&lt;script&gt;try{parent.document.body.dataset.pwned='yes'}catch{}&lt;/script&gt;"></iframe><iframe id="remote" src="https://example.com/"></iframe>`,
  "docs/README.md": [
    "# Project docs",
    "",
    "Intro with **bold** and `code`.",
    "",
    "![logo](./logo.svg)",
    "",
    "```js",
    "const answer = 42;",
    "```",
    "",
    "| name | value |",
    "| --- | ---: |",
    "| one | 1 |",
    "",
    "- [x] shipped",
    "- [ ] pending",
    "",
    "Read [the guide](./guide.md).",
    "",
    "<script>document.body.dataset.pwned = 'md'</script>",
  ].join("\n"),
  "docs/logo.svg":
    '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12"><circle cx="6" cy="6" r="6" fill="green"/></svg>',
  "docs/guide.md": "# Guide\n\nBack to [README](./README.md).",
};

async function mockGitHub(page, options = {}) {
  const requests = [];
  await page.route("https://api.github.com/**", async (route) => {
    const request = route.request();
    requests.push({
      url: request.url(),
      auth: request.headers().authorization,
    });
    const url = new URL(request.url());
    const path = decodeURIComponent(url.pathname);
    if (options.fail)
      return route.fulfill({
        status: options.fail,
        json: { message: "private details must not be shown" },
      });
    if (path.includes("/git/matching-refs/heads/"))
      return route.fulfill({
        json: [{ ref: "refs/heads/main" }, { ref: "refs/heads/feature/demo" }],
      });
    if (path.includes("/git/matching-refs/tags/"))
      return route.fulfill({ json: [] });
    if (path.includes("/commits/"))
      return route.fulfill({ json: { sha: SHA } });
    const file = path.split("/contents/")[1];
    if (files[file] !== undefined)
      return route.fulfill({
        contentType: "application/octet-stream",
        body: files[file],
      });
    return route.fulfill({ status: 404, json: { message: "Not Found" } });
  });
  return requests;
}

const INDEX = "https://github.com/alice/private/blob/main/site/index.html";
const frameOf = (page) => page.frameLocator("#frame-host iframe");

async function setToken(page, token, remember = false) {
  await page.locator("#settings-button").click();
  await page.locator("#token").fill(token);
  if (remember) await page.locator("#remember-token").check();
  await page.getByRole("button", { name: "Done" }).click();
}

async function submit(page, url) {
  await page.locator("#source").fill(url);
  await page.locator("#source").press("Enter");
}

async function run(page) {
  await expect(page.locator("#trust")).toBeVisible();
  await page.locator("#trust-run").click();
}

// Opens the app, optionally sets a token, previews a file and trusts its repo.
async function start(page, token = "", url = INDEX) {
  await page.goto("/");
  if (token) await setToken(page, token);
  await submit(page, url);
  await run(page);
}

test("private preview rewrites CSS, images, ES modules, dynamic imports and fetch in an opaque sandbox", async ({
  page,
}) => {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  const requests = await mockGitHub(page);
  await start(page, "github_pat_TEST_NOT_A_REAL_TOKEN");
  const frame = frameOf(page);
  await expect(frame.locator("h1")).toHaveText("Private demo");
  await expect(frame.locator("h1")).toHaveCSS("color", "rgb(100, 20, 200)");
  const body = frame.locator("body");
  await expect(body).toHaveAttribute("data-classic", "yes");
  await expect(body).toHaveAttribute("data-module", "modules work");
  await expect(body).toHaveAttribute("data-dynamic", "dynamic works");
  await expect(body).toHaveAttribute("data-cycle", "ab");
  await expect(body).toHaveAttribute("data-worker", "worker works");
  await expect(body).toHaveAttribute("data-fetch", "fetch works");
  await expect(body).toHaveAttribute("data-isolated", "yes");
  await expect(body).toHaveAttribute("data-storage", "blocked");
  for (const image of [
    frame.locator("img").first(),
    frame.locator("#via-module"),
  ])
    expect(
      await image.evaluate((img) => img.complete && img.naturalWidth > 0),
    ).toBe(true);
  expect(await page.locator("body").getAttribute("data-pwned")).toBeNull();
  expect(await page.locator("#frame-host iframe").getAttribute("sandbox")).toBe(
    "allow-scripts",
  );
  expect(
    requests.every((r) => r.auth === "Bearer github_pat_TEST_NOT_A_REAL_TOKEN"),
  ).toBe(true);
  expect(
    requests
      .filter((r) => r.url.includes("/contents/"))
      .every((r) => r.url.endsWith(`?ref=${SHA}`)),
  ).toBe(true);
  expect(
    await page.locator("#frame-host iframe").getAttribute("srcdoc"),
  ).not.toContain("github_pat");
  expect(page.url()).not.toContain("github_pat");
  expect(await page.locator("#dev-url").inputValue()).not.toContain(
    "github_pat",
  );
  expect(await page.locator("#pinned-url").inputValue()).toContain(SHA);
  // Without "Remember", the token is never written to storage.
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain("github_pat");
  expect(errors).toEqual([]);
  await frame.getByText("Next", { exact: true }).click();
  await expect(frameOf(page).locator("h1")).toHaveText("Second page");
  await expect(page.locator("#filename")).toHaveText("site/next.html");
  await page.locator("#settings-button").click();
  await page.locator("#clear-token").click();
  await expect(page.locator("#token")).toHaveValue("");
  await expect(page.locator("#settings-button")).toHaveAttribute(
    "data-token",
    "false",
  );
  await expect(page.locator("#viewer")).toBeHidden();
  await expect(page.locator("#status")).toHaveText(
    "Token cleared. Preview closed.",
  );
});

test("public preview omits Authorization; shared links ask before running an untrusted repo", async ({
  page,
}) => {
  const requests = await mockGitHub(page);
  await start(page);
  await expect(page.locator("#viewer")).toBeVisible();
  expect(requests.every((r) => r.auth === undefined)).toBe(true);
  await expect(page.locator("#settings-button")).toHaveAttribute(
    "data-token",
    "false",
  );
  const share = await page.locator("#dev-url").inputValue();
  await page.evaluate(() => localStorage.removeItem("siteview:trusted"));
  await page.goto(share);
  await page.reload();
  const count = requests.length;
  await expect(page.locator("#source")).toHaveValue(INDEX);
  await expect(page.locator("#trust")).toBeVisible();
  await expect(page.locator("#trust-repo")).toHaveText("alice/private");
  await page.locator("#trust").getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator("#viewer")).toBeHidden();
  expect(requests.length).toBe(count);
  // A trusted repository opens straight from a shared link.
  await page.evaluate(() =>
    localStorage.setItem("siteview:trusted", '["alice/private"]'),
  );
  await page.reload();
  await expect(frameOf(page).locator("h1")).toHaveText("Private demo");
  await expect(page.locator("#trust")).toBeHidden();
});

test("trust is asked once per repository, or never once everything is trusted", async ({
  page,
}) => {
  await mockGitHub(page);
  await start(page);
  await expect(frameOf(page).locator("h1")).toHaveText("Private demo");
  await page.locator("#close").click();
  await submit(page, INDEX);
  await expect(frameOf(page).locator("h1")).toHaveText("Private demo");
  await expect(page.locator("#trust")).toBeHidden();
  await page.locator("#close").click();
  await submit(page, "https://github.com/bob/other/blob/main/site/index.html");
  await expect(page.locator("#trust-repo")).toHaveText("bob/other");
  await page.locator("#trust-everything").check();
  await page.locator("#trust-run").click();
  await expect(frameOf(page).locator("h1")).toHaveText("Private demo");
  await page.locator("#close").click();
  await submit(
    page,
    "https://github.com/carol/third/blob/main/site/index.html",
  );
  await expect(frameOf(page).locator("h1")).toHaveText("Private demo");
  await expect(page.locator("#trust")).toBeHidden();
  await page.locator("#settings-button").click();
  await expect(page.locator("#trust-all")).toBeChecked();
  await page.locator("#trust-all").uncheck();
  await page.locator("#forget-trusted").click();
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator("#close").click();
  await submit(page, INDEX);
  await expect(page.locator("#trust")).toBeVisible();
});

test("recent previews reopen in one click", async ({ page }) => {
  await mockGitHub(page);
  await start(page);
  await expect(frameOf(page).locator("h1")).toHaveText("Private demo");
  await page.locator("#close").click();
  await expect(page.locator("#recent-list li")).toHaveCount(1);
  await page.reload();
  await page.locator(".recent-open").click();
  await expect(frameOf(page).locator("h1")).toHaveText("Private demo");
  await page.locator("#close").click();
  await page.locator("#clear-recent").click();
  await expect(page.locator("#recent")).toBeHidden();
});

test("pasting a GitHub URL starts the preview", async ({ page }) => {
  await mockGitHub(page);
  await page.goto("/");
  await page.locator("#source").focus();
  // Simulate a paste into the empty field; the browser inserts the text.
  await page.evaluate((url) => {
    const input = document.querySelector("#source");
    input.dispatchEvent(new Event("paste", { bubbles: true }));
    input.value = url;
  }, INDEX);
  await run(page);
  await expect(frameOf(page).locator("h1")).toHaveText("Private demo");
});

for (const code of [401, 403, 404, 429, 500])
  test(`handles GitHub ${code} without leaking response details`, async ({
    page,
  }) => {
    await mockGitHub(page, { fail: code });
    await start(page, "github_pat_TEST_NOT_A_REAL_TOKEN");
    await expect(page.locator("#status")).toHaveAttribute("data-error", "true");
    await expect(page.locator("#status")).not.toContainText("private details");
    await expect(page.locator("#go")).toBeEnabled();
  });

test("missing token on a private repo opens Settings and focuses the token", async ({
  page,
}) => {
  await mockGitHub(page, { fail: 404 });
  await start(page);
  await expect(page.locator("#settings")).toBeVisible();
  await expect(page.locator("#token")).toBeFocused();
  await expect(page.locator("#status")).toContainText("If it is private");
});

test("slash branches resolve to longest matching branch", async ({ page }) => {
  const requests = await mockGitHub(page);
  await start(
    page,
    "",
    "https://github.com/alice/private/blob/feature/demo/site/index.html",
  );
  await expect(page.locator("#viewer")).toBeVisible();
  expect(requests.some((r) => r.url.includes("/commits/feature%2Fdemo"))).toBe(
    true,
  );
});

test("works under a GitHub Pages project subdirectory", async ({ page }) => {
  await page.route("http://127.0.0.1:5173/project/**", async (route) => {
    const response = await route.fetch({
      url: route.request().url().replace("/project/", "/"),
    });
    await route.fulfill({ response });
  });
  await mockGitHub(page);
  await page.goto("/project/");
  await submit(page, INDEX);
  await run(page);
  await expect(frameOf(page).locator("h1")).toHaveText("Private demo");
  expect(new URL(await page.locator("#dev-url").inputValue()).pathname).toBe(
    "/project/",
  );
  await expect(page.locator("#home")).toBeHidden();
  expect((await page.locator(".bar").boundingBox()).height).toBeLessThan(60);
  await expect(page.locator("#github-link")).toHaveAttribute(
    "href",
    "https://github.com/alice/private/blob/main/site/index.html",
  );
  expect((await page.locator("#source").boundingBox()).width).toBeGreaterThan(
    300,
  );
  expect(
    await page.locator('link[rel="stylesheet"]').getAttribute("href"),
  ).toBe("./style.css?v=12");
  expect(await page.locator('script[type="module"]').getAttribute("src")).toBe(
    "./app.js?v=12",
  );
  const dimensions = await page
    .locator("#frame-host iframe")
    .evaluate((frame) => {
      const rect = frame.getBoundingClientRect();
      return {
        height: rect.height,
        bottom: rect.bottom,
        viewport: innerHeight,
        pageHeight: document.documentElement.scrollHeight,
      };
    });
  expect(dimensions.height).toBeGreaterThan(dimensions.viewport * 0.85);
  expect(dimensions.bottom).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.pageHeight).toBe(dimensions.viewport);
  await page.locator("#share-button").click();
  await expect(page.locator("#dev-url")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#dev-url")).toBeHidden();
  await page.screenshot({ path: "test-results/desktop.png" });
});

test("cancel aborts a pending API request and clears the busy state", async ({
  page,
}) => {
  let requested;
  const began = new Promise((resolve) => {
    requested = resolve;
  });
  await page.route("https://api.github.com/**", () => {
    requested();
  });
  await start(page);
  await began;
  await page.locator("#cancel").click();
  await expect(page.locator("#status")).toHaveText("Loading canceled.");
  await expect(page.locator("#go")).toBeEnabled();
  await expect(page.locator("#viewer")).toBeHidden();
});

test("clears a URL restored by browser form state", async ({ page }) => {
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      document.querySelector("#source").value =
        "https://github.com/iamwrm/agent-doc-drive/blob/main/index.html";
    });
  });
  await page.goto("/");
  await expect(page.locator("#source")).toHaveValue("");
});

test("markdown renders as a page with relative images, links, and escaped HTML", async ({
  page,
}) => {
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await mockGitHub(page);
  await start(
    page,
    "",
    "https://github.com/alice/private/blob/main/docs/README.md",
  );
  const frame = frameOf(page);
  await expect(frame.locator("h1")).toHaveText("Project docs");
  await expect(frame.locator("strong")).toHaveText("bold");
  await expect(frame.locator("pre code")).toContainText("const answer = 42;");
  await expect(frame.locator("table th").first()).toHaveText("name");
  await expect(frame.locator('input[type="checkbox"]').first()).toBeChecked();
  expect(
    await frame
      .locator("img")
      .evaluate((img) => img.complete && img.naturalWidth > 0),
  ).toBe(true);
  await expect(frame.locator("body")).not.toHaveAttribute("data-pwned");
  expect(await frame.locator("article").innerHTML()).toContain(
    "&lt;script&gt;document.body.dataset.pwned",
  );
  await frame.getByText("the guide").click();
  await expect(frameOf(page).locator("h1")).toHaveText("Guide");
  await expect(page.locator("#filename")).toHaveText("docs/guide.md");
  expect(errors).toEqual([]);
});

test("external markdown links open in a new tab instead of replacing the app", async ({
  page,
}) => {
  await page.route("https://api.github.com/**", async (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path.includes("/git/matching-refs/"))
      return route.fulfill({ json: [{ ref: "refs/heads/main" }] });
    if (path.includes("/commits/"))
      return route.fulfill({ json: { sha: SHA } });
    return route.fulfill({
      contentType: "text/markdown",
      body: "# Links\n\n[Example](https://example.com/page)\n",
    });
  });
  await page.route("https://example.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "external" }),
  );
  await start(
    page,
    "",
    "https://github.com/alice/private/blob/main/docs/links.md",
  );
  await expect(frameOf(page).locator("h1")).toHaveText("Links");
  const popupPromise = page.waitForEvent("popup");
  const before = page.url();
  await frameOf(page).getByText("Example").click();
  const popup = await popupPromise;
  await popup.waitForLoadState("domcontentloaded");
  expect(popup.url()).toBe("https://example.com/page");
  expect(page.url()).toBe(before);
});

test("mobile layout fits the viewport and renders without a build step", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    375,
  );
  const form = await page.locator("#form").boundingBox();
  expect(form.x).toBeGreaterThanOrEqual(0);
  expect(form.x + form.width).toBeLessThanOrEqual(375);
  await expect(page.locator("#go")).toBeVisible();
  await page.screenshot({ path: "test-results/mobile.png" });
  await mockGitHub(page);
  await start(page);
  await expect(frameOf(page).locator("h1")).toHaveText("Private demo");
  const layout = await page.locator("#frame-host iframe").evaluate((frame) => ({
    height: frame.clientHeight,
    viewport: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.height).toBeGreaterThan(layout.viewport * 0.85);
  expect(layout.scrollWidth).toBe(375);
  await page.screenshot({ path: "test-results/mobile-preview.png" });
});

test("srcdoc iframes render in their own sandbox and src iframes are removed", async ({
  page,
}) => {
  await mockGitHub(page);
  await start(
    page,
    "",
    "https://github.com/alice/private/blob/main/site/framed.html",
  );
  const outer = frameOf(page);
  await expect(outer.locator("h1")).toHaveText("Outer");
  await expect(outer.frameLocator("#inline").locator("h2")).toHaveText("Inner");
  await expect(outer.locator("#remote")).toHaveCount(0);
  await expect(outer.locator("#inline")).toHaveAttribute(
    "sandbox",
    "allow-scripts",
  );
  expect(await page.locator("body").getAttribute("data-pwned")).toBeNull();
});

test("circular CSS imports loaded in parallel fail instead of hanging", async ({
  page,
}) => {
  await mockGitHub(page);
  await start(
    page,
    "",
    "https://github.com/alice/private/blob/main/site/cyclic.html",
  );
  await expect(page.locator("#status")).toContainText("Circular CSS import");
  await expect(page.locator("#go")).toBeEnabled();
});

test("hovering an internal link loads that page before the click", async ({
  page,
}) => {
  const requests = await mockGitHub(page);
  await start(page);
  const frame = frameOf(page);
  await expect(frame.locator("h1")).toHaveText("Private demo");
  const next = () =>
    requests.filter((r) => r.url.includes("/contents/site/next.html")).length;
  expect(next()).toBe(0);
  await frame.getByText("Next", { exact: true }).hover();
  await expect.poll(next).toBe(1);
  await frame.getByText("Next", { exact: true }).click();
  await expect(frame.locator("h1")).toHaveText("Second page");
  expect(next()).toBe(1);
});

test("streamed documents keep lifecycle events, script order, CSP, UTF-8 and large files", async ({
  page,
}) => {
  await mockGitHub(page);
  await start(
    page,
    "",
    "https://github.com/alice/private/blob/main/site/life.html",
  );
  const frame = frameOf(page);
  const body = frame.locator("body");
  await expect(body).toHaveAttribute("data-loaded", "yes");
  await expect(body).toHaveAttribute("data-ready", "interactive");
  await expect(body).toHaveAttribute(
    "data-order",
    "inline,classic,defer,ready",
  );
  await expect(body).toHaveAttribute("data-utf", "héllo ✓");
  await expect(body).toHaveAttribute("data-csp", /img-src/);
  await expect(frame.locator("h1")).toHaveCSS("color", "rgb(1, 2, 3)");
});

test("a remembered token survives reloads until cleared or unchecked", async ({
  page,
}) => {
  const requests = await mockGitHub(page);
  const token = page.locator("#settings-button");
  await page.goto("/");
  await setToken(page, "github_pat_REMEMBERED");
  await page.reload();
  await expect(token).toHaveAttribute("data-token", "false");
  await setToken(page, "github_pat_REMEMBERED", true);
  await page.reload();
  await expect(token).toHaveAttribute("data-token", "true");
  await submit(page, INDEX);
  await run(page);
  await expect(frameOf(page).locator("h1")).toHaveText("Private demo");
  expect(requests.every((r) => r.auth === "Bearer github_pat_REMEMBERED")).toBe(
    true,
  );
  await token.click();
  await expect(page.locator("#token")).toHaveValue("github_pat_REMEMBERED");
  await page.locator("#remember-token").uncheck();
  await page.getByRole("button", { name: "Done" }).click();
  await page.reload();
  await expect(token).toHaveAttribute("data-token", "false");
  await setToken(page, "github_pat_REMEMBERED", true);
  await token.click();
  await page.locator("#clear-token").click();
  await page.reload();
  await expect(token).toHaveAttribute("data-token", "false");
  expect(
    await page.evaluate(() => localStorage.getItem("siteview:token")),
  ).toBeNull();
});

test("keyboard: slash focuses the URL field and Escape cancels loading", async ({
  page,
}) => {
  await page.route("https://api.github.com/**", () => {});
  await page.goto("/");
  await page.locator("body").click();
  await page.keyboard.press("/");
  await expect(page.locator("#source")).toBeFocused();
  await submit(page, INDEX);
  await run(page);
  await expect(page.locator("#cancel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#status")).toHaveText("Loading canceled.");
});
