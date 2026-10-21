import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseGitHubURL,
  chooseRef,
  sourceURL,
  shareURL,
  localPath,
  virtualURL,
  mime,
  applyEdits,
} from "../core.js";
import { GitHub } from "../github.js";

test("all runtime assets use one cache-busting version", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..");
  const names = ["index.html", "app.js", "preview.js", "github.js"];
  const sources = await Promise.all(
    names.map((name) => readFile(join(root, name), "utf8")),
  );
  const versions = new Set(
    sources.flatMap((source) =>
      [...source.matchAll(/[?&]v=(\d+)/g)].map((match) => match[1]),
    ),
  );
  assert.equal(versions.size, 1, "asset version queries must match");
  assert.ok([...versions][0]);
  assert.match(sources[0], /style\.css\?v=\d+/);
  assert.match(sources[0], /app\.js\?v=\d+/);
  for (const source of sources.slice(1)) assert.match(source, /\?v=\d+/);
});

test("GitHub blob and raw URLs normalize to the same target", () => {
  const expected = {
    owner: "alice",
    repo: "demo",
    tail: "main/site/index.html",
    refOverride: "",
  };
  assert.deepEqual(
    parseGitHubURL(
      "https://github.com/alice/demo/blob/main/site/index.html?raw=1#foo",
    ),
    expected,
  );
  assert.deepEqual(
    parseGitHubURL(
      "https://raw.githubusercontent.com/alice/demo/main/site/index.html",
    ),
    expected,
  );
  assert.deepEqual(
    parseGitHubURL("https://github.com/alice/demo/raw/main/site/index.html"),
    expected,
  );
});

test("untrusted hosts, schemes and credentials are rejected", () => {
  for (const url of [
    "http://github.com/a/b/blob/main/index.html",
    "https://github.com.evil.test/a/b/blob/main/index.html",
    "https://api.github.com/a/b",
    "https://github.com/a/b",
    "https://user:pat@github.com/a/b/blob/main/index.html",
    "file:///tmp/a",
    "https://github.com:8443/a/b/blob/main/index.html",
    "https://github.com/a/b/blob/main/%00.html",
  ])
    assert.throws(() => parseGitHubURL(url));
});

test("encoded paths, slash branches and override", () => {
  const input = parseGitHubURL(
    "https://github.com/alice/demo/blob/feature%2Fone/a%20b.html",
    "feature/one",
  );
  assert.equal(input.tail, "feature/one/a b.html");
  assert.equal(
    chooseRef(input.tail, ["feature", "feature/one"]),
    "feature/one",
  );
  assert.throws(() =>
    parseGitHubURL("https://github.com/a/b/blob/main/index.html", "other"),
  );
});

test("share links are deployment-relative, strip search and carry no credentials", () => {
  const target = {
    owner: "a",
    repo: "b",
    ref: "feature/demo",
    path: "site/a b.html",
  };
  const source = sourceURL(target);
  assert.equal(
    source,
    "https://github.com/a/b/blob/feature/demo/site/a%20b.html",
  );
  const link = new URL(
    shareURL("https://user.github.io/siteview/?token=accidental#old", target),
  );
  assert.equal(link.pathname, "/siteview/");
  assert.equal(link.search, "");
  assert.equal(new URLSearchParams(link.hash.slice(1)).get("url"), source);
});

test("resource paths resolve relative to current file or repository root", () => {
  assert.deepEqual(localPath("../assets/a.png?v=1#icon", "site/index.html"), {
    path: "assets/a.png",
    search: "?v=1",
    hash: "#icon",
  });
  assert.equal(localPath("/style.css", "site/index.html").path, "style.css");
  assert.equal(localPath("https://cdn.test/a.js", "index.html"), null);
  assert.equal(localPath("data:image/png;base64,AA", "index.html"), null);
  assert.equal(localPath("#anchor", "index.html"), null);
  assert.equal(
    virtualURL("a b/é.html"),
    "https://siteview.invalid/a%20b/%C3%A9.html",
  );
});

