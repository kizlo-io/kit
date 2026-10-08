import { type CheckoutFieldSources, checkoutDefaults, checkoutDocument, fieldPaths, scopeAddressDocument } from "./checkout-field-document"
import {
	checkoutSchemaKind,
	compileCheckoutSchema,
	type FieldIssue,
	fieldSchemaIssues,
	unavailableDependency,
	valueSchema,
} from "./checkout-field-schema"
import { fieldMetadata, readPath, safeFieldPath } from "./field-metadata"
import { validPostcode } from "./postcode"
import type {
	CheckoutFieldDiagnostic,
	CheckoutFieldsModel,
	CheckoutFieldValues,
	FieldSchema,
	StandardFieldSchema,
	StorefrontFieldRule,
} from "./types"

const groups = ["billing", "shipping", "contact", "order"] as const
const widgets = new Set(["text", "select", "checkbox", "email", "tel", "textarea", "number"])

function ruleSchema(rule: StorefrontFieldRule): FieldSchema {
	return typeof rule === "object" && rule !== null && ["cart", "customer", "checkout"].some((key) => Object.hasOwn(rule, key))
		? { type: "object", properties: rule }
		: rule
}

/** The internal checkout model is shared by rendering and candidate validation. */
export function resolveCheckoutFields(
	sources: CheckoutFieldSources,
	values?: CheckoutFieldValues,
	validate = false,
): CheckoutFieldsModel & { issues: FieldIssue[] } {
	const model: CheckoutFieldsModel & { issues: FieldIssue[] } = {
		fields: { billing: [], shipping: [], contact: [], order: [] },
		defaultValues: checkoutDefaults(sources),
		unsupported: [],
		issues: [],
	}
	const storefront = sources.storefront
	if (!storefront) return model
	const current = values ?? model.defaultValues ?? undefined
	const document = checkoutDocument(sources, current)
	const bindings: string[][] = []
	for (const group of groups) {
		if (group === "shipping" && sources.cart?.needsShipping === false) continue
		const scopedDocument = scopeAddressDocument(document, group)
		for (const definition of storefront.address.fields) {
			if (definition.location !== (group === "billing" || group === "shipping" ? "address" : group)) continue
			// Managed native fields deliberately omit bindings for ineligible groups (notably shipping Tax ID).
			if (
				!definition.bindings?.[group === "billing" || group === "shipping" ? group : "other"] &&
				(group === "shipping" || Object.values(definition.bindings ?? {}).some((binding) => binding !== undefined))
			)
				continue
			const paths = fieldPaths(definition, group)
			const diagnose = (reason: CheckoutFieldDiagnostic["reason"], message: string) =>
				model.unsupported.push({
					fieldId: definition.id,
					group,
					path: paths?.input ?? [],
					reason,
					message,
				})
			if (!paths || !safeFieldPath(paths.input)) {
				diagnose("invalid-binding", "Field binding is not a safe submission path")
				continue
			}
			if (bindings.some((path) => path.every((key, i) => paths.input[i] === key) || paths.input.every((key, i) => path[i] === key))) {
				diagnose("binding-collision", "Field binding overlaps another checkout field")
				continue
			}
			bindings.push(paths.input)
			const field = fieldMetadata(
				definition,
				group === "contact" || group === "order" ? "other" : group,
				readPath(current, [group === "billing" ? "billingAddress" : "shippingAddress"]),
				storefront.address.countries,
			)
			const evaluate = (rule: StorefrontFieldRule): boolean | undefined => {
				if (typeof rule === "boolean") return rule
				if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
					diagnose("invalid-schema", "Invalid condition schema")
					return undefined
				}
				if (!Object.keys(rule).length) return false
				const schema = ruleSchema(rule)
				const parser = compileCheckoutSchema(schema)
				const missing = unavailableDependency(schema, scopedDocument)
				if (missing) {
					diagnose("unavailable-data", missing)
					return undefined
				}
				try {
					return parser(scopedDocument.value)
				} finally {
					parser.errors = null
				}
			}
			try {
				const hidden = evaluate(field.hidden)
				if (hidden === undefined) continue
				const { bindings: _bindings, ...metadata } = field
				const required = evaluate(field.required)
				if (required === undefined) continue
				if (!widgets.has(field.type)) {
					diagnose("unsupported-widget", `Application integration required for widget: ${field.type}`)
					continue
				}
				const inferredKind = checkoutSchemaKind(field.schema)
				const kind = inferredKind ?? (field.type === "checkbox" ? "boolean" : field.type === "number" ? "number" : "string")
				const isolated = structuredClone(field.schema)
				if (isolated && typeof isolated === "object" && !isolated.$id) isolated.$id = "https://kizlo.invalid/checkout-field"
				const constraints: FieldSchema[] = [isolated]
				if (required && kind === "string") constraints.push({ type: "string", minLength: 1, pattern: "\\S" })
				if (required && kind === "boolean") constraints.push({ const: true })
				if (field.type === "select" && field.options.length) constraints.push({ enum: field.options.map((option) => option.value) })
				const constrained: FieldSchema = constraints.length === 1 ? isolated : { allOf: constraints }
				const schema: FieldSchema = !required && inferredKind === "string" ? { anyOf: [{ const: "" }, constrained] } : constrained
				const wrapped = valueSchema(schema, paths.document, required)
				const parser = compileCheckoutSchema(wrapped)
				const missing = unavailableDependency(wrapped, scopedDocument)
				if (missing) {
					diagnose("unavailable-data", missing)
					continue
				}
				if (validate) {
					try {
						if (!parser(scopedDocument.value)) model.issues.push(...fieldSchemaIssues(parser.errors, paths.document, paths.input))
						if (paths.input.length === 2 && paths.input[1] === "postcode") {
							const postcode = readPath(current, paths.input)
							const country = readPath(current, [paths.input[0] ?? "", "country"])
							if (typeof postcode === "string" && postcode !== "" && typeof country === "string" && !validPostcode(postcode, country))
								model.issues.push({ message: "Invalid postcode", path: paths.input })
						}
					} finally {
						parser.errors = null
					}
				}
				model.fields[group].push({ ...metadata, required, hidden, key: paths.input, schema: field.schema, presentation: {} })
			} catch (error) {
				diagnose("invalid-schema", error instanceof Error ? error.message : "Unsupported field schema")
			}
		}
		model.fields[group].sort((a, b) => (a.index ?? Infinity) - (b.index ?? Infinity))
	}
	return model
}

