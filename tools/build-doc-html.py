#!/usr/bin/env python3
"""
Sinh file HTML tự chứa (self-contained) từ SETUP_GUIDE.md.

Dùng:
    python tools/build-doc-html.py                 # -> SETUP_GUIDE.html
    python tools/build-doc-html.py in.md out.html  # -> tu viet

Không cần mạng: CSS + syntax highlight đều nhúng thẳng vào file HTML.
"""
import html
import re
import sys
from pathlib import Path

from markdown_it import MarkdownIt
from pygments import highlight
from pygments.formatters import HtmlFormatter
from pygments.lexers import get_lexer_by_name, guess_lexer

# ---------------------------------------------------------------- config

SRC = Path("SETUP_GUIDE.md")
OUT = Path("SETUP_GUIDE.html")

# ---------------------------------------------------------------- slug / anchor

_SLUG_STRIP = re.compile(r"[^\w\s-]", re.UNICODE)


def slugify(text: str) -> str:
    """Trùng cách GitHub tạo anchor: lowercase, bỏ ký tự lạ, space -> hyphen."""
    s = text.strip().lower()
    s = _SLUG_STRIP.sub("", s)
    return s.replace(" ", "-")


# ---------------------------------------------------------------- pygments

_PYG = HtmlFormatter(cssclass="highlight")


def _highlight_code(code: str, lang: str) -> str:
    """Syntax highlight; nếu không biết lang thì để nguyên text (escape HTML)."""
    lexer = None
    if lang:
        try:
            lexer = get_lexer_by_name(lang, stripnl=False)
        except Exception:
            lexer = None
    if lexer is None:
        return '<pre class="highlight"><code>%s</code></pre>' % html.escape(code)
    return highlight(code, lexer, _PYG)


# ---------------------------------------------------------------- markdown

def build_parser() -> MarkdownIt:
    md = MarkdownIt("commonmark", {"html": True, "linkify": False}).enable("table")
    return md


def collect_headings(tokens):
    """Trả về [(level, text, anchor)] theo thứ tự xuất hiện."""
    out = []
    for i, tok in enumerate(tokens):
        if tok.type != "heading_open":
            continue
        inline = tokens[i + 1]
        text = inline.content.strip()
        out.append((int(tok.tag[1:]), text, tok.attrGet("id") or ""))
    return out


def add_ids_and_build_toc(md: MarkdownIt, tokens):
    """Gán id cho heading và trả về danh sách TOC (level, text, id)."""
    used = {}
    toc = []
    for i, tok in enumerate(tokens):
        if tok.type != "heading_open":
            continue
        inline = tokens[i + 1]
        text = inline.content.strip()
        base = slugify(text) or "section"
        if base in used:
            used[base] += 1
            anchor = f"{base}-{used[base]}"
        else:
            used[base] = 0
            anchor = base
        tok.attrSet("id", anchor)
        toc.append((int(tok.tag[1:]), text, anchor))
    return toc


# ---------------------------------------------------------------- html shell

