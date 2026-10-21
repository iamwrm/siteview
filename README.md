# Siteview

A browser-only GitHub file viewer inspired by raw.githack. Paste a GitHub HTML file URL, optionally supply a personal access token, and preview the file with its relative CSS, images and JavaScript. No backend, runtime dependencies, build step, analytics, or third-party preview service.

## Run

Serve this directory over HTTP. Opening index.html with file:// will not work with ES modules.

```sh
python3 -m http.server 5173 --bind 127.0.0.1
# Open http://127.0.0.1:5173
```

Node is needed only for development tests. The browser loads the checked-in files directly. Internet access to api.github.com is required.

## GitHub Pages

1. Push this directory as a repository with a main branch.
2. In Settings → Pages → Build and deployment, select **GitHub Actions**.
3. Run the included Pages workflow, or push to main. It tests the app and publishes only its static runtime files.

Alternatively publish the repository root directly using Pages' “Deploy from a branch” option. All app assets use relative paths, so both user sites and project sites such as https://you.github.io/siteview/ work. No custom domain or SPA rewrite rules are required. Share routes live in the URL fragment.

## Use

- Paste a github.com/owner/repo/blob/ref/path or raw.githubusercontent.com/owner/repo/ref/path URL.
- For private repositories, open the options panel and enter your own PAT.
- Review the trust notice, check the box, and click Preview file.
- Copy a development link to follow the branch or a commit-pinned link to keep the same revision. Recipients must opt in before any repository code runs. Private links require the recipient's own GitHub access.
- Reload resolves the branch again. Internal page navigation stays at the initially selected commit.

Branch names containing slashes are matched against GitHub branch and tag refs, longest name first. The explicit ref field resolves ambiguity. Direct commit links also work.

## Private repository access

Prefer a [fine-grained PAT](https://github.com/settings/personal-access-tokens/new) restricted to the repositories you want to preview, with **Contents: Read-only**. Some organizations require administrator approval. Classic tokens require the broader repo scope and may require SSO authorization.

The PAT is sent in the Authorization header only to https://api.github.com. Fetch uses no-store, omits cookies and referrers, and refuses redirects. The token is held only in the password field and the active API client's memory. It is not written to localStorage, sessionStorage, cookies, URLs, GitHub Pages, a service worker, or server logs. Clearing the token closes the active preview. Reloading or leaving the tab clears it. Browser extensions, developer tools and a compromised app host remain outside this protection.

Private file bytes and generated data URLs remain in browser memory until the preview is closed or replaced. The app uses no persistent cache. A token grants access only according to GitHub's permissions, but use the narrowest token possible.

## Preview isolation and trust

Repository HTML is rendered in an iframe with sandbox="allow-scripts", deliberately **without allow-same-origin**. It cannot read the parent document, PAT, or parent storage. Popups, forms, nested frames and top navigation are blocked. Preview links to other repository pages are handled through a MessageChannel. External page links are blocked rather than opening unsandboxed content on the app origin.

The preview receives no credentials. Its read-only message bridge can fetch files only from the selected repository and resolved commit. It cannot select another repository, branch, API endpoint or HTTP method. Initial files and bridge reads share size/count limits and an in-memory cache. It can read any file at that commit, not only files initially referenced by the HTML.

**Only preview trusted repository code.** Scripts and external resources can make network requests and send repository content to third parties. The sandbox protects Siteview's origin and credentials, not the confidentiality of data the preview can read. A hostile preview can also consume CPU or memory. Siteview is not a malware-analysis environment.

## Supported content

- HTML, relative and repository-root-relative resources.
- Stylesheets, CSS url() and quoted @import, common image srcset, fonts and media.
- Classic scripts and native ES modules with literal relative imports, including cycles and literal dynamic imports.
- The common new URL('./asset', import.meta.url) idiom.
- Relative fetch() for read-only repository files. Query strings do not select different Git content.
- Internal HTML page links. Root-relative paths mean repository root, not the HTML file's directory.
- Images displayed directly. Other non-HTML files displayed as text.

Limits: 200 distinct files per session, 8 MiB per file and 40 MiB total. GitHub API limits apply. Most dependency files consume one API request each, plus requests to resolve the ref. A token typically raises GitHub's hourly allowance from 60 requests to 5,000. Git LFS is rejected.

Not supported: server-side apps, source compilation, npm package resolution, bare imports, repository import maps, workers, XHR, dynamic DOM asset paths, computed dynamic imports, directory listings, extensionless SPA routes, and HTTP response semantics such as cookies or redirects. Build framework projects first, then preview the output HTML. CSS rewriting handles ordinary static URLs, not a full CSS grammar. Unusual escaped URLs or import syntax may need a build step. Existing subresource integrity attributes are removed because resource URLs are rewritten. Cross-page fragment scrolling is not restored. External resources still need their normal CORS support.

## Not a CDN

raw.githack is a server-side caching proxy that can serve arbitrary files with corrected HTTP Content-Type headers. A GitHub Pages app cannot do that. Siteview fetches files through GitHub's CORS-enabled API and assembles a sandboxed browser preview instead. Share links open the viewer; they are **not embeddable script/CSS endpoints**, production hosting or permanent cached copies. A pinned link fixes the Git commit, but it does not pin external CDN resources. GitHub is the only supported repository provider.

## Development

```sh
npm ci
npm run check
npm test
npx playwright install chromium
npm run test:browser
```

Browser tests use intercepted GitHub API fixtures. They cover private/public requests, token isolation, CSS and module loading, fetch bridging, page navigation, branch resolution, share links, mobile layout and API failures. No real PAT or private repository is used. Live GitHub credentials and organization policies must be verified with your own account.

The only vendored runtime dependency is es-module-lexer 2.0.0, MIT, in vendor/. Its license is included. To update it deliberately, update the dev dependency and lockfile, copy node_modules/es-module-lexer/dist/lexer.js and LICENSE into vendor/, then rerun the tests.
