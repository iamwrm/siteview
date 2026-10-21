// Small dependency-free Markdown renderer. Raw HTML in the source is escaped,
// never passed through, because previews run untrusted repository code.

const ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ESCAPES[character]);
}

const escapeAttribute = (value) => escapeHTML(value).replace(/`/g, "&#96;");

function safeURL(value) {
  const url = value.trim();
  if (!url || /[\u0000-\u001f]/.test(url)) return null;
  const scheme = url.match(/^([a-z][a-z0-9+.-]*):/i);
  if (!scheme) return escapeAttribute(url);
  return ["http", "https", "mailto"].includes(scheme[1].toLowerCase())
    ? escapeAttribute(url)
    : null;
}

function codeSpan(content) {
  let value = content.replace(/\n/g, " ");
  if (/^ .*[^ ].* $/.test(value) || /^ .* $/.test(value))
    value = value.slice(1, -1);
  return `<code>${escapeHTML(value)}</code>`;
}

function inline(source) {
  const slots = [];
  const hold = (html) => {
    slots.push(html);
    return `\u0000${slots.length - 1}\u0000`;
  };
  let value = source;

  value = value.replace(/(`+)([\s\S]*?)\1/g, (_, __, content) =>
    hold(codeSpan(content)),
  );
  value = value.replace(
    /!\[([^\]]*)\]\(\s*((?:[^\s()]|\([^\s()]*\))+)(?:\s+"([^"]*)")?\s*\)/g,
    (_, alt, url, title) => {
      const href = safeURL(url);
      if (!href) return hold(escapeHTML(alt));
      const described = title ? ` title="${escapeAttribute(title)}"` : "";
      return hold(
        `<img src="${href}" alt="${escapeAttribute(alt)}"${described}>`,
      );
    },
  );
  value = value.replace(
    /\[([^\]]*)\]\(\s*((?:[^\s()]|\([^\s()]*\))+)(?:\s+"([^"]*)")?\s*\)/g,
    (_, label, url, title) => {
      const href = safeURL(url);
      if (!href) return hold(escapeHTML(label));
      const described = title ? ` title="${escapeAttribute(title)}"` : "";
      return hold(`<a href="${href}"${described}>${escapeHTML(label)}</a>`);
    },
  );
  value = value.replace(/<(https?:\/\/[^\s<>]+)>/gi, (_, url) =>
    hold(`<a href="${escapeAttribute(url)}">${escapeHTML(url)}</a>`),
  );

  value = escapeHTML(value);
  value = value.replace(
    /(\*\*\*|___)(?=\S)([\s\S]*?\S)\1/g,
    "<strong><em>$2</em></strong>",
  );
  value = value.replace(
    /(\*\*|__)(?=\S)([\s\S]*?\S)\1/g,
    "<strong>$2</strong>",
  );
  value = value.replace(/(\*|_)(?=\S)([\s\S]*?\S)\1/g, "<em>$2</em>");
  value = value.replace(/(~~)(?=\S)([\s\S]*?\S)\1/g, "<del>$2</del>");
  value = value.replace(/ {2,}\n/g, "<br>\n");
  value = value.replace(/\\\n/g, "<br>\n");
  value = value.replace(/\u0000(\d+)\u0000/g, (_, index) => slots[index]);
  return value;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^`]*)$/;
const ATX = /^ {0,3}(#{1,6})[ \t]+(.*?)[ \t]*#*[ \t]*$/;
const RULE = /^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const QUOTE = /^ {0,3}>/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const TABLE_DIVIDER =
  /^ {0,3}\|?[ \t]*:?-{1,}:?[ \t]*(\|[ \t]*:?-{1,}:?[ \t]*)*\|?[ \t]*$/;

function slug(value, used) {
  const base =
    value
      .replace(/<[^>]*>/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section";
  const seen = used.get(base) || 0;
  used.set(base, seen + 1);
  return seen ? `${base}-${seen}` : base;
}

function splitRow(line) {
  let value = line.trim();
  if (value.startsWith("|")) value = value.slice(1);
  if (value.endsWith("|") && !value.endsWith("\\|")) value = value.slice(0, -1);
  const cells = [];
  let cell = "";
  let inCode = false;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === "\\" && value[index + 1] === "|") {
      cell += "|";
      index++;
      continue;
    }
    if (character === "`") inCode = !inCode;
    if (character === "|" && !inCode) {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += character;
  }
  cells.push(cell);
  return cells;
}

