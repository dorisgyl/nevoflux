/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

//! Markdown → HTML for chat messages, built on pulldown-cmark.
//!
//! Lives in its own dependency-light crate so `cargo test -p markdown-render`
//! runs on the host target (the chat-sidebar crate itself cannot compile a
//! native test binary: its dioxus-web dependency graph exports a second
//! `main` entry symbol).
//!
//! Custom event writer instead of `html::push_html` because we need:
//! - the existing `.code-block/.code-header/.code-copy-btn` structure
//! - `target="_blank" rel="noopener"` + a URL-scheme allowlist on links
//! - raw HTML escaped to text (LLM/webpage content is untrusted)
//! - tables wrapped in a horizontal-scroll container (`.md-table-wrap`)

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            _ => out.push(c),
        }
    }
    out
}

fn escape_attr(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

fn is_safe_link(url: &str) -> bool {
    let u = url.trim().to_ascii_lowercase();
    u.starts_with("http://") || u.starts_with("https://") || u.starts_with("mailto:")
}

fn is_safe_image(url: &str) -> bool {
    let u = url.trim().to_ascii_lowercase();
    u.starts_with("http://") || u.starts_with("https://") || u.starts_with("data:image/")
}

fn heading_tag(level: HeadingLevel) -> &'static str {
    match level {
        HeadingLevel::H1 => "h1",
        HeadingLevel::H2 => "h2",
        HeadingLevel::H3 => "h3",
        HeadingLevel::H4 => "h4",
        HeadingLevel::H5 => "h5",
        HeadingLevel::H6 => "h6",
    }
}