CSS = """
:root {
  --bg: #ffffff;
  --fg: #1f2328;
  --muted: #59636e;
  --border: #d1d9e0;
  --surface: #f6f8fa;
  --accent: #0969da;
  --code-bg: #f6f8fa;
  --mark-bg: #fff8c5;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117;
    --fg: #e6edf3;
    --muted: #9198a1;
    --border: #3d444d;
    --surface: #151b23;
    --accent: #4493f8;
    --code-bg: #151b23;
    --mark-bg: #3f2e00;
  }
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans",
    Helvetica, Arial, sans-serif;
  font-size: 16px;
  line-height: 1.65;
}
.wrap { max-width: 1400px; margin: 0 auto; padding: 0 24px; }

/* ---- header ---- */
header.page {
  border-bottom: 1px solid var(--border);
  background: var(--surface);
  padding: 20px 0;
  margin-bottom: 28px;
}
header.page .wrap { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; }
header.page h1 { font-size: 20px; margin: 0; border: 0; padding: 0; }
header.page .meta { color: var(--muted); font-size: 13px; }
header.page .meta code { background: transparent; padding: 0; }

/* ---- layout ---- */
.layout { display: flex; gap: 40px; align-items: flex-start; }
main { flex: 1 1 auto; min-width: 0; }

/* ---- sidebar toc ---- */
nav.toc {
  position: sticky;
  top: 20px;
  flex: 0 0 300px;
  max-height: calc(100vh - 40px);
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 16px 14px;
  background: var(--surface);
  font-size: 13.5px;
}
nav.toc > p.toc-title {
  margin: 0 0 10px;
  font-weight: 600;
  font-size: 12px;
  letter-spacing: .06em;
  text-transform: uppercase;
  color: var(--muted);
}
nav.toc ol { list-style: none; margin: 0; padding: 0; }
nav.toc ol ol { margin: 0 0 0 14px; padding: 0; border-left: 1px solid var(--border); }
nav.toc li { margin: 3px 0; }
nav.toc a {
  color: var(--fg);
  text-decoration: none;
  display: block;
  padding: 2px 6px;
  border-radius: 4px;
}
nav.toc a:hover { background: var(--mark-bg); color: var(--fg); }
nav.toc > ol > li > a { font-weight: 600; }
nav.toc a.active { background: var(--mark-bg); font-weight: 600; }

/* ---- content ---- */
main h1, main h2, main h3, main h4 { line-height: 1.3; margin: 1.6em 0 .6em; }
main h1 { font-size: 30px; padding-bottom: .3em; border-bottom: 1px solid var(--border); }
main h2 { font-size: 24px; padding-bottom: .3em; border-bottom: 1px solid var(--border); }
main h3 { font-size: 20px; }
main h4 { font-size: 17px; }
main h1:first-child { margin-top: 0; }
.anchor {
  float: left; margin-left: -22px; width: 22px;
  color: var(--muted); text-decoration: none; opacity: 0;
  font-weight: 400;
}
h1:hover > .anchor, h2:hover > .anchor, h3:hover > .anchor,
h4:hover > .anchor { opacity: 1; }
main p { margin: 0 0 1em; }
main ul, main ol { margin: 0 0 1em; padding-left: 2em; }
main li > p { margin: .3em 0; }
main hr { border: 0; border-top: 1px solid var(--border); margin: 2em 0; }
main a { color: var(--accent); text-decoration: none; }
main a:hover { text-decoration: underline; }
main blockquote {
  margin: 0 0 1em; padding: 0 1em;
  border-left: .25em solid var(--border);
  color: var(--muted);
}
main blockquote > p:last-child { margin-bottom: 0; }
main code {
  background: var(--code-bg);
  padding: .2em .4em;
  border-radius: 6px;
  font-size: 85%;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas,
    "Liberation Mono", monospace;
}
main pre {
  background: var(--code-bg);
  border-radius: 6px;
  padding: 16px;
  overflow: auto;
  margin: 0 0 1em;
  line-height: 1.45;
}
main pre code { background: transparent; padding: 0; font-size: 13px; }
main img { max-width: 100%; }
kbd {
  border: 1px solid var(--border); border-bottom-width: 2px;
  border-radius: 4px; padding: 0 5px; font-size: 12px;
}

/* ---- tables: bọc để scroll ngang, không vỡ layout ---- */
.table-wrap {
  overflow-x: auto;
  margin: 0 0 1em;
  border: 1px solid var(--border);
  border-radius: 6px;
}
main table { border-collapse: collapse; width: 100%; font-size: 14px; }
main th, main td {
  border-bottom: 1px solid var(--border);
  padding: 8px 12px;
  text-align: left;
  vertical-align: top;
}
main th { background: var(--surface); font-weight: 600; white-space: nowrap; }
main tbody tr:last-child td { border-bottom: 0; }
main tbody tr:nth-child(2n) { background: color-mix(in srgb, var(--surface) 45%, transparent); }
main td code { white-space: nowrap; }
main td:first-child { min-width: 0; }

/* ---- syntax highlight (pygments) ---- */
.highlight { background: var(--code-bg); }
.highlight pre { margin: 0; }
.highlight .hll { background: var(--mark-bg); }
.highlight .c, .highlight .c1, .highlight .cm, .highlight .cs, .highlight .cd {
  color: #6a737d; font-style: italic;
}
.highlight .k, .highlight .kc, .highlight .kd, .highlight .kn, .highlight .kp,
.highlight .kr, .highlight .kt { color: #cf222e; }
.highlight .s, .highlight .s1, .highlight .s2, .highlight .sb, .highlight .sc,
.highlight .sd, .highlight .se, .highlight .sh, .highlight .si, .highlight .sx,
.highlight .sr, .highlight .ss { color: #0a3069; }
.highlight .m, .highlight .mf, .highlight .mh, .highlight .mi, .highlight .mo,
.highlight .il { color: #0550ae; }
.highlight .n, .highlight .na, .highlight .nb, .highlight .nc, .highlight .nd,
.highlight .ne, .highlight .nf, .highlight .ni, .highlight .nl, .highlight .nn,
.highlight .no, .highlight .nt, .highlight .nv { color: var(--fg); }
.highlight .o, .highlight .ow, .highlight .p { color: var(--fg); }
.highlight .err { color: #cf222e; }
@media (prefers-color-scheme: dark) {
  .highlight .c, .highlight .c1, .highlight .cm, .highlight .cs, .highlight .cd { color: #8b949e; }
  .highlight .k, .highlight .kc, .highlight .kd, .highlight .kn, .highlight .kp,
  .highlight .kr, .highlight .kt { color: #ff7b72; }
  .highlight .s, .highlight .s1, .highlight .s2, .highlight .sb, .highlight .sc,
  .highlight .sd, .highlight .se, .highlight .sh, .highlight .si, .highlight .sx,
  .highlight .sr, .highlight .ss { color: #a5d6ff; }
  .highlight .m, .highlight .mf, .highlight .mh, .highlight .mi, .highlight .mo,
  .highlight .il { color: #79c0ff; }
  .highlight .n, .highlight .na, .highlight .nb, .highlight .nc, .highlight .nd,
  .highlight .ne, .highlight .nf, .highlight .ni, .highlight .nl, .highlight .nn,
  .highlight .no, .highlight .nt, .highlight .nv { color: #e6edf3; }
  .highlight .o, .highlight .ow, .highlight .p { color: #e6edf3; }
  .highlight .err { color: #ff7b72; }
}

/* ---- footer ---- */
footer.page {
  margin-top: 48px; padding: 20px 0 40px;
  border-top: 1px solid var(--border);
  color: var(--muted); font-size: 13px;
}

@media (max-width: 1000px) {
  .layout { flex-direction: column; gap: 20px; }
  nav.toc { position: static; flex: 1 1 auto; width: 100%; max-height: none; }
  .anchor { display: none; }
}
@media print {
  nav.toc, header.page, footer.page { display: none; }
  body { font-size: 11pt; }
  main pre { white-space: pre-wrap; word-break: break-all; }
  .table-wrap { overflow: visible; }
}
"""

