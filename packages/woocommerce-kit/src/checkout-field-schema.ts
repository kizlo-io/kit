import Ajv, { type ErrorObject, type ValidateFunction } from "ajv"
import addErrors from "ajv-errors"
import addFormats from "ajv-formats"
import type { ConditionDocument } from "./checkout-field-document"
import { readPath } from "./field-metadata"
import type { FieldSchema } from "./types"

type Node = Record<string, unknown>
export type FieldIssue = { message: string; path: (string | number)[] }
const compiled = new Map<string, ValidateFunction>()
const schemaMaps = ["properties", "patternProperties", "definitions", "$defs"]
const schemaSingles = ["not", "if", "then", "else", "additionalProperties", "additionalItems", "contains", "propertyNames"]
const schemaLists = ["allOf", "anyOf", "oneOf"]
function object(value: unknown): Node | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Node) : undefined
}
export function pointerPath(pointer: string): string[] {
	return pointer
		.split("/")
		.slice(1)
		.map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
}

function children(node: Node): unknown[] {
	const result = schemaMaps.flatMap((key) => Object.values(object(node[key]) ?? {}))
	for (const key of schemaSingles) if (node[key] !== undefined) result.push(node[key])
	for (const key of schemaLists) if (Array.isArray(node[key])) result.push(...node[key])
	if (node.items !== undefined) result.push(...(Array.isArray(node.items) ? node.items : [node.items]))
	result.push(...Object.values(object(node.dependencies) ?? {}).filter((value) => !Array.isArray(value)))
	return result
}

