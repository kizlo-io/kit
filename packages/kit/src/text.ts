const NAMED_HTML_ENTITIES: Record<string, string> = {
	amp: "&",
	apos: "'",
	gt: ">",
	lt: "<",
	nbsp: " ",
	quot: '"',
}

/**
 * Decodes the HTML entities WordPress leaves in `rendered` text fields.
 *
 * Only for text destined for a text node — labels, titles, alt text. Rich content stays HTML and gets rendered as such.
 * `wptexturize` emits numeric references (`&#8217;`, `&#8220;`) far more often than named ones, so numeric handling is the
 * part that actually matters here. The named map covers what WordPress's escaping actually emits; anything outside it is
 * left verbatim rather than growing this into a full HTML5 entity table.
 *
 * @example
 * ```tsx
 * decodeHtmlEntities("Kid&#8217;s &#8220;best&#8221; bag") // "Kid’s “best” bag"
 *
 * <h1>{decodeHtmlEntities(product.name)}</h1>
 * ```
 */
export function decodeHtmlEntities(text: string): string {
	if (!text.includes("&")) return text

	return text.replace(/&(#\d+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
		if (entity.startsWith("#")) {
			const codePoint = entity[1] === "x" || entity[1] === "X" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1))
			return Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match
		}

		return NAMED_HTML_ENTITIES[entity.toLowerCase()] ?? match
	})
}
