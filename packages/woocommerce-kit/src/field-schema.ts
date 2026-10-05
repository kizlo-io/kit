import type { OutputUnit } from "@cfworker/json-schema"
import { prepareFieldSchema } from "./field-schema-config"
import type { FieldSchema, StandardFieldSchema } from "./types"

type Issue = { message: string; path: (string | number)[] }
type CompiledSchema = ((value: unknown) => boolean) & { issues?: Issue[]; unsupported?: boolean }
const compiledSchemas = new WeakMap<object, CompiledSchema>()
const wrapperKeywords = new Set(["properties", "patternProperties", "allOf", "anyOf", "oneOf", "if", "$ref"])

/** A malformed individual plugin schema must not take down the form. */
export function compileFieldSchema(schema: FieldSchema): CompiledSchema | undefined {
	try {
		if (typeof schema === "object" && schema !== null) {
			const cached = compiledSchemas.get(schema)
			if (cached) return cached
		}
		const prepared = prepareFieldSchema(schema)
		if (!prepared) return undefined
		const compiled: CompiledSchema = (value) => {
			compiled.unsupported = false
			if (typeof prepared.schema === "boolean") {
				compiled.issues = prepared.schema ? [] : [{ message: "Invalid value", path: [] }]
				return prepared.schema
			}
			const inputIssues: Issue[] = []
			let input: unknown
			try {
				input = validationValue(value, [], inputIssues, new Set())
			} catch {
				inputIssues.push({ message: "Invalid value", path: [] })
			}
			if (inputIssues.length) {
				compiled.issues = inputIssues
				return false
			}
			try {
				const result = prepared.validator.validate(input)
				const issues = result.errors.flatMap((error) => schemaIssues(error, input, prepared))
				const unique = new Map(issues.map((issue) => [JSON.stringify(issue), issue]))
				compiled.issues = [...unique.values()]
				if (!result.valid && !compiled.issues.length) compiled.issues.push({ message: "Invalid value", path: [] })
				return result.valid
			} catch {
				compiled.unsupported = true
				compiled.issues = []
				return false
			}
		}
		if (typeof schema === "object" && schema !== null) compiledSchemas.set(schema, compiled)
		return compiled
	} catch {
		return undefined
	}
}

export function toStandardSchema<T = unknown>(schema: FieldSchema | ((values: T) => FieldSchema)): StandardFieldSchema<T> {
	const fixed = typeof schema === "function" ? undefined : compileFieldSchema(schema)
	return {
		"~standard": {
			version: 1,
			vendor: "kizlo",
			validate(value) {
				let validate = fixed
				if (typeof schema === "function") {
					try {
						validate = compileFieldSchema(schema(value as T))
					} catch {
						validate = undefined
					}
				}
				// Invalid external schema configuration degrades safely; invalid shopper values still produce issues.
				if (!validate || validate(value) || validate.unsupported) return { value: value as T }
				return { issues: validate.issues ?? [] }
			},
		},
	}
}

/** Omit undefined object properties only in the evaluation copy, retaining original values for submission. */
function validationValue(value: unknown, path: (string | number)[], issues: Issue[], parents: Set<object>): unknown {
	if (value && typeof value === "object") {
		if (parents.has(value)) throw new Error("Cyclic form value")
		parents.add(value)
		let result: unknown
		if (Array.isArray(value)) result = Array.from(value, (child, index) => validationValue(child, [...path, index], issues, parents))
		else {
			const object: Record<string, unknown> = Object.create(null)
			for (const [key, child] of Object.entries(value))
				if (child !== undefined) object[key] = validationValue(child, [...path, key], issues, parents)
			result = object
		}
		parents.delete(value)
		return result
	}
	if (
		value === undefined ||
		typeof value === "bigint" ||
		typeof value === "function" ||
		typeof value === "symbol" ||
		(typeof value === "number" && !Number.isFinite(value))
	) {
		issues.push({ message: "Invalid value", path })
		return null
	}
	return value
}

function pointerPath(pointer: string): string[] {
	return pointer
		.split("/")
		.slice(1)
		.map((part) => decodeURI(part).replace(/~1/g, "/").replace(/~0/g, "~"))
}
function read(value: unknown, path: readonly string[]): unknown {
	for (const key of path) {
		if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined
		value = (value as Record<string, unknown>)[key]
	}
	return value
}
function schemaIssues(error: OutputUnit, input: unknown, prepared: NonNullable<ReturnType<typeof prepareFieldSchema>>): Issue[] {
	const path = pointerPath(error.instanceLocation)
	let node: unknown = prepared.schema
	let owner: unknown
	for (const key of pointerPath(error.keywordLocation)) {
		if (key === "$ref" && node && typeof node === "object" && typeof (node as Record<string, unknown>).$ref === "string") {
			const reference = (node as Record<string, unknown>).__absolute_ref__
			node = typeof reference === "string" ? prepared.lookup[reference] : undefined
		} else {
			owner = node
			node = read(node, [key])
		}
	}
	const parent = read(input, path)
	if (error.keyword === "required" && Array.isArray(node) && parent && typeof parent === "object")
		return node
			.filter((key): key is string => typeof key === "string" && !Object.hasOwn(parent, key))
			.flatMap((key) => requiredPaths(read(owner, ["properties", key]), [...path, key]).map((path) => ({ message: "Required", path })))
	if (error.keyword === "dependencies" && node && typeof node === "object" && parent && typeof parent === "object") {
		const issues: Issue[] = []
		for (const [key, required] of Object.entries(node)) {
			if (!Object.hasOwn(parent, key) || !Array.isArray(required)) continue
			for (const missing of required)
				if (typeof missing === "string" && !Object.hasOwn(parent, missing)) issues.push({ message: "Required", path: [...path, missing] })
		}
		return issues
	}
	return wrapperKeywords.has(error.keyword) ? [] : [{ message: error.error, path }]
}

function requiredPaths(schema: unknown, path: string[]): string[][] {
	if (read(schema, ["$comment"]) !== "kizlo field container") return [path]
	const required = read(schema, ["required"])
	if (!Array.isArray(required) || !required.length) return [path]
	return required.flatMap((key) => requiredPaths(read(schema, ["properties", key]), [...path, key]))
}
