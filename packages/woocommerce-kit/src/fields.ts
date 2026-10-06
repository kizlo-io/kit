import { fieldMetadata, readPath as read, safeFieldPath as safePath } from "./field-metadata"
import { evaluateFieldRule, type LocalFieldDocument } from "./field-rules"
import { compileFieldSchema } from "./field-schema"
import { scopeFieldSchema } from "./field-schema-config"
import type {
	BillingAddressFieldOptions,
	ContactFieldOptions,
	FieldResolverOptions,
	FieldSchema,
	OrderFieldOptions,
	ResolvedField,
	ResolvedFields,
	ShippingAddressFieldOptions,
	StorefrontField,
} from "./types"

type Country = BillingAddressFieldOptions["countries"][number]
type Group = "billing" | "shipping" | "other"

export function resolveBillingAddressFields(options: BillingAddressFieldOptions): ResolvedFields {
	return resolve(options, "address", "billing", options.countries)
}
export function resolveShippingAddressFields(options: ShippingAddressFieldOptions): ResolvedFields {
	return resolve(options, "address", "shipping", options.countries)
}
export function resolveContactFields(options: ContactFieldOptions): ResolvedFields {
	return resolve(options, "contact", "other")
}
export function resolveOrderFields(options: OrderFieldOptions): ResolvedFields {
	return resolve(options, "order", "other")
}

function resolve<T extends object>(
	options: FieldResolverOptions<T>,
	location: StorefrontField["location"],
	group: Group,
	countries: readonly Country[] = [],
): ResolvedFields {
	const { values, prefix = [], presentation = {} } = options
	const definitions = options.fields.filter(
		(field) => field && typeof field.id === "string" && field.bindings && typeof field.bindings === "object",
	)
	const document = localDocument(definitions, values, location, group)
	const result: ResolvedField[] = []
	for (const definition of definitions) {
		if (definition.location !== location) continue
		try {
			const binding = definition.bindings[group]
			if (!Array.isArray(binding) || !safePath(binding) || !safePath([...prefix, ...binding])) continue
			const field = fieldMetadata(definition, group, values, countries)
			const hidden = evaluateFieldRule(field.hidden, document)
			if (hidden === undefined) continue
			const required = hidden ? false : evaluateFieldRule(field.required, document)
			if (required === undefined || !compileFieldSchema(field.schema)) continue
			const key = [...prefix, ...binding]
			const scoped = scopeFieldSchema(field.schema, `https://kizlo.invalid/fields/${encodeURIComponent(JSON.stringify(key))}`)
			if (!scoped) continue
			const kind = scoped.kind
			let type = field.type
			const choices = field.options
			if (!["text", "select", "checkbox", "email", "tel", "textarea", "number"].includes(type)) {
				if (kind !== "string") continue
				type = "text"
			}
			if (
				result.some(
					(existing) =>
						existing.key.every((part, index) => key[index] === part) || key.every((part, index) => existing.key[index] === part),
				)
			)
				continue
			const constraints: FieldSchema[] = [scoped.schema]
			if (required && kind === "string") constraints.push({ type: "string", minLength: 1, pattern: "\\S" })
			if (required && kind === "boolean") constraints.push({ const: true })
			if (type === "select" && choices.length) constraints.push({ enum: choices.map((option) => option.value) })
			const constrained: FieldSchema = constraints.length === 1 ? scoped.schema : { allOf: constraints }
			const schema: FieldSchema = !required && kind === "string" ? { anyOf: [{ const: "" }, constrained] } : constrained
			if (!compileFieldSchema(schema)) continue
			const { bindings: _bindings, ...metadata } = field
			const resolved: ResolvedField = {
				...metadata,
				type,
				options: choices,
				required,
				hidden,
				schema,
				key: [...prefix, ...binding],
				presentation: presentation[field.id] ?? {},
			}
			if (compileFieldSchema(objectSchema([...result, resolved]))) result.push(resolved)
		} catch {
			/* Skip this field; other plugin definitions remain usable. */
		}
	}
	result.sort((a, b) => (a.presentation.order ?? a.index ?? Infinity) - (b.presentation.order ?? b.index ?? Infinity))
	return { fields: result, schema: objectSchema(result) }
}

function localDocument(
	fields: readonly StorefrontField[],
	values: object,
	location: StorefrontField["location"],
	group: Group,
): LocalFieldDocument {
	const complete = new Set<string>()
	const value: Record<string, unknown> = { customer: {} }
	const customer = value.customer as Record<string, unknown>
	if (location === "address") {
		const address: Record<string, unknown> = Object.create(null)
		for (const field of fields) {
			const binding =
				field.location === "address"
					? field.bindings[group]
					: field.id === "email" && group === "billing"
						? Array.isArray(field.bindings.other) && field.bindings.other[0] === "billingAddress"
							? field.bindings.other.slice(1)
							: undefined
						: undefined
			if (!binding || !safePath(binding)) continue
			const current = read(values, binding)
			// Woo core address properties exist even before the shopper fills them in.
			// Defaults apply only to the evaluation document; the submitted values stay untouched.
			const core = binding.length === 1 && !field.id.includes("/")
			if (current !== undefined || core) address[field.id] = current ?? ""
		}
		customer.address = address
		customer[`${group}_address`] = address
		complete.add(JSON.stringify(["customer", "address"]))
		complete.add(JSON.stringify(["customer", `${group}_address`]))
	} else {
		const additional: Record<string, unknown> = Object.create(null)
		for (const field of fields) {
			if (field.location !== location || !field.bindings.other || !safePath(field.bindings.other)) continue
			const current = read(values, field.bindings.other)
			if (field.id === "email") {
				customer.billing_address = { email: current ?? "" }
			} else if (current !== undefined) additional[field.id] = current
		}
		if (location === "contact") {
			customer.additional_fields = additional
			complete.add(JSON.stringify(["customer", "additional_fields"]))
		} else {
			value.checkout = { additional_fields: additional }
			complete.add(JSON.stringify(["checkout", "additional_fields"]))
		}
	}
	return { value, complete }
}

type ObjectSchema = { $comment: string; type: "object"; properties: Record<string, FieldSchema>; required: string[] }
function objectSchema(fields: readonly ResolvedField[]): FieldSchema {
	const root: ObjectSchema = { $comment: "kizlo field container", type: "object", properties: Object.create(null), required: [] }
	for (const field of fields) {
		if (field.hidden) continue
		let node = root
		for (const [index, key] of field.key.entries()) {
			if (field.required && !node.required.includes(key)) node.required.push(key)
			if (index === field.key.length - 1) node.properties[key] = field.schema
			else {
				if (!Object.hasOwn(node.properties, key))
					node.properties[key] = { $comment: "kizlo field container", type: "object", properties: Object.create(null), required: [] }
				node = node.properties[key] as ObjectSchema
			}
		}
	}
	return { $schema: "http://json-schema.org/draft-07/schema#", ...root }
}