JS = """
// Smooth-scroll + highlight TOC item theo heading dang xem
(function () {
  var links = Array.prototype.slice.call(
    document.querySelectorAll('nav.toc a[href^="#"]')
  );
  var map = {};
  var targets = [];
  links.forEach(function (a) {
    var id = decodeURIComponent(a.getAttribute('href').slice(1));
    var el = document.getElementById(id);
    if (!el) return;
    map[id] = a;
    targets.push(el);
  });

  function clear() {
    links.forEach(function (a) { a.classList.remove('active'); });
  }

  if ('IntersectionObserver' in window && targets.length) {
    var visible = new Set();
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) visible.add(e.target.id);
        else visible.delete(e.target.id);
      });
      var first = null;
      targets.forEach(function (t) { if (!first && visible.has(t.id)) first = t.id; });
      clear();
      if (first && map[first]) map[first].classList.add('active');
    }, { rootMargin: '0px 0px -70% 0px', threshold: 0 });
    targets.forEach(function (t) { io.observe(t); });
  }

  // Nut "Ve dau trang"
  var top = document.createElement('a');
  top.href = '#';
  top.className = 'anchor';
  top.title = 'Ve dau trang';
  top.textContent = '\\u2191';
  top.style.cssText = 'position:fixed;right:22px;bottom:22px;z-index:99;' +
    'background:var(--surface);border:1px solid var(--border);border-radius:50%;' +
    'width:38px;height:38px;display:flex;align-items:center;justify-content:center;' +
    'font-size:18px;box-shadow:0 2px 8px rgba(0,0,0,.18)';
  top.addEventListener('click', function (e) {
    e.preventDefault();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  document.body.appendChild(top);
})();
"""