/// Render untrusted markdown into the HTML fragment the chat sidebar injects
/// via `dangerous_inner_html`. Never panics on malformed or truncated input.
pub fn render_markdown(md: &str) -> String {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);

    let parser = Parser::new_ext(md, opts);
    let mut out = String::new();

    // Code blocks collect raw text until End so the whole payload is escaped
    // once and wrapped in the copy-button structure the CSS expects.
    let mut code_lang: Option<String> = None;
    let mut code_buf = String::new();
    // Table state: header cells become <th>.
    let mut in_table_head = false;
    // Links with a disallowed scheme render their children as plain text.
    let mut suppressed_link_depth = 0usize;

    for event in parser {
        match event {
            Event::Start(tag) => match tag {
                Tag::Paragraph => out.push_str("<p>"),
                Tag::Heading { level, .. } => {
                    out.push('<');
                    out.push_str(heading_tag(level));
                    out.push('>');
                }
                Tag::BlockQuote(_) => out.push_str("<blockquote>"),
                Tag::CodeBlock(kind) => {
                    let lang = match kind {
                        CodeBlockKind::Fenced(info) => {
                            let first = info.split_whitespace().next().unwrap_or("");
                            if first.is_empty() {
                                "code".to_string()
                            } else {
                                first.to_string()
                            }
                        }
                        CodeBlockKind::Indented => "code".to_string(),
                    };
                    code_lang = Some(lang);
                    code_buf.clear();
                }
                Tag::List(Some(start)) => {
                    if start == 1 {
                        out.push_str("<ol>");
                    } else {
                        out.push_str(&format!("<ol start=\"{start}\">"));
                    }
                }
                Tag::List(None) => out.push_str("<ul>"),
                Tag::Item => out.push_str("<li>"),
                Tag::Table(_) => out.push_str("<div class=\"md-table-wrap\"><table>"),
                Tag::TableHead => {
                    in_table_head = true;
                    out.push_str("<thead><tr>");
                }
                Tag::TableRow => out.push_str("<tr>"),
                Tag::TableCell => out.push_str(if in_table_head { "<th>" } else { "<td>" }),
                Tag::Emphasis => out.push_str("<em>"),
                Tag::Strong => out.push_str("<strong>"),
                Tag::Strikethrough => out.push_str("<del>"),
                Tag::Link { dest_url, .. } => {
                    if is_safe_link(&dest_url) {
                        out.push_str(&format!(
                            "<a href=\"{}\" target=\"_blank\" rel=\"noopener\">",
                            escape_attr(&dest_url)
                        ));
                    } else {
                        suppressed_link_depth += 1;
                    }
                }
                Tag::Image { dest_url, .. } => {
                    // Alt-text children still arrive as Text events and render
                    // after the image as plain text; acceptable for chat.
                    if is_safe_image(&dest_url) {
                        out.push_str(&format!(
                            "<img src=\"{}\" alt=\"\" style=\"max-width:100%;border-radius:8px;\" />",
                            escape_attr(&dest_url)
                        ));
                    }
                }
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Paragraph => out.push_str("</p>"),
                TagEnd::Heading(level) => {
                    out.push_str("</");
                    out.push_str(heading_tag(level));
                    out.push('>');
                }
                TagEnd::BlockQuote(_) => out.push_str("</blockquote>"),
                TagEnd::CodeBlock => {
                    let lang = code_lang.take().unwrap_or_else(|| "code".to_string());
                    out.push_str(&format!(
                        "<div class=\"code-block\"><div class=\"code-header\"><span class=\"code-language\">{}</span><button class=\"code-copy-btn\">Copy</button></div><div class=\"code-content\"><pre>{}</pre></div></div>",
                        escape_html(&lang),
                        escape_html(code_buf.trim_end_matches('\n'))
                    ));
                    code_buf.clear();
                }
                TagEnd::List(true) => out.push_str("</ol>"),
                TagEnd::List(false) => out.push_str("</ul>"),
                TagEnd::Item => out.push_str("</li>"),
                TagEnd::Table => out.push_str("</tbody></table></div>"),
                TagEnd::TableHead => {
                    in_table_head = false;
                    out.push_str("</tr></thead><tbody>");
                }
                TagEnd::TableRow => out.push_str("</tr>"),
                TagEnd::TableCell => out.push_str(if in_table_head { "</th>" } else { "</td>" }),
                TagEnd::Emphasis => out.push_str("</em>"),
                TagEnd::Strong => out.push_str("</strong>"),
                TagEnd::Strikethrough => out.push_str("</del>"),
                TagEnd::Link => {
                    if suppressed_link_depth > 0 {
                        suppressed_link_depth -= 1;
                    } else {
                        out.push_str("</a>");
                    }
                }
                TagEnd::Image => {}
                _ => {}
            },
            Event::Text(text) => {
                if code_lang.is_some() {
                    code_buf.push_str(&text);
                } else {
                    out.push_str(&escape_html(&text));
                }
            }
            Event::Code(code) => {
                out.push_str(&format!("<code>{}</code>", escape_html(&code)));
            }
            Event::Html(html) | Event::InlineHtml(html) => {
                // Untrusted: raw HTML becomes visible text.
                out.push_str(&escape_html(&html));
            }
            Event::SoftBreak | Event::HardBreak => {
                if code_lang.is_some() {
                    code_buf.push('\n');
                } else {
                    out.push_str("<br>");
                }
            }
            Event::Rule => out.push_str("<hr>"),
            Event::TaskListMarker(checked) => {
                out.push_str(if checked {
                    "<input type=\"checkbox\" disabled checked> "
                } else {
                    "<input type=\"checkbox\" disabled> "
                });
            }
            Event::FootnoteReference(name) => {
                out.push_str(&escape_html(&name));
            }
            _ => {}
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cross_line_bold_renders() {
        let html = render_markdown("**bold\ntext**");
        assert!(html.contains("<strong>"), "{html}");
        assert!(!html.contains("**"), "{html}");
    }

    #[test]
    fn heading_with_space_renders() {
        let html = render_markdown("## Title");
        assert!(html.contains("<h2>Title</h2>"), "{html}");
    }

    #[test]
    fn heading_without_space_is_literal() {
        let html = render_markdown("##NoSpace");
        assert!(!html.contains("<h2>"), "{html}");
        assert!(html.contains("##NoSpace"), "{html}");
    }

    #[test]
    fn gfm_table_renders_with_wrap() {
        let html = render_markdown("| A | B |\n|---|---|\n| 1 | 2 |");
        assert!(html.contains("md-table-wrap"), "{html}");
        assert!(html.contains("<th>A</th>"), "{html}");
        assert!(html.contains("<td>1</td>"), "{html}");
        assert!(html.contains("</tbody></table></div>"), "{html}");
    }

    #[test]
    fn code_block_keeps_copy_structure() {
        let html = render_markdown("```rust\nfn main() {}\n```");
        assert!(html.contains("code-language\">rust<"), "{html}");
        assert!(html.contains("code-copy-btn"), "{html}");
        assert!(html.contains("fn main() {}"), "{html}");
    }

    #[test]
    fn raw_html_is_escaped() {
        let html = render_markdown("hello <script>alert(1)</script>");
        assert!(!html.contains("<script>"), "{html}");
        assert!(html.contains("&lt;script&gt;"), "{html}");
    }

    #[test]
    fn javascript_link_is_rejected() {
        let html = render_markdown("[click](javascript:alert(1))");
        assert!(!html.contains("<a "), "{html}");
        assert!(html.contains("click"), "{html}");
    }

    #[test]
    fn https_link_gets_blank_target() {
        let html = render_markdown("[x](https://example.com)");
        assert!(
            html.contains(
                "<a href=\"https://example.com\" target=\"_blank\" rel=\"noopener\">x</a>"
            ),
            "{html}"
        );
    }

    #[test]
    fn nested_lists_render() {
        let html = render_markdown("- a\n  - b\n- c");
        assert!(html.matches("<ul>").count() >= 2, "{html}");
        assert!(html.contains("<li>a"), "{html}");
    }

    #[test]
    fn task_list_renders_checkboxes() {
        let html = render_markdown("- [x] done\n- [ ] todo");
        assert!(html.contains("checkbox\" disabled checked"), "{html}");
        assert!(html.contains("checkbox\" disabled>"), "{html}");
    }

    #[test]
    fn strikethrough_renders() {
        let html = render_markdown("~~gone~~");
        assert!(html.contains("<del>gone</del>"), "{html}");
    }

    #[test]
    fn truncated_input_does_not_panic() {
        for s in ["**abc", "|a|b|\n|-", "```rust\nfn x(", "[link](", "# "] {
            let _ = render_markdown(s);
        }
    }

    #[test]
    fn blockquote_renders() {
        let html = render_markdown("> quoted");
        assert!(html.contains("<blockquote>"), "{html}");
    }
}
