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

/** Block parsing: group lines into paragraphs, lists, headings, quotes. */
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

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.trim() === "") {
      flushPara();
      flushList();
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
  return <div class={cls ? `md ${cls}` : "md"}>{parseBlocks(text ?? "")}</div>;
}