def build(md_src: str, title: str) -> str:
    md = build_parser()
    tokens = md.parse(md_src)
    toc = add_ids_and_build_toc(md, tokens)

    # highlight code fence
    def fence_render(tokens, idx, options, env):
        token = tokens[idx]
        info = (token.info or "").strip().split()
        lang = info[0] if info else ""
        out = _highlight_code(token.content, lang)
        return out + "\n"

    md.renderer.rules["fence"] = fence_render

    # markdown-it-py 4.x chi co 9 rule mac dinh; heading/table phai override
    # qua renderToken de them wrapper va gan id.
    orig_render_token = md.renderer.renderToken

    def render_token(tokens, idx, options, env):
        token = tokens[idx]
        if token.type == "heading_open":
            anchor = token.attrGet("id") or ""
            return (
                '<h%d id="%s"><a class="anchor" href="#%s" aria-hidden="true">#</a>'
                % (int(token.tag[1:]), html.escape(anchor), html.escape(anchor))
            )
        if token.type == "table_open":
            return '<div class="table-wrap">\n<table>\n'
        if token.type == "table_close":
            return "</table>\n</div>\n"
        return orig_render_token(tokens, idx, options, env)

    md.renderer.renderToken = render_token

    body = md.renderer.render(tokens, md.options, {})

    return TEMPLATE.format(
        title=html.escape(title),
        css=CSS,
        js=JS,
        toc=render_toc(toc),
        body=body,
    )


def render_toc(toc) -> str:
    """Dung TOC long nhau theo level (chi h2/h3). Cau truc HTML dung chuan."""
    items = [(lvl, text, anchor) for lvl, text, anchor in toc if lvl in (2, 3)]
    if not items:
        return ""

    out = ['<nav class="toc" aria-label="Muc luc">', '<p class="toc-title">Muc luc</p>']

    # nhom theo h2: moi h2 la 1 <li> chua <ol> cua cac h3 con
    groups = []
    for lvl, text, anchor in items:
        if lvl == 2:
            groups.append([text, anchor, []])
        else:
            if not groups:
                groups.append(["", "", []])
            groups[-1][2].append((text, anchor))

    out.append("<ol>")
    for title, anchor, children in groups:
        if title:
            out.append(
                '<li><a href="#%s">%s</a>' % (html.escape(anchor), html.escape(title))
            )
        else:
            out.append("<li>")
        if children:
            out.append("<ol>")
            for ctext, canchor in children:
                out.append(
                    '<li><a href="#%s">%s</a></li>'
                    % (html.escape(canchor), html.escape(ctext))
                )
            out.append("</ol>")
        out.append("</li>")
    out.append("</ol>")
    out.append("</nav>")
    return "".join(out)



TEMPLATE = """<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
{css}
</style>
</head>
<body>
<header class="page">
  <div class="wrap">
    <h1>{title}</h1>
    <span class="meta">Sinh tu <code>SETUP_GUIDE.md</code> — <code>python tools/build-doc-html.py</code></span>
  </div>
</header>

<div class="wrap">
<div class="layout">
{toc}
<main>
{body}
</main>
</div>
</div>

<footer class="page">
  <div class="wrap">
    Auto-Fix Worker — Huong dan setup GlitchTip, Jira, Telegram va Worker.
  </div>
</footer>

<script>
{js}
</script>
</body>
</html>
"""


def main() -> int:
    if len(sys.argv) >= 3:
        src, out = Path(sys.argv[1]), Path(sys.argv[2])
    else:
        src, out = SRC, OUT
    if not src.exists():
        print("Khong tim thay: %s" % src, file=sys.stderr)
        return 1
    md_src = src.read_text(encoding="utf-8")
    first = next((l for l in md_src.splitlines() if l.startswith("# ")), src.stem)
    title = first[2:].strip()
    out.write_text(build(md_src, title), encoding="utf-8")
    print("Da tao %s (%d bytes)" % (out, out.stat().st_size))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