/** Rebase field resources to pointers inside one isolated document schema. */
function isolateReferences(schema: FieldSchema): FieldSchema {
	const copy = structuredClone(schema)
	const resources = new Map<string, string>()
	const anchors = new Map<string, string>()
	const nodes: { node: Node; base: string }[] = []
	const rootId = "https://kizlo.invalid/compiled-document"
	resources.set(rootId, "")
	const escapePointer = (key: string) => key.replace(/~/g, "~0").replace(/\//g, "~1")
	function visit(value: unknown, path: string, base: string) {
		const node = object(value)
		if (!node) return
		const id = typeof node.$id === "string" ? new URL(node.$id, base).href : base
		if (node.$id !== undefined) {
			if (id.includes("#")) anchors.set(id, path)
			else resources.set(id, path)
		}
		nodes.push({ node, base: id })
		for (const key of schemaMaps)
			for (const [name, child] of Object.entries(object(node[key]) ?? {})) visit(child, `${path}/${key}/${escapePointer(name)}`, id)
		for (const key of schemaSingles) visit(node[key], `${path}/${key}`, id)
		for (const key of schemaLists)
			if (Array.isArray(node[key]))
				node[key].forEach((child, i) => {
					visit(child, `${path}/${key}/${i}`, id)
				})
		if (Array.isArray(node.items))
			node.items.forEach((child, i) => {
				visit(child, `${path}/items/${i}`, id)
			})
		else visit(node.items, `${path}/items`, id)
		for (const [name, child] of Object.entries(object(node.dependencies) ?? {}))
			if (!Array.isArray(child)) visit(child, `${path}/dependencies/${escapePointer(name)}`, id)
	}
	visit(copy, "", rootId)
	for (const { node, base } of nodes) {
		if (typeof node.$ref === "string") {
			const url = new URL(node.$ref, base)
			const resource = resources.get(url.href.split("#")[0] ?? url.href)
			const fragment = decodeURIComponent(url.hash.slice(1))
			const target =
				fragment && !fragment.startsWith("/") ? anchors.get(url.href) : resource === undefined ? undefined : `${resource}${fragment}`
			if (target === undefined || readPath(copy, pointerPath(target)) === undefined) throw new Error("Unavailable schema reference")
			node.$ref = `#${target}`
		}
		delete node.$id
	}
	return copy
}

export function checkoutSchemaKind(schema: FieldSchema): string | undefined {
	const root = isolateReferences(schema)
	function types(value: unknown, seen = new Set<unknown>()): Set<string> | undefined {
		const node = object(value)
		if (!node || seen.has(node)) return undefined
		const parents = new Set(seen).add(node)
		if (typeof node.$ref === "string") return types(readPath(root, pointerPath(node.$ref.slice(1))), parents)
		let result =
			typeof node.type === "string" ? new Set([node.type]) : Array.isArray(node.type) ? new Set(node.type as string[]) : undefined
		for (const child of Array.isArray(node.allOf) ? node.allOf : []) {
			const next = types(child, parents)
			if (next) result = result ? new Set([...result].filter((type) => next.has(type))) : next
		}
		for (const key of ["anyOf", "oneOf"]) {
			if (!Array.isArray(node[key])) continue
			const branches = node[key].map((child) => types(child, parents))
			if (branches.some((branch) => !branch)) continue
			const union = new Set(branches.flatMap((branch) => [...(branch ?? [])]))
			result = result ? new Set([...result].filter((type) => union.has(type))) : union
		}
		return result
	}
	const result = types(root)
	return result?.size === 1 ? [...result][0] : undefined
}

/** Each cached compiler owns only schema resources, never a shopper document. */
export function compileCheckoutSchema(schema: FieldSchema): ValidateFunction {
	const key = JSON.stringify(schema)
	const cached = compiled.get(key)
	if (cached) return cached
	const ajv = new Ajv({ allErrors: true, $data: true, strict: false, strictSchema: true, validateFormats: true, ownProperties: true })
	addFormats(ajv, { mode: "fast", formats: ["date", "time", "uri"], keywords: true })
	// Woo's frontend uses PHP-compatible email validation rather than AJV's default format.
	ajv.addFormat(
		"email",
		/^(?!.*[.]{2})[a-zA-Z0-9](?:[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]*[a-zA-Z0-9])?@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*\.[a-zA-Z]{2,}$/i,
	)
	addErrors(ajv)
	const copy = isolateReferences(schema)
	function check(value: unknown) {
		const node = object(value)
		if (!node) return
		if (node.$async !== undefined) throw new Error("Asynchronous field schemas are unsupported")
		if (node.$schema !== undefined) {
			if (typeof node.$schema !== "string" || !/^https?:\/\/json-schema\.org\/draft-07\/schema#?$/.test(node.$schema))
				throw new Error("Only draft-07 field schemas are supported")
			node.$schema = "http://json-schema.org/draft-07/schema#"
		}
		children(node).forEach(check)
	}
	check(copy)
	const validate = ajv.compile(copy)
	if (compiled.size >= 128) compiled.delete(compiled.keys().next().value as string)
	compiled.set(key, validate)
	return validate
}

/** Wrap a value at its Woo path so absolute and relative $data read the same document as conditions. */
export function valueSchema(schema: FieldSchema, path: readonly string[], required: boolean): FieldSchema {
	const copy = structuredClone(schema)
	let wrapped: FieldSchema = copy
	for (const key of [...path].reverse())
		wrapped = { type: "object", properties: { [key]: wrapped }, ...(required ? { required: [key] } : {}) }
	return wrapped
}

/** Missing supported optional values differ from dependencies absent from the producer contract. */
export function unavailableDependency(inputSchema: FieldSchema, document: ConditionDocument): string | undefined {
	const schema = isolateReferences(inputSchema)
	function complete(path: readonly string[]): boolean {
		return (
			[...document.complete].some((key) => {
				const prefix = JSON.parse(key) as string[]
				return prefix.every((key, i) => path[i] === key)
			}) &&
			![...document.unavailable].some((key) => {
				const missing = JSON.parse(key) as string[]
				return missing.every((key, i) => path[i] === key) || path.every((key, i) => missing[i] === key)
			})
		)
	}
	function known(path: readonly string[]): boolean {
		if (
			[...document.unavailable].some((key) => {
				const missing = JSON.parse(key) as string[]
				return missing.every((key, i) => path[i] === key)
			})
		)
			return false
		if (readPath(document.value, path) !== undefined) return true
		return [...document.complete].some((key) => {
			const prefix = JSON.parse(key) as string[]
			return prefix.every((key, i) => path[i] === key)
		})
	}
	function visit(value: unknown, path: string[], depth: number): string | undefined {
		const node = object(value)
		if (!node) return undefined
		if (depth > 64) return "Recursive dependency could not be resolved"
		if (typeof node.$ref === "string") {
			const target = readPath(schema, pointerPath(node.$ref.slice(1)))
			if (target === undefined) return "Unavailable schema reference"
			const missing = visit(target, path, depth + 1)
			if (missing) return missing
		}
		for (const [keyword, child] of Object.entries(node)) {
			const dynamic = object(child)
			if (typeof dynamic?.$data !== "string") continue
			const pointer = dynamic.$data
			let target: string[]
			if (pointer.startsWith("/")) target = pointerPath(pointer)
			else {
				const match = /^(\d+)(\/.*|#)?$/.exec(pointer)
				if (!match || Number(match[1]) > path.length) return "Unsupported $data pointer"
				target = [...path.slice(0, path.length - Number(match[1])), ...pointerPath(match[2] ?? "")]
			}
			if (!known(target)) return `Unavailable ${keyword} dependency: ${JSON.stringify(target)}`
			const data = readPath(document.value, target)
			if (data && typeof data === "object" && !complete(target)) return `Incomplete $data dependency: ${JSON.stringify(target)}`
		}
		for (const [key, child] of Object.entries(object(node.properties) ?? {})) {
			const target = [...path, key]
			if (!known(target)) return `Unavailable condition data: ${JSON.stringify(target)}`
			const missing = visit(child, target, depth + 1)
			if (missing) return missing
		}
		if (Array.isArray(node.required))
			for (const key of node.required) {
				if (typeof key === "string" && !known([...path, key])) return `Unavailable required dependency: ${JSON.stringify([...path, key])}`
			}
		if (
			["additionalProperties", "patternProperties", "propertyNames", "minProperties", "maxProperties", "const", "enum"].some(
				(key) => node[key] !== undefined,
			)
		) {
			// Root/cart/customer are intentionally partial; object-wide assertions would claim completeness we do not have.
			const actual = readPath(document.value, path)
			if (actual && typeof actual === "object" && !complete(path)) return `Incomplete condition object: ${JSON.stringify(path)}`
		}
		for (const key of schemaLists)
			for (const child of Array.isArray(node[key]) ? node[key] : []) {
				const missing = visit(child, path, depth + 1)
				if (missing) return missing
			}
		if (node.if !== undefined) {
			const missing = visit(node.if, path, depth + 1)
			if (missing) return missing
			// Conservatively inspect both branches: an unavailable dependency must never silently become optional.
			for (const child of [node.then, node.else]) {
				const missing = visit(child, path, depth + 1)
				if (missing) return missing
			}
		}
		const missingNot = visit(node.not, path, depth + 1)
		if (missingNot) return missingNot
		for (const [key, dependency] of Object.entries(object(node.dependencies) ?? {})) {
			if (!known([...path, key])) return `Unavailable dependency: ${key}`
			if (readPath(document.value, [...path, key]) === undefined) continue
			if (Array.isArray(dependency)) {
				for (const key of dependency) if (typeof key === "string" && !known([...path, key])) return `Unavailable dependency: ${key}`
			} else {
				const missing = visit(dependency, path, depth + 1)
				if (missing) return missing
			}
		}
		const entries = object(readPath(document.value, path))
		if (entries)
			for (const [key] of Object.entries(entries)) {
				const matches = Object.entries(object(node.patternProperties) ?? {}).filter(([pattern]) => new RegExp(pattern, "u").test(key))
				for (const [, child] of matches) {
					const missing = visit(child, [...path, key], depth + 1)
					if (missing) return missing
				}
				if (!Object.hasOwn(object(node.properties) ?? {}, key) && matches.length === 0) {
					const missing = visit(node.additionalProperties, [...path, key], depth + 1)
					if (missing) return missing
				}
			}
		const missingNames = visit(node.propertyNames, path, depth + 1)
		if (missingNames) return missingNames
		const items = readPath(document.value, path)
		if (Array.isArray(items))
			for (let i = 0; i < items.length; i++) {
				const child = Array.isArray(node.items) ? (node.items[i] ?? node.additionalItems) : node.items
				const missing = visit(child, [...path, String(i)], depth + 1) ?? visit(node.contains, [...path, String(i)], depth + 1)
				if (missing) return missing
			}
		return undefined
	}
	return visit(schema, [], 0)
}

export function fieldSchemaIssues(
	errors: ErrorObject[] | null | undefined,
	documentPath: readonly string[],
	inputPath: readonly string[],
): FieldIssue[] {
	const issues = (errors ?? [])
		.filter((error) => !["if", "anyOf", "oneOf"].includes(error.keyword))
		.map((error) => {
			const path = pointerPath(error.instancePath)
			if (error.keyword === "required" && typeof error.params.missingProperty === "string") path.push(error.params.missingProperty)
			const underField = documentPath.every((key, i) => path[i] === key)
			return { message: error.message ?? "Invalid value", path: [...inputPath, ...(underField ? path.slice(documentPath.length) : [])] }
		})
	// oneOf can fail because multiple branches match, leaving only an aggregate error.
	return issues.length || !errors?.length ? issues : [{ message: errors[0]?.message ?? "Invalid value", path: [...inputPath] }]
}