/** Read sources at validation time; a captured adapter remains current after committed query refreshes. */
export function checkoutFieldsSchema(getSources: () => CheckoutFieldSources): StandardFieldSchema<CheckoutFieldValues> {
	return {
		"~standard": {
			version: 1,
			vendor: "kizlo",
			validate(candidate) {
				if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
					return { issues: [{ message: "Expected checkout values", path: [] }] }
				const shapeIssues: FieldIssue[] = []
				for (const group of ["billingAddress", "shippingAddress", "additionalFields"]) {
					const value = readPath(candidate, [group])
					if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value)))
						shapeIssues.push({ message: "Expected field values", path: [group] })
				}
				for (const key of ["paymentMethod", "customerNote", "createAccount"]) {
					const value = readPath(candidate, [key])
					if (value !== undefined && typeof value !== (key === "createAccount" ? "boolean" : "string"))
						shapeIssues.push({ message: "Invalid checkout value", path: [key] })
				}
				if (shapeIssues.length) return { issues: shapeIssues }
				const sources = getSources()
				if (!sources.storefront || !sources.checkout || sources.checkout.isPaid || !sources.cart)
					return { issues: [{ message: "Checkout field sources are unavailable", path: [] }] }
				try {
					const result = resolveCheckoutFields(sources, candidate as CheckoutFieldValues, true)
					const issues = [
						...result.issues,
						...result.unsupported.map((diagnostic) => ({ message: diagnostic.message, path: [...diagnostic.path] })),
					]
					if (issues.length) return { issues: [...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values()] }
					return { value: candidate as CheckoutFieldValues }
				} catch {
					return { issues: [{ message: "Checkout values could not be evaluated", path: [] }] }
				}
			},
		},
	}
}
