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

async function openAccess(page) {
  await page.locator("#options summary").click();
  await expect(page.locator("#token")).toBeVisible();
}

async function start(page, token = "") {
  await page.goto("/");
  await page
    .locator("#source")
    .fill("https://github.com/alice/private/blob/main/site/index.html");
  await openAccess(page);
  if (token) await page.locator("#token").fill(token);
  await page.locator("#trust").check();
  await page.locator("#preview-button").click();
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
  const frame = page.frameLocator("#frame-host iframe");
  await expect(frame.locator("h1")).toHaveText("Private demo");
  await expect(frame.locator("h1")).toHaveCSS("color", "rgb(100, 20, 200)");
  await expect(frame.locator("body")).toHaveAttribute("data-classic", "yes");
  await expect(frame.locator("body")).toHaveAttribute(
    "data-module",
    "modules work",
  );
  await expect(frame.locator("body")).toHaveAttribute(
    "data-dynamic",
    "dynamic works",
  );
  await expect(frame.locator("body")).toHaveAttribute("data-cycle", "ab");
  await expect(frame.locator("body")).toHaveAttribute(
    "data-worker",
    "worker works",
  );
  await expect(frame.locator("body")).toHaveAttribute(
    "data-fetch",
    "fetch works",
  );
  await expect(frame.locator("body")).toHaveAttribute("data-isolated", "yes");
  await expect(frame.locator("body")).toHaveAttribute(
    "data-storage",
    "blocked",
  );
  expect(
    await frame
      .locator("img")
      .first()
      .evaluate((img) => img.complete && img.naturalWidth > 0),
  ).toBe(true);
  expect(
    await frame
      .locator("#via-module")
      .evaluate((img) => img.complete && img.naturalWidth > 0),
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
  ).not.toContain("github_pat_TEST_NOT_A_REAL_TOKEN");
  expect(page.url()).not.toContain("github_pat");
  expect(await page.locator("#dev-url").inputValue()).not.toContain(
    "github_pat",
  );
  expect(await page.locator("#pinned-url").inputValue()).toContain(SHA);
  expect(
    await page.evaluate(() => localStorage.length + sessionStorage.length),
  ).toBe(0);
  expect(errors).toEqual([]);
  await frame.getByText("Next", { exact: true }).click();
  await expect(
    page.frameLocator("#frame-host iframe").locator("h1"),
  ).toHaveText("Second page");
  await expect(page.locator("#filename")).toHaveText("site/next.html");
  await expect(page.locator("#options")).not.toHaveAttribute("open", "");
  await page.locator("#options summary").click();
  await page.locator("#clear-token").click();
  await expect(page.locator("#token")).toHaveValue("");
  await expect(page.locator("#viewer")).toBeHidden();
  await expect(page.locator("#status")).toHaveText("Token cleared.");
});

test("public preview omits Authorization and share links require opt-in", async ({
  page,
}) => {
  const requests = await mockGitHub(page);
  await start(page);
  await expect(page.locator("#viewer")).toBeVisible();
  expect(requests.every((r) => r.auth === undefined)).toBe(true);
  const share = await page.locator("#dev-url").inputValue();
  const count = requests.length;
  await page.goto(share);
  await page.reload();
  await expect(page.locator("#source")).toHaveValue(
    "https://github.com/alice/private/blob/main/site/index.html",
  );
  await expect(page.locator("#viewer")).toBeHidden();
  expect(requests.length).toBe(count);
  await expect(page.locator("#trust")).not.toBeChecked();
});

for (const code of [401, 403, 404, 429, 500])
  test(`handles GitHub ${code} without leaking response details`, async ({
    page,
  }) => {
    await mockGitHub(page, { fail: code });
    await start(page, "github_pat_TEST_NOT_A_REAL_TOKEN");
    await expect(page.locator("#status")).toHaveAttribute("data-error", "true");
    await expect(page.locator("#status")).not.toContainText("private details");
    await expect(page.locator("#preview-button")).toBeEnabled();
  });

test("slash branches resolve to longest matching branch", async ({ page }) => {
  const requests = await mockGitHub(page);
  await page.goto("/");
  await page
    .locator("#source")
    .fill("https://github.com/alice/private/blob/feature/demo/site/index.html");
  await openAccess(page);
  await page.locator("#trust").check();
  await page.locator("#preview-button").click();
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
  await page
    .locator("#source")
    .fill("https://github.com/alice/private/blob/main/site/index.html");
  await openAccess(page);
  await page.locator("#trust").check();
  await page.locator("#preview-button").click();
  await expect(page.locator("#viewer")).toBeVisible();
  expect(new URL(await page.locator("#dev-url").inputValue()).pathname).toBe(
    "/project/",
  );
  await expect(
    page.frameLocator("#frame-host iframe").locator("h1"),
  ).toHaveText("Private demo");
  await expect(page.locator("#empty-state")).toBeHidden();
  const headerBox = await page.locator(".header").boundingBox();
  expect(headerBox.height).toBeLessThan(60);
  await expect(page.locator(".header")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await expect(page.locator("#github-link")).toBeVisible();
  await expect(page.locator("#github-link")).toHaveText(
    /View source on GitHub/,
  );
  await expect(page.locator(".viewer-footer")).toHaveCount(0);
  expect((await page.locator("#source").boundingBox()).width).toBeGreaterThan(
    300,
  );
  expect(
    await page.locator('link[rel="stylesheet"]').getAttribute("href"),
  ).toBe("./style.css?v=5");
  expect(await page.locator('script[type="module"]').getAttribute("src")).toBe(
    "./app.js?v=5",
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
  expect(dimensions.height).toBeGreaterThan(dimensions.viewport * 0.65);
  expect(dimensions.bottom).toBeLessThanOrEqual(dimensions.viewport);
  expect(dimensions.pageHeight).toBe(dimensions.viewport);
  await expect(page.locator(".hero, .explain, .faq, .result-card")).toHaveCount(
    0,
  );
  await page.locator("#results summary").click();
  await expect(page.locator("#dev-url")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#dev-url")).toBeHidden();
  await page.screenshot({
    path: "test-results/desktop.png",
    fullPage: true,
    animations: "disabled",
  });
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
  await expect(page.locator("#preview-button")).toBeEnabled();
  await expect(page.locator("#viewer")).toBeHidden();
});

test("mobile form fits viewport and renders without a build step", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    375,
  );
  expect((await page.locator(".header").boundingBox()).height).toBeLessThan(
    120,
  );
  await expect(page.locator("#empty-state")).toBeVisible();
  await expect(page.locator("#preview-form")).toBeVisible();
  await page.screenshot({ path: "test-results/mobile.png", fullPage: true });
  await mockGitHub(page);
  await start(page);
  await expect(
    page.frameLocator("#frame-host iframe").locator("h1"),
  ).toHaveText("Private demo");
  const layout = await page.locator("#frame-host iframe").evaluate((frame) => ({
    height: frame.clientHeight,
    viewport: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(layout.height).toBeGreaterThan(layout.viewport * 0.6);
  expect(layout.scrollWidth).toBe(375);
  await page.screenshot({
    path: "test-results/mobile-preview.png",
    fullPage: true,
  });
});
