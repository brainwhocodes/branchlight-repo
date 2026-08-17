import { Marked } from "@oh-my-pi/pi-utils/marked";

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function safeHref(value: string): string | null {
	const href = value.trim();
	if (/^(?:https:|mailto:)/i.test(href)) return href;
	if (/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(href)) return href;
	if (/^#[A-Za-z0-9._-]+$/.test(href)) return href;
	if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
	return null;
}

const markdown = new Marked({
	gfm: true,
	breaks: true,
	renderer: {
		html({ text }) {
			return escapeHtml(text);
		},
		link({ href, title, tokens }) {
			const inner = this.parser.parseInline(tokens);
			const safe = safeHref(href);
			if (!safe) return inner;
			const titleAttr = title ? ` title="${escapeHtml(title)}"` : "";
			const target = safe.startsWith("#") ? "" : ' target="_blank" rel="noopener"';
			return `<a href="${escapeHtml(safe)}"${titleAttr}${target}>${inner}</a>`;
		},
	},
});
const markdownCache = new Map<string, string>();

export function renderMarkdown(value: string): string {
	if (value.length > 64 * 1024) {
		try {
			return `<pre class="large-markdown">${escapeHtml(value)}</pre>`;
		} catch {
			return escapeHtml(value);
		}
	}
	if (markdownCache.has(value)) return markdownCache.get(value) ?? "";
	let rendered: string;
	try {
		rendered = markdown.parse(value, { async: false });
	} catch {
		rendered = escapeHtml(value);
	}
	if (markdownCache.size >= 512) {
		const first = markdownCache.keys().next().value;
		if (first !== undefined) markdownCache.delete(first);
	}
	markdownCache.set(value, rendered);
	return rendered;
}
