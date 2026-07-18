import { boundsError, syntaxError } from "./surface-errors.ts";

const MAX_HTML_DEPTH = 64;
const MAX_HTML_NODES = 100_000;
const MAX_RENDERED_TEXT_UNITS = 8 * 1024 * 1024;
const HTML_TAG_PATTERN =
  /^<(?<closing>\/?)(?<name>[A-Za-z][A-Za-z0-9-]*)(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*(?<selfClosing>\/?)>/u;
const HTML_VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const UNSAFE_HTML_ELEMENTS = new Set([
  "embed",
  "iframe",
  "object",
  "script",
  "style",
  "template",
]);

export function decodedMarkdownText(path: string, text: string): string {
  let rendered: string;
  try {
    rendered = Bun.markdown.html(text);
  } catch {
    throw syntaxError(path, "Markdown");
  }
  if (rendered.length > MAX_RENDERED_TEXT_UNITS) {
    throw boundsError(path);
  }
  return extractRenderedHtmlText(path, rendered);
}

function extractRenderedHtmlText(path: string, rendered: string): string {
  const text: string[] = [];
  const elements: string[] = [];
  let units = 0;
  let index = 0;
  let nodes = 0;
  const append = (value: string): void => {
    units += value.length;
    if (units > MAX_RENDERED_TEXT_UNITS) {
      throw boundsError(path);
    }
    text.push(value);
  };
  const countNode = (): void => {
    nodes += 1;
    if (nodes > MAX_HTML_NODES) {
      throw boundsError(path);
    }
  };

  while (index < rendered.length) {
    const start = rendered.indexOf("<", index);
    if (start === -1) {
      append(rendered.slice(index));
      break;
    }
    append(rendered.slice(index, start));
    if (rendered.startsWith("<!--", start)) {
      countNode();
      const end = rendered.indexOf("-->", start + 4);
      if (end === -1 || rendered.slice(start + 4, end).includes("--")) {
        throw syntaxError(path, "rendered Markdown HTML");
      }
      index = end + 3;
      continue;
    }

    const tag = HTML_TAG_PATTERN.exec(rendered.slice(start));
    const name = tag?.groups?.["name"]?.toLowerCase();
    if (tag === null || name === undefined) {
      if (/^[A-Za-z/!?]/u.test(rendered[start + 1] ?? "")) {
        throw syntaxError(path, "rendered Markdown HTML");
      }
      append("<");
      index = start + 1;
      continue;
    }
    countNode();
    if (UNSAFE_HTML_ELEMENTS.has(name)) {
      throw syntaxError(path, "rendered Markdown HTML");
    }
    const closing = tag.groups?.["closing"] === "/";
    const selfClosing = tag.groups?.["selfClosing"] === "/";
    if (closing) {
      if (elements.pop() !== name || selfClosing) {
        throw syntaxError(path, "rendered Markdown HTML");
      }
    } else if (!selfClosing && !HTML_VOID_ELEMENTS.has(name)) {
      if (elements.length >= MAX_HTML_DEPTH) {
        throw boundsError(path);
      }
      elements.push(name);
    }
    index = start + tag[0].length;
  }
  if (elements.length > 0) {
    throw syntaxError(path, "rendered Markdown HTML");
  }
  let decoded: string;
  try {
    decoded = Bun.markdown.render(text.join(""));
  } catch {
    throw syntaxError(path, "rendered Markdown HTML text");
  }
  if (decoded.length > MAX_RENDERED_TEXT_UNITS) {
    throw boundsError(path);
  }
  return decoded;
}
