import type { ComponentChildren, VNode } from "preact";

/**
 * Tiny, safe Markdown renderer for untrusted model output.
 *
 * The agent (Nemotron / mock) returns Markdown — bold, lists, headings, links,
 * inline code. We must NOT use dangerouslySetInnerHTML on model output, so this
 * renders everything as Preact VNodes. Only a deliberately small subset of
 * Markdown is supported; anything unrecognised renders as plain text, so there
 * is no path for raw HTML/script injection.
 *
 * Supported:
 *   - headings        # .. ######
 *   - unordered lists - * +
 *   - ordered lists   1. 2. ...
 *   - blockquotes     >
 *   - bold            **x**  __x__
 *   - italic          *x*    _x_
 *   - inline code     `x`
 *   - links           [text](http(s)://…)  (other schemes rendered as text)
 *   - tables          | a | b |  /  |---|---|  (GFM pipe tables)
 *   - horizontal rule --- *** ___ (3+)
 *   - paragraphs / line breaks
 */

let keySeq = 0;
function k(): number {
  return keySeq++;
}

/** Inline parsing: code → links → bold → italic, left to right, non-greedy. */
function parseInline(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  // Combined matcher; order matters (code first so its contents aren't styled).
  const re =
    /(`([^`]+)`)|(\[([^\]]+)\]\(([^)\s]+)\))|(\*\*([^*]+)\*\*|__([^_]+)__)|(\*([^*]+)\*|_([^_]+)_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null) {
      // inline code
      out.push(<code key={k()} class="md-code">{m[2]}</code>);
    } else if (m[3] != null) {
      // link — only allow http/https, else render as plain label
      const label = m[4];
      const href = m[5];
      if (/^https?:\/\//i.test(href)) {
        out.push(
          <a key={k()} class="md-link" href={href} target="_blank" rel="noopener noreferrer">
            {label}
          </a>,
        );
      } else {
        out.push(label);
      }
    } else if (m[6] != null) {
      out.push(<strong key={k()}>{m[7] ?? m[8]}</strong>);
    } else if (m[9] != null) {
      out.push(<em key={k()}>{m[10] ?? m[11]}</em>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A line is a horizontal rule if it's only 3+ of - * _ (allowing spaces). */
function isHr(line: string): boolean {
  const t = line.trim();
  return /^([-*_])(\s*\1){2,}$/.test(t);
}

/** A line is a GFM table delimiter row, e.g. | --- | :--: | ---: | */
function isTableDelimiter(line: string): boolean {
  const t = line.trim();
  if (!t.includes("|") && !/^-/.test(t)) return false;
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?$/.test(t);
}

/** Split a pipe-table row into trimmed cell strings (strips outer pipes). */
function splitRow(line: string): string[] {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

/** Alignment per column, parsed from the delimiter row. */
function parseAligns(delim: string): (string | undefined)[] {
  return splitRow(delim).map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return undefined;
  });
}

/** Block parsing: group lines into paragraphs, lists, headings, quotes, tables. */
function parseBlocks(src: string): VNode[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const blocks: VNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length === 0) return;
    blocks.push(<p key={k()} class="md-p">{parseInline(para.join(" "))}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const items = list.items.map((it) => <li key={k()}>{parseInline(it)}</li>);
    blocks.push(
      list.ordered
        ? <ol key={k()} class="md-ol">{items}</ol>
        : <ul key={k()} class="md-ul">{items}</ul>,
    );
    list = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    if (line.trim() === "") {
      flushPara();
      flushList();
      continue;
    }

    // GFM pipe table: a header row with a pipe, immediately followed by a
    // delimiter row (| --- | --- |). Render as a real <table>.
    if (
      line.includes("|") &&
      i + 1 < lines.length &&
      isTableDelimiter(lines[i + 1]) &&
      !isHr(line)
    ) {
      flushPara();
      flushList();
      const headers = splitRow(line);
      const aligns = parseAligns(lines[i + 1]);
      const rows: string[][] = [];
      let j = i + 2;
      for (; j < lines.length; j++) {
        const r = lines[j].trim();
        if (r === "" || !r.includes("|")) break;
        rows.push(splitRow(lines[j]));
      }
      blocks.push(
        <table key={k()} class="md-table">
          <thead>
            <tr>
              {headers.map((h, c) => (
                <th key={k()} style={aligns[c] ? `text-align:${aligns[c]}` : undefined}>
                  {parseInline(h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((cells) => (
              <tr key={k()}>
                {headers.map((_, c) => (
                  <td key={k()} style={aligns[c] ? `text-align:${aligns[c]}` : undefined}>
                    {parseInline(cells[c] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      i = j - 1;
      continue;
    }

    // Horizontal rule: --- *** ___
    if (isHr(line)) {
      flushPara();
      flushList();
      blocks.push(<hr key={k()} class="md-hr" />);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const level = Math.min(heading[1].length + 2, 6);
      const inner = parseInline(heading[2]);
      blocks.push(
        level <= 3
          ? <h3 key={k()} class="md-h md-h3">{inner}</h3>
          : level === 4
            ? <h4 key={k()} class="md-h md-h4">{inner}</h4>
            : level === 5
              ? <h5 key={k()} class="md-h md-h5">{inner}</h5>
              : <h6 key={k()} class="md-h md-h6">{inner}</h6>,
      );
      continue;
    }

    const ulMatch = /^[-*+]\s+(.*)$/.exec(line.trim());
    const olMatch = /^\d+[.)]\s+(.*)$/.exec(line.trim());
    if (ulMatch || olMatch) {
      flushPara();
      const ordered = Boolean(olMatch);
      if (!list || list.ordered !== ordered) {
        flushList();
        list = { ordered, items: [] };
      }
      list.items.push((ulMatch ?? olMatch)![1]);
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line.trim());
    if (quote) {
      flushPara();
      flushList();
      blocks.push(<blockquote key={k()} class="md-quote">{parseInline(quote[1])}</blockquote>);
      continue;
    }

    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  return blocks;
}

export function Markdown({ text, class: cls }: { text: string; class?: string }) {
  // Reset per render so keys are deterministic by position — critical during
  // streaming, where this component re-renders on every token and we want the
  // existing DOM nodes to be reused (stable keys) rather than remounted.
  keySeq = 0;
  const wrap = cls ? `md ${cls}` : "md";
  try {
    return <div class={wrap}>{parseBlocks(text ?? "")}</div>;
  } catch {
    // Never let malformed/partial model output blank the bubble — fall back to
    // plain text with preserved whitespace.
    return <div class={wrap} style="white-space:pre-wrap">{text ?? ""}</div>;
  }
}
