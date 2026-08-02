/* Markdown rendering for untrusted agent output.
 *
 * Streaming turns stay plain text (no AST rebuild per token).
 * Completed turns get GFM + highlight.js + KaTeX + Mermaid (strict).
 */

import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import katex from "katex";
import { marked } from "marked";
import { invoke } from "@tauri-apps/api/core";
import type { MouseEvent } from "react";
import { memo, useEffect, useId, useMemo, useRef } from "react";
import "katex/dist/katex.min.css";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (char) => ESCAPES[char]);

/** Dual-gate with Rust `open_external` / SSRF policy (R13–R19). Exported for tests. */
export function isSafeMarkdownOpenUrl(url: URL): boolean {
  if (url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;
  // Cloud metadata / link-local (Rust is_blocked_ssrf_host).
  if (
    host === "metadata"
    || host === "metadata.google.internal"
    || host.endsWith(".metadata.google.internal")
    || host === "instance-data"
    || host === "instance-data.ec2.internal"
    || host === "metadata.azure.com"
    || host === "169.254.169.254"
    || host === "100.100.100.200"
    || host.startsWith("169.254.")
    || host === "::ffff:169.254.169.254"
    || host.startsWith("::ffff:169.254.")
  ) {
    return false;
  }
  const loopback =
    host === "localhost"
    || host === "127.0.0.1"
    || host === "::1"
    || host === "0:0:0:0:0:0:0:1"
    || host === "::ffff:127.0.0.1";
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:" && loopback) return true;
  return false;
}

function renderKatex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      strict: "ignore",
      trust: false,
      output: "html",
    });
  } catch {
    return `<code class="md-math-fallback">${escapeHtml(tex)}</code>`;
  }
}

/** Protect fenced code, then turn $$/ $ math into KaTeX HTML placeholders. */
function renderMathInMarkdown(source: string): string {
  const fences: string[] = [];
  const withoutFences = source.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (block) => {
    const token = `\u0000FENCE${fences.length}\u0000`;
    fences.push(block);
    return token;
  });

  let withMath = withoutFences.replace(/\$\$([\s\S]+?)\$\$/g, (_match, tex: string) =>
    renderKatex(tex.trim(), true),
  );
  // Inline \( ... \) and \(...\) — prefer these over $ for math
  withMath = withMath.replace(
    /\(\\\s*([^\s)]+)\s*\\\)/g,
    (_match, tex: string) => renderKatex(tex.trim(), false),
  );
  withMath = withMath.replace(
    /\(\s*([^\s)]+)\s*\)/g,
    (_match, tex: string) => renderKatex(tex.trim(), false),
  );
  // Inline $...$ — avoid matching bare currency like $5 by requiring non-space edges.
  withMath = withMath.replace(
    /(?<!\$)\$(?!\$)([^\s$][^$\n]*?[^\s$])\$(?!\$)/g,
    (_match, tex: string) => renderKatex(tex.trim(), false),
  );
  // Single-token inline math: $x$
  withMath = withMath.replace(
    /(?<!\$)\$(?!\$)([^\s$])\$(?!\$)/g,
    (_match, tex: string) => renderKatex(tex.trim(), false),
  );

  return withMath.replace(/\u0000FENCE(\d+)\u0000/g, (_match, index: string) => {
    return fences[Number(index)] ?? "";
  });
}

function renderCodeBlock(text: string, lang: string): string {
  const language = lang.trim().toLowerCase();
  if (language === "mermaid") {
    const encoded = encodeURIComponent(text);
    return (
      `<div class="md-mermaid" data-mermaid="${escapeHtml(encoded)}">` +
      `<pre class="md-mermaid-fallback"><code>${escapeHtml(text)}</code></pre>` +
      `</div>`
    );
  }
  const valid = language !== "" && hljs.getLanguage(language) ? language : "";
  let highlighted: string;
  if (valid) {
    try {
      highlighted = hljs.highlight(text, { language: valid }).value;
    } catch {
      highlighted = escapeHtml(text);
    }
  } else {
    highlighted = escapeHtml(text);
  }
  const label = escapeHtml(valid || "text");
  return (
    `<div class="md-code"><div class="md-code-bar"><span class="md-code-lang">${label}</span>` +
    `<button type="button" class="md-code-copy" data-code-copy>copy</button></div>` +
    `<pre><code class="hljs${valid ? ` language-${valid}` : ""}">${highlighted}</code></pre></div>`
  );
}

marked.use({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      return renderCodeBlock(text, lang ?? "");
    },
  },
});

