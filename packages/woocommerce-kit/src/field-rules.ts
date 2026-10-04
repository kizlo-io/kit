import { compileFieldSchema } from "./field-schema"
import type { StorefrontFieldRule } from "./types"

export type LocalFieldDocument = { value: Record<string, unknown>; complete: ReadonlySet<string> }

/** Undefined means the field's condition is unsupported: callers skip only that field. */
export function evaluateFieldRule(rule: StorefrontFieldRule, document: LocalFieldDocument): boolean | undefined {
	if (typeof rule === "boolean") return rule
	if (!rule || typeof rule !== "object" || Array.isArray(rule)) return undefined
	if (!Object.keys(rule).length) return false
	try {
		// Compatibility with older raw Woo shorthand; new storefront definitions are already JSON Schema.
		const schema = ["cart", "customer", "checkout"].some((key) => Object.hasOwn(rule, key)) ? { type: "object", properties: rule } : rule
		const evaluate = compileFieldSchema(schema)
		if (!evaluate || unavailable(schema, document.value, [], document.complete)) return undefined
		const matches = evaluate(document.value)
		return evaluate.unsupported ? undefined : matches
	} catch {
		return undefined
	}
}

function unavailable(schema: unknown, value: unknown, path: readonly string[], complete: ReadonlySet<string>): boolean {
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false
	const node = schema as Record<string, unknown>
	if (node.$ref !== undefined || node.$async !== undefined) return true
	const object = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
	const known = complete.has(JSON.stringify(path))
	// Object-wide assertions cannot be evaluated from an intentionally partial Woo document.
	if (
		!known &&
		value &&
		typeof value === "object" &&
		["patternProperties", "propertyNames", "additionalProperties", "minProperties", "maxProperties", "const", "enum"].some((key) =>
			Object.hasOwn(node, key),
		)
	)
		return true
	if (Array.isArray(node.required) && !known && node.required.some((key) => typeof key === "string" && !Object.hasOwn(object, key)))
		return true
	const properties = node.properties && typeof node.properties === "object" ? (node.properties as Record<string, unknown>) : {}
	for (const [key, child] of Object.entries(properties)) {
		if (!Object.hasOwn(object, key) && !known) return true
		if (unavailable(child, object[key], [...path, key], complete)) return true
	}
	for (const keyword of ["allOf", "anyOf", "oneOf", "not"] as const) {
		const branches = node[keyword]
		for (const branch of Array.isArray(branches) ? branches : [branches]) if (unavailable(branch, value, path, complete)) return true
	}
	if (node.dependencies && typeof node.dependencies === "object") {
		for (const [key, dependency] of Object.entries(node.dependencies)) {
			if (!Object.hasOwn(object, key)) {
				if (!known) return true
				continue
			}
			if (Array.isArray(dependency)) {
				if (!known && dependency.some((key) => typeof key === "string" && !Object.hasOwn(object, key))) return true
			} else if (unavailable(dependency, value, path, complete)) return true
		}
	}
	if (node.if !== undefined) {
		if (unavailable(node.if, value, path, complete)) return true
		const evaluate = compileFieldSchema(node.if as StorefrontFieldRule)
		if (!evaluate) return true
		const matches = evaluate(value)
		if (evaluate.unsupported || unavailable(matches ? node.then : node.else, value, path, complete)) return true
	}
	return false
}
