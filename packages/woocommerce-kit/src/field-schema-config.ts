import { dereference, format, type Schema, Validator } from "@cfworker/json-schema"
import metaSchema from "./json-schema-draft07.json"
import type { FieldSchema } from "./types"

// The official draft-07 meta-schema checks keyword shapes, not their meaning against shopper values.
// Source: https://json-schema.org/draft-07/schema
const schemaValidator = new Validator(
	structuredClone({ ...metaSchema, properties: { ...metaSchema.properties, $defs: metaSchema.properties.definitions } }) as Schema,
	"7",
	false,
)
const keywords = new Set([...Object.keys(metaSchema.properties), "$defs"])
const singleSchemas = ["additionalItems", "additionalProperties", "contains", "propertyNames", "not", "if", "then", "else"]
const schemaLists = ["allOf", "anyOf", "oneOf"]
const schemaMaps = ["definitions", "$defs", "properties", "patternProperties"]

export function prepareFieldSchema(schema: FieldSchema) {
	// CFWorker attaches reference metadata. Never attach it to the cached storefront response or a frozen consumer schema.
	const copy = structuredClone(schema) as Schema | boolean
	if (!schemaValidator.validate(copy).valid) return undefined
	checkSupported(copy)
	const lookup = dereference(copy)
	for (const node of Object.values(lookup)) {
		if (typeof node === "object" && node.$ref !== undefined && !Object.hasOwn(lookup, node.__absolute_ref__ ?? "")) return undefined
	}
	return { schema: copy, lookup, validator: new Validator(copy, "7", false) }
}

function checkSupported(schema: Schema | boolean): void {
	if (typeof schema === "boolean") return
	if (!schema || typeof schema !== "object" || Array.isArray(schema)) throw new Error("Invalid schema")
	for (const key of Object.keys(schema)) if (!keywords.has(key)) throw new Error("Unsupported schema keyword")
	if (schema.$schema !== undefined && !/^https?:\/\/json-schema\.org\/draft-07\/schema#?$/.test(schema.$schema))
		throw new Error("Unsupported schema draft")
	for (const keyword of ["const", "enum"]) {
		const value = schema[keyword]
		const dynamic = (value: unknown): boolean => {
			if (!value || typeof value !== "object") return false
			if (Object.hasOwn(value, "$data")) return true
			return Object.values(value).some(dynamic)
		}
		if (dynamic(value)) throw new Error("Unsupported dynamic value")
	}
	if (schema.format !== undefined && !Object.hasOwn(format, schema.format)) throw new Error("Unsupported schema format")
	if (schema.pattern !== undefined) new RegExp(schema.pattern, "u")
	for (const pattern of Object.keys(schema.patternProperties ?? {})) new RegExp(pattern, "u")
	for (const key of singleSchemas) if (schema[key] !== undefined) checkSupported(schema[key])
	for (const key of schemaLists) for (const child of schema[key] ?? []) checkSupported(child)
	for (const key of schemaMaps) for (const child of Object.values(schema[key] ?? {})) checkSupported(child as Schema | boolean)
	if (Array.isArray(schema.items)) schema.items.forEach(checkSupported)
	else if (schema.items !== undefined) checkSupported(schema.items)
	for (const child of Object.values(schema.dependencies ?? {})) if (!Array.isArray(child)) checkSupported(child)
}

/** Rebase references to a distinct resource before embedding a standalone field schema. */
export function scopeFieldSchema(schema: FieldSchema, resource: string): { schema: FieldSchema; kind: string | undefined } | undefined {
	const prepared = prepareFieldSchema(schema)
	if (!prepared) return undefined
	if (typeof prepared.schema === "boolean") return { schema: prepared.schema, kind: undefined }
	const lookup = prepared.lookup
	const pointers = new Map<object, string>()
	function visit(value: unknown, pointer: string): void {
		if (!value || typeof value !== "object") return
		pointers.set(value, pointer)
		for (const [key, child] of Object.entries(value)) visit(child, `${pointer}/${encodeURI(key.replace(/~/g, "~0").replace(/\//g, "~1"))}`)
	}
	visit(prepared.schema, "")
	function types(node: Schema | boolean | undefined, parents = new Set<object>()): Set<string> | undefined {
		if (node === undefined || typeof node === "boolean" || parents.has(node)) return undefined
		const seen = new Set(parents).add(node)
		if (node.$ref !== undefined) return types(lookup[node.__absolute_ref__ ?? ""], seen)
		let result: Set<string> | undefined = node.type === undefined ? undefined : new Set(Array.isArray(node.type) ? node.type : [node.type])
		for (const child of node.allOf ?? []) {
			const next = types(child, seen)
			if (next) result = result ? new Set([...result].filter((type) => next.has(type))) : next
		}
		for (const keyword of ["anyOf", "oneOf"] as const) {
			const branches = node[keyword]
			if (!branches) continue
			const alternatives = branches.map((child) => types(child, seen))
			if (alternatives.some((types) => !types)) continue
			const union = new Set(alternatives.flatMap((types) => [...(types ?? [])]))
			result = result ? new Set([...result].filter((type) => union.has(type))) : union
		}
		return result
	}
	const inferred = types(prepared.schema)
	const kind = inferred?.size === 1 ? [...inferred][0] : undefined
	// Only schema nodes have identifiers; literal shopper objects remain unchanged.
	for (const node of new Set(Object.values(prepared.lookup))) {
		if (typeof node === "boolean") continue
		if (node.$ref !== undefined) {
			const target = prepared.lookup[node.__absolute_ref__ ?? ""]
			if (typeof target === "boolean") {
				for (const key of Object.keys(node)) delete node[key]
				if (!target) node.not = {}
				continue
			}
			if (!target) return undefined
			const pointer = pointers.get(target)
			if (pointer === undefined || (!pointer.startsWith("/") && pointer !== "")) return undefined
			node.$ref = `${resource}#${pointer}`
		}
		delete node.$id
	}
	// Drop validator metadata, which describes the former resource scope.
	const scoped = structuredClone(prepared.schema)
	scoped.$id = resource
	return { schema: scoped as FieldSchema, kind }
}