test("MIME and edits", () => {
  assert.equal(mime("app.MJS"), "text/javascript");
  assert.equal(mime("image.svg"), "image/svg+xml");
  assert.equal(mime("unknown.bin"), "application/octet-stream");
  assert.equal(
    applyEdits("abcdef", [
      { start: 1, end: 2, value: "BB" },
      { start: 4, end: 6, value: "Z" },
    ]),
    "aBBcdZ",
  );
});

test("API credentials stay in headers on the fixed GitHub host with redirects disabled", async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response("{}", { status: 200 });
  };
  try {
    const api = new GitHub("example-pat");
    await api.request("/repos/alice/demo/commits/main");
    const { url, options } = calls[0];
    assert.equal(new URL(url).origin, "https://api.github.com");
    assert.ok(!url.includes("example-pat"));
    assert.equal(options.headers.Authorization, "Bearer example-pat");
    assert.equal(options.redirect, "error");
    assert.equal(options.cache, "no-store");
    assert.equal(options.credentials, "omit");
    assert.equal(options.referrerPolicy, "no-referrer");
    await assert.rejects(api.request("https://evil.test/repos/a/b"));
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("file reads enforce size and count budgets and reject LFS pointers", async () => {
  const api = new GitHub();
  api.target = { sha: "a".repeat(40) };
  api.root = "/repos/a/b";
  api.request = async () =>
    new Response("small", {
      headers: { "content-length": String(9 * 1024 * 1024) },
    });
  await assert.rejects(api.file("large.bin"), /8 MiB/);
  api.request = async () =>
    new Response("version https://git-lfs.github.com/spec/v1\noid sha256:abc");
  await assert.rejects(api.file("lfs.bin"), /Git LFS/);
  api.total = 40 * 1024 * 1024;
  api.request = async () => new Response("x");
  await assert.rejects(api.file("over-budget.txt"), /size limit/);
  api.files.clear();
  for (let i = 0; i < 200; i++) api.files.set(String(i), Promise.resolve());
  await assert.rejects(api.file("too-many.txt"), /200 files/);
});

test("qualified raw refs preserve the branch or tag namespace", async () => {
  const api = new GitHub();
  const paths = [];
  api.request = async (path) => {
    paths.push(path);
    if (path.includes("/matching-refs/"))
      return Response.json([{ ref: "refs/heads/main" }]);
    return Response.json({ sha: "a".repeat(40) });
  };
  const target = await api.resolve(
    parseGitHubURL(
      "https://raw.githubusercontent.com/a/b/refs/heads/main/site/index.html",
    ),
  );
  assert.equal(target.ref, "refs/heads/main");
  assert.equal(target.path, "site/index.html");
  assert.ok(
    paths.some((path) => path.endsWith("/commits/refs%2Fheads%2Fmain")),
  );
  assert.ok(!paths.some((path) => path.includes("/matching-refs/tags/")));
});

test("file reads are cached per resolved commit", async () => {
  const api = new GitHub();
  api.target = { sha: "a".repeat(40) };
  api.root = "/repos/a/b";
  let calls = 0;
  api.request = async (path) => {
    calls++;
    assert.ok(path.endsWith(`?ref=${api.target.sha}`));
    return new Response("hello");
  };
  const [a, b] = await Promise.all([
    api.file("hello.txt"),
    api.file("hello.txt"),
  ]);
  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(a.type, "text/plain");
});

test("file access requires resolution and rejects traversal", async () => {
  const api = new GitHub("secret");
  assert.throws(() => api.file("index.html"));
  api.target = { sha: "a".repeat(40) };
  for (const path of ["../a", "a/../b", "/a", "a//b", "a\\b", "a\u0000b"])
    await assert.rejects(api.file(path));
  api.dispose();
  assert.equal(api.token, "");
});
