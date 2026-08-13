export interface DiagramHtmlAttribute {
  name: string;
  value: string;
}

export interface DiagramHtmlStartTag {
  name: string;
  attributes: DiagramHtmlAttribute[];
}

const NAMED_CHARACTER_REFERENCES: Readonly<Record<string, string>> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: "\u00a0",
  quot: '"',
};

function decodeCharacterReferences(value: string): string {
  return value.replace(
    /&(?:#([0-9]+);|#[xX]([0-9a-fA-F]+);|(amp|lt|gt|quot|apos|nbsp);)/gu,
    (
      reference,
      decimal: string | undefined,
      hex: string | undefined,
      named: string | undefined
    ) => {
      if (named !== undefined) return NAMED_CHARACTER_REFERENCES[named];
      const digits = decimal ?? hex;
      if (digits === undefined) return reference;
      const codePoint = Number.parseInt(digits, hex === undefined ? 10 : 16);
      if (
        codePoint === 0 ||
        codePoint > 0x10ffff ||
        (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ) {
        return "\ufffd";
      }
      return String.fromCodePoint(codePoint);
    }
  );
}

function tagEnd(html: string, start: number): number {
  let quote: '"' | "'" | null = null;
  for (let index = start; index < html.length; index += 1) {
    const char = html[index];
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ">") return index;
  }
  return html.length - 1;
}

function attributes(tag: string): DiagramHtmlAttribute[] {
  const result: DiagramHtmlAttribute[] = [];
  let index = tag.match(/^[^\s/>]+/u)?.[0].length ?? 0;
  while (index < tag.length) {
    while (/\s/u.test(tag[index] ?? "")) index += 1;
    if (index >= tag.length || tag[index] === "/") break;
    const name = tag.slice(index).match(/^[^\s"'=<>`/]+/u)?.[0];
    if (name === undefined) {
      index += 1;
      continue;
    }
    index += name.length;
    while (/\s/u.test(tag[index] ?? "")) index += 1;
    let value = "";
    if (tag[index] === "=") {
      index += 1;
      while (/\s/u.test(tag[index] ?? "")) index += 1;
      const quote = tag[index];
      if (quote === '"' || quote === "'") {
        const end = tag.indexOf(quote, index + 1);
        if (end < 0) {
          index = tag.length;
        } else {
          value = tag.slice(index + 1, end);
          index = end + 1;
        }
      } else {
        value = tag.slice(index).match(/^[^\s"'=<>`]+/u)?.[0] ?? "";
        index += value.length;
      }
    }
    result.push({
      name: name.toLowerCase(),
      value: decodeCharacterReferences(value),
    });
  }
  return result;
}

function rawTextClose(
  html: string,
  lower: string,
  start: number,
  name: string
): number {
  const prefix = `</${name}`;
  let index = start;
  while (index < html.length) {
    const close = lower.indexOf(prefix, index);
    if (close < 0) return -1;
    const boundary = html[close + prefix.length];
    if (boundary === "/" || boundary === ">" || /\s/u.test(boundary ?? "")) {
      return close;
    }
    index = close + prefix.length;
  }
  return -1;
}

/**
 * lint に必要な開始タグと属性だけを走査する軽量 HTML スキャナ。
 * 名前付き文字参照は指定された基本6種だけを対象とする。id・kind は
 * kebab-case の識別子なので、巨大な完全実体表は持たない。未対応の実体は
 * 入力のまま残す。
 */
export function scanDiagramHtmlStartTags(html: string): DiagramHtmlStartTag[] {
  const tags: DiagramHtmlStartTag[] = [];
  const lower = html.toLowerCase();
  let index = 0;
  while (index < html.length) {
    const open = html.indexOf("<", index);
    if (open < 0) break;
    if (html.startsWith("<!--", open)) {
      const end = html.indexOf("-->", open + 4);
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    const name = html.slice(open + 1).match(/^([a-z][\w:-]*)/iu)?.[1];
    if (name === undefined) {
      index = open + 1;
      continue;
    }
    const end = tagEnd(html, open + 1);
    const normalizedName = name.toLowerCase();
    if (normalizedName === "script" || normalizedName === "style") {
      const close = rawTextClose(html, lower, end + 1, normalizedName);
      if (close < 0) break;
      const closeEnd = html.indexOf(">", close + normalizedName.length + 2);
      index = closeEnd < 0 ? html.length : closeEnd + 1;
      continue;
    }
    tags.push({
      name: normalizedName,
      attributes: attributes(html.slice(open + 1, end)),
    });
    index = end + 1;
  }
  return tags;
}
