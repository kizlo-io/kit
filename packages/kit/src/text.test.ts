import { describe, expect, it } from "vitest"
import { decodeHtmlEntities } from "./text"

describe("decodeHtmlEntities", () => {
	it("returns text without entities untouched", () => {
		expect(decodeHtmlEntities("Leather bag")).toBe("Leather bag")
	})

	it("decodes the numeric references wptexturize emits", () => {
		expect(decodeHtmlEntities("Kid&#8217;s &#8220;best&#8221; bag")).toBe("Kid’s “best” bag")
		expect(decodeHtmlEntities("&#x2014; dash")).toBe("— dash")
	})

	it("decodes the named entities WordPress escaping emits", () => {
		expect(decodeHtmlEntities("Salt &amp; Pepper")).toBe("Salt & Pepper")
		expect(decodeHtmlEntities("&lt;tag&gt;")).toBe("<tag>")
	})

	it("leaves anything outside the named map verbatim", () => {
		expect(decodeHtmlEntities("&hellip;")).toBe("&hellip;")
		expect(decodeHtmlEntities("&#1114112;")).toBe("&#1114112;")
	})
})