function readableStreamingText(text: string): string {
  return text
    .replace(/^\s{0,3}```[^\n]*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/(?<!_)_([^_\n]+)_(?!_)/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\[([^\]]+)]\((?:[^()]|\([^)]*\))*\)/g, "$1");
}

function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true, mathMl: false, svg: true },
    ADD_TAGS: [
      "annotation",
      "semantics",
      "mrow",
      "mi",
      "mo",
      "mn",
      "msup",
      "msub",
      "mfrac",
      "msqrt",
      "mroot",
      "mtable",
      "mtr",
      "mtd",
      "math",
      "button",
      "span",
    ],
    ADD_ATTR: [
      "data-mermaid",
      "data-code-copy",
      "xmlns",
      "viewBox",
      "d",
      "fill",
      "stroke",
      "stroke-width",
      "class",
      "id",
      "style",
      "transform",
      "points",
      "marker-end",
      "markerWidth",
      "markerHeight",
      "orient",
      "refX",
      "refY",
      "cx",
      "cy",
      "r",
      "x",
      "y",
      "width",
      "height",
    ],
    FORBID_TAGS: ["style", "iframe", "object", "embed", "form", "input"],
    // Allow button with data-code-copy only (copy is re-bound on host).
    ALLOWED_URI_REGEXP: /^(https?|data|mailto):/,
  });
}

/** Copy buttons are stripped by FORBID_TAGS button — re-inject after sanitize. */
function restoreCodeChrome(html: string): string {
  // DOMPurify may strip buttons; rebuild copy controls from structure.
  return html.replace(
    /<div class="md-code"><div class="md-code-bar"><span class="md-code-lang">([^<]*)<\/span><\/div>/g,
    (_m, lang: string) =>
      `<div class="md-code"><div class="md-code-bar"><span class="md-code-lang">${lang}</span>` +
      `<button type="button" class="md-code-copy" data-code-copy>copy</button></div>`,
  );
}

function renderMarkdownHtml(text: string): string {
  const withMath = renderMathInMarkdown(text);
  const rendered = marked.parse(withMath, { async: false }) as string;
  return restoreCodeChrome(sanitizeHtml(rendered));
}

let mermaidLoader: Promise<typeof import("mermaid")> | null = null;
function loadMermaid() {
  if (!mermaidLoader) {
    mermaidLoader = import("mermaid").then(async (mod) => {
      mod.default.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        theme: "dark",
        fontFamily: "inherit",
      });
      return mod;
    });
  }
  return mermaidLoader;
}

async function hydrateMermaid(root: HTMLElement, renderKey: string) {
  const nodes = root.querySelectorAll<HTMLElement>(".md-mermaid[data-mermaid]");
  if (nodes.length === 0) return;
  try {
    const mod = await loadMermaid();
    let index = 0;
    for (const node of nodes) {
      if (node.dataset.mermaidDone === "1") continue;
      const encoded = node.getAttribute("data-mermaid");
      if (!encoded) continue;
      let source = "";
      try {
        source = decodeURIComponent(encoded);
      } catch {
        continue;
      }
      const id = `grox-mermaid-${renderKey}-${index++}`;
      try {
        const { svg } = await mod.default.render(id, source);
        // Mermaid SVG is produced by the library; still sanitize.
        const clean = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, html: true },
          ADD_ATTR: ["viewBox", "xmlns", "fill", "stroke", "stroke-width", "d", "cx", "cy", "r", "x", "y", "width", "height", "transform", "points", "marker-end", "markerWidth", "markerHeight", "orient", "refX", "refY", "class", "id", "style"],
        });
        node.innerHTML = clean;
        node.dataset.mermaidDone = "1";
        node.classList.add("md-mermaid-ready");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        node.innerHTML =
          `<div class="md-mermaid-error"><span>Mermaid</span><pre>${escapeHtml(message)}</pre>` +
          `<pre class="md-mermaid-fallback"><code>${escapeHtml(source)}</code></pre></div>`;
        node.dataset.mermaidDone = "1";
      }
    }
  } catch {
    // mermaid failed to load — leave source fallback visible
  }
}

export const Markdown = memo(function Markdown({
  text,
  className = "",
  streaming = false,
}: {
  text: string;
  className?: string;
  streaming?: boolean;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const reactId = useId().replace(/:/g, "");

  const html = useMemo(() => {
    if (streaming) return "";
    return renderMarkdownHtml(text);
  }, [streaming, text]);

  // Hydrate mermaid only after completed HTML is committed.
  useEffect(() => {
    if (streaming) return;
    const host = hostRef.current;
    if (!host) return;
    void hydrateMermaid(host, reactId);
  }, [streaming, html, reactId]);

  if (streaming) {
    return (
      <div className={`md md-streaming whitespace-pre-wrap ${className}`}>
        {readableStreamingText(text)}
      </div>
    );
  }

  const handleClick = (event: MouseEvent<HTMLDivElement>) => {
    const target = event.target as Element;
    const copyButton = target.closest("[data-code-copy]");
    if (copyButton instanceof HTMLElement) {
      const code = copyButton.closest(".md-code")?.querySelector("pre code")?.textContent ?? "";
      void navigator.clipboard.writeText(code).then(() => {
        copyButton.classList.add("copied");
        copyButton.textContent = "copied";
        setTimeout(() => {
          copyButton.classList.remove("copied");
          copyButton.textContent = "copy";
        }, 1200);
      });
      return;
    }
    const anchor = target.closest("a");
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href");
    if (!href) return;
    try {
      const url = new URL(href);
      // Dual-gate with Rust open_external (R13/R16/R19): HTTPS remote or loopback HTTP.
      if (!isSafeMarkdownOpenUrl(url)) return;
      void invoke("open_external", { url: url.toString() });
    } catch {
      // Relative links stay inert because there is no trusted navigation base.
    }
  };

  return (
    <div
      ref={hostRef}
      className={`md ${className}`}
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});
