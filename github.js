import { chooseRef, mime } from "./core.js?v=3";

const API = "https://api.github.com";
const MAX_FILE = 8 * 1024 * 1024;
const MAX_TOTAL = 40 * 1024 * 1024;
const MAX_FILES = 200;
const encodePath = (path) => path.split("/").map(encodeURIComponent).join("/");

export class GitHub {
  constructor(token = "", signal) {
    this.token = token.trim();
    this.signal = signal;
    this.files = new Map();
    this.total = 0;
  }

  async request(path, raw = false, allow404 = false) {
    if (!path.startsWith("/repos/")) throw new Error("Invalid API path.");
    const headers = {
      Accept: raw
        ? "application/vnd.github.raw+json"
        : "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const response = await fetch(`${API}${path}`, {
      headers,
      signal: this.signal,
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) {
      if (response.status === 401)
        throw new Error(
          "GitHub rejected the token. Check that it is valid and has not expired.",
        );
      if (response.status === 404)
        throw new Error(
          "File or repository not found. For private repos, provide a PAT with Contents: read access to this repository. Check the ref and filename too.",
        );
      if (response.status === 403 || response.status === 429) {
        const reset = response.headers.get("x-ratelimit-reset");
        const suffix = reset
          ? ` Rate limit resets at ${new Date(Number(reset) * 1000).toLocaleTimeString()}.`
          : "";
        throw new Error(
          `GitHub denied the request. Check token permissions, organization SSO authorization, or the API rate limit.${suffix}`,
        );
      }
      throw new Error(
        `GitHub request failed (${response.status}). Try again later.`,
      );
    }
    return response;
  }

  async resolve(input) {
    const root = `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`;
    let ref = input.refOverride;
    if (!ref) {
      const qualified = input.tail.match(/^refs\/(heads|tags)\/(.+)$/);
      const first = (qualified ? qualified[2] : input.tail).split("/")[0];
      if (!qualified && /^[a-f0-9]{7,40}$/i.test(first)) ref = first;
      else {
        const kinds = qualified ? [qualified[1]] : ["heads", "tags"];
        const results = await Promise.all(
          kinds.map(async (kind) => {
            const response = await this.request(
              `${root}/git/matching-refs/${kind}/${encodeURIComponent(first)}`,
              false,
              true,
            );
            return response ? response.json() : [];
          }),
        );
        ref = chooseRef(
          input.tail,
          results
            .flat()
            .map((item) =>
              qualified
                ? item.ref
                : item.ref.replace(/^refs\/(heads|tags)\//, ""),
            ),
        );
      }
    }
    if (!ref)
      throw new Error(
        "No matching branch or tag. Check the URL, or enter an explicit ref in Advanced options.",
      );
    const path = input.tail.slice(ref.length + 1);
    if (!path) throw new Error("Choose a file, not a repository or directory.");
    const response = await this.request(
      `${root}/commits/${encodeURIComponent(ref)}`,
    );
    const commit = await response.json();
    if (!/^[a-f0-9]{40}$/i.test(commit.sha))
      throw new Error("GitHub returned an invalid commit.");
    this.target = {
      owner: input.owner,
      repo: input.repo,
      ref,
      sha: commit.sha,
      path,
    };
    this.root = root;
    return this.target;
  }

  file(path) {
    if (!this.target) throw new Error("Resolve a repository first.");
    if (
      !path ||
      path.split("/").some((p) => p === ".." || p === "." || !p) ||
      /[\x00-\x1f\\]/.test(path)
    )
      return Promise.reject(new Error("Invalid repository path."));
    if (!this.files.has(path)) {
      if (this.files.size >= MAX_FILES)
        return Promise.reject(
          new Error(`Preview limit reached: ${MAX_FILES} files.`),
        );
      this.files.set(path, this.readFile(path));
    }
    return this.files.get(path);
  }

  async readFile(path) {
    const response = await this.request(
      `${this.root}/contents/${encodePath(path)}?ref=${this.target.sha}`,
      true,
    );
    if (Number(response.headers.get("content-length")) > MAX_FILE)
      throw new Error(`File exceeds 8 MiB: ${path}`);
    const chunks = [];
    let size = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        this.total += value.byteLength;
        if (size > MAX_FILE || this.total > MAX_TOTAL)
          throw new Error(
            "Preview size limit reached. Maximum 8 MiB per file and 40 MiB total.",
          );
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      throw error;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (
      new TextDecoder()
        .decode(bytes.slice(0, 100))
        .startsWith("version https://git-lfs.github.com/spec/")
    )
      throw new Error(`Git LFS files are not supported: ${path}`);
    return { bytes, type: mime(path) };
  }

  dispose() {
    this.token = "";
    this.files.clear();
  }
}