function isBlockStart(lines, index) {
  const line = lines[index];
  return (
    FENCE.test(line) ||
    ATX.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    (line.includes("|") &&
      index + 1 < lines.length &&
      TABLE_DIVIDER.test(lines[index + 1]))
  );
}

function renderBlocks(lines, state) {
  const output = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index++;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1][0];
      const length = fence[1].length;
      const language = fence[2].trim().split(/\s+/)[0];
      const body = [];
      index++;
      while (index < lines.length) {
        const closing = lines[index].match(/^ {0,3}(`+|~+)[ \t]*$/);
        if (
          closing &&
          closing[1][0] === marker &&
          closing[1].length >= length
        ) {
          index++;
          break;
        }
        body.push(lines[index]);
        index++;
      }
      const className = language
        ? ` class="language-${escapeAttribute(language)}"`
        : "";
      output.push(
        `<pre><code${className}>${escapeHTML(body.join("\n"))}${body.length ? "\n" : ""}</code></pre>`,
      );
      continue;
    }

    const heading = line.match(ATX);
    if (heading) {
      const level = heading[1].length;
      const body = inline(heading[2]);
      output.push(
        `<h${level} id="${slug(heading[2], state.ids)}">${body}</h${level}>`,
      );
      index++;
      continue;
    }

    if (RULE.test(line)) {
      output.push("<hr>");
      index++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner = [];
      while (index < lines.length && lines[index].trim()) {
        if (!QUOTE.test(lines[index])) break;
        inner.push(lines[index].replace(/^ {0,3}> ?/, ""));
        index++;
      }
      output.push(`<blockquote>${renderBlocks(inner, state)}</blockquote>`);
      continue;
    }

    if (
      line.includes("|") &&
      index + 1 < lines.length &&
      TABLE_DIVIDER.test(lines[index + 1])
    ) {
      const head = splitRow(line);
      const align = splitRow(lines[index + 1]).map((cell) => {
        const trimmed = cell.trim();
        if (/^:-+:$/.test(trimmed)) return "center";
        if (/^-+:$/.test(trimmed)) return "right";
        if (/^:-+$/.test(trimmed)) return "left";
        return "";
      });
      index += 2;
      const rows = [];
      while (
        index < lines.length &&
        lines[index].includes("|") &&
        lines[index].trim()
      ) {
        rows.push(splitRow(lines[index]));
        index++;
      }
      const cell = (tag, value, column) => {
        const style = align[column]
          ? ` style="text-align:${align[column]}"`
          : "";
        return `<${tag}${style}>${inline(value.trim())}</${tag}>`;
      };
      const headHTML = head
        .map((value, column) => cell("th", value, column))
        .join("");
      const bodyHTML = rows
        .map(
          (row) =>
            `<tr>${head
              .map((_, column) => cell("td", row[column] ?? "", column))
              .join("")}</tr>`,
        )
        .join("");
      output.push(
        `<table><thead><tr>${headHTML}</tr></thead><tbody>${bodyHTML}</tbody></table>`,
      );
      continue;
    }

    const listStart = line.match(LIST_ITEM);
    if (listStart) {
      const baseIndent = listStart[1].length;
      const ordered = /\d/.test(listStart[2]);
      const start = ordered ? Number.parseInt(listStart[2], 10) : 1;
      const items = [];
      let loose = false;
      while (index < lines.length) {
        const item = lines[index].match(LIST_ITEM);
        if (
          !item ||
          item[1].length !== baseIndent ||
          ordered !== /\d/.test(item[2])
        )
          break;
        const content = [item[3]];
        index++;
        while (index < lines.length) {
          if (!lines[index].trim()) {
            let next = index + 1;
            while (next < lines.length && !lines[next].trim()) next++;
            const continuation =
              next < lines.length &&
              lines[next].match(/^ */)[0].length >= baseIndent + 2;
            if (continuation) {
              content.push("");
              loose = true;
              index++;
              continue;
            }
            break;
          }
          const indent = lines[index].match(/^ */)[0].length;
          const nested = LIST_ITEM.test(lines[index]);
          if (indent >= baseIndent + 2) {
            content.push(lines[index].slice(baseIndent + 2));
            index++;
            continue;
          }
          if (indent > baseIndent && !nested) {
            content.push(lines[index].trim());
            index++;
            continue;
          }
          break;
        }
        items.push(content);
      }
      const tag = ordered ? "ol" : "ul";
      const begin = ordered && start !== 1 ? ` start="${start}"` : "";
      const list = items
        .map((content) => {
          let task = "";
          const first = content[0].match(/^\[([ xX])\][ \t]+/);
          if (first) {
            task = `<input type="checkbox" disabled${first[1].trim() ? " checked" : ""}> `;
            content = [content[0].slice(first[0].length), ...content.slice(1)];
          }
          let body = renderBlocks(content, state);
          if (!loose) body = body.replace(/^<p>([\s\S]*?)<\/p>/, "$1");
          return `<li>${task}${body}</li>`;
        })
        .join("");
      output.push(`<${tag}${begin}>${list}</${tag}>`);
      continue;
    }

    const paragraph = [];
    while (index < lines.length) {
      const current = lines[index];
      if (!current.trim()) break;
      if (
        paragraph.length &&
        (SETEXT.test(current) ||
          FENCE.test(current) ||
          ATX.test(current) ||
          RULE.test(current) ||
          QUOTE.test(current) ||
          LIST_ITEM.test(current))
      )
        break;
      paragraph.push(current);
      index++;
    }
    if (index < lines.length && SETEXT.test(lines[index]) && paragraph.length) {
      const level = lines[index].trim().startsWith("=") ? 1 : 2;
      const body = inline(paragraph.join(" "));
      output.push(
        `<h${level} id="${slug(paragraph.join(" "), state.ids)}">${body}</h${level}>`,
      );
      index++;
      continue;
    }
    const joined = paragraph.join("\n");
    output.push(`<p>${inline(joined)}</p>`);
  }
  return output.join("\n");
}

export function renderMarkdown(source) {
  const lines = String(source).replace(/\r\n?/g, "\n").split("\n");
  const state = { ids: new Map() };
  const html = renderBlocks(lines, state);
  const titleMatch = source.match(/^ {0,3}#[ \t]+(.+)$/m);
  const title = titleMatch ? titleMatch[1].replace(/[#\s]+$/, "").trim() : "";
  return { html, title };
}

export const MARKDOWN_STYLE = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 24px 64px; font: 16px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; color: #1f2328; background: #ffffff; }
.markdown-body { max-width: 840px; margin: 0 auto; overflow-wrap: break-word; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.6em 0 .6em; font-weight: 600; }
h1 { font-size: 2em; border-bottom: 1px solid #d8dee4; padding-bottom: .3em; }
h2 { font-size: 1.5em; border-bottom: 1px solid #d8dee4; padding-bottom: .3em; }
h3 { font-size: 1.25em; } h4 { font-size: 1em; } h5 { font-size: .875em; } h6 { font-size: .85em; color: #656d76; }
p, ul, ol, blockquote, table, pre { margin: 0 0 1em; }
ul, ol { padding-left: 2em; } li + li { margin-top: .25em; }
li > ul, li > ol { margin: .25em 0 0; }
a { color: #0969da; text-decoration: none; } a:hover { text-decoration: underline; }
img { max-width: 100%; height: auto; }
code { font: 85% ui-monospace, SFMono-Regular, Consolas, monospace; background: #eff1f3; border-radius: 4px; padding: .15em .35em; }
pre { background: #f6f8fa; border-radius: 6px; padding: 14px 16px; overflow: auto; }
pre code { background: none; padding: 0; font-size: 85%; line-height: 1.5; }
blockquote { border-left: 4px solid #d0d7de; color: #57606a; margin-left: 0; padding: 0 1em; }
table { border-collapse: collapse; display: block; overflow: auto; }
th, td { border: 1px solid #d0d7de; padding: 6px 12px; }
th { background: #f6f8fa; font-weight: 600; }
hr { border: 0; border-top: 1px solid #d8dee4; margin: 1.6em 0; }
input[type=checkbox] { margin: 0 .35em 0 0; vertical-align: middle; }
del { color: #656d76; }
`;
