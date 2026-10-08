import {
	checkoutAddressKeys,
	checkoutAddressPath,
	checkoutAddressSource,
	checkoutAddressTarget,
	projectCheckoutAddresses,
} from "./checkout-address"
import { checkoutFieldProps } from "./checkout-field-bindings"
import { type CheckoutFieldSources, checkoutDefaults, fieldPaths } from "./checkout-field-document"
import { checkoutFieldsSchema, resolveCheckoutFields } from "./checkout-fields"
import { readPath } from "./field-metadata"
import type {
	CheckoutFieldBinding,
	CheckoutFieldDiagnostic,
	CheckoutFieldGroup,
	CheckoutFieldUpdate,
	CheckoutFieldValue,
	CheckoutFieldValues,
	CheckoutFormField,
	CheckoutFormFieldName,
	CheckoutFormValues,
	StandardFieldSchema,
} from "./types"

const escapes: Record<string, string> = { "%": "%25", "/": "%2F", ".": "%2E", "[": "%5B", "]": "%5D", "'": "%27", '"': "%22" }
const unescapes = Object.fromEntries(Object.entries(escapes).map(([key, value]) => [value, key]))
const controls = new Set(["paymentMethod", "customerNote", "createAccount", "customerPassword", "useShippingAsBilling"])

/** Only the opaque additional-field segment is escaped. Structural dots still mean nesting. */
export function checkoutFormPath(path: readonly string[]): string[]
export function checkoutFormPath(path: readonly (string | number)[]): (string | number)[]
export function checkoutFormPath(path: readonly (string | number)[]): (string | number)[] {
	return path.map((key, index) =>
		path[index - 1] === "additionalFields" && typeof key === "string" ? key.replace(/[%/.[\]'"]/g, (char) => escapes[char] ?? char) : key,
	)
}
export function checkoutFormName(path: readonly string[]): CheckoutFormFieldName {
	return checkoutFormPath(path).join(".") as CheckoutFormFieldName
}
function convert(values: object, decode: boolean): object {
	return Object.fromEntries(
		Object.entries(values).map(([key, value]) => {
			if (key === "additionalFields" && value && typeof value === "object" && !Array.isArray(value)) {
				const entries = Object.entries(value).map(([id, child]) => [
					decode ? id.replace(/%25|%2F|%2E|%5B|%5D|%27|%22/g, (encoded) => unescapes[encoded] ?? encoded) : checkoutFormPath([key, id])[1],
					structuredClone(child),
				])
				if (new Set(entries.map(([id]) => id)).size !== entries.length) throw new Error("Colliding checkout form IDs")
				return [key, Object.fromEntries(entries)]
			}
			return [
				key,
				(key === "billingAddress" || key === "shippingAddress") && value && typeof value === "object" && !Array.isArray(value)
					? convert(value, decode)
					: structuredClone(value),
			]
		}),
	)
}
export function checkoutFormEncode(values: CheckoutFieldValues): CheckoutFormValues {
	return convert(values, false) as CheckoutFormValues
}
export function checkoutFormDecode(values: CheckoutFormValues): CheckoutFieldValues {
	return convert(values, true) as CheckoutFieldValues
}
export function canShareCheckoutAddress(sources: CheckoutFieldSources): boolean {
	return !!sources.storefront && !!sources.cart && sources.cart.needsShipping && !sources.storefront.checkout.forcedBillingAddress
}
/** Effective addresses feed metadata and schema evaluation without changing the form values. */
function projectedFormValues(sources: CheckoutFieldSources, values: CheckoutFormValues): CheckoutFieldValues {
	const decoded = checkoutFormDecode(values) as Record<string, unknown>
	const roots = new Set([
		"billingAddress",
		"shippingAddress",
		"additionalFields",
		"paymentMethod",
		"paymentData",
		"customerNote",
		"createAccount",
		"customerPassword",
		"successPath",
		"cancelPath",
		"extensions",
	])
	for (const field of sources.storefront?.address.fields ?? []) {
		for (const group of field.location === "address" ? (["billing", "shipping"] as const) : [field.location]) {
			const root = fieldPaths(field, group)?.input[0]
			if (root) roots.add(root)
		}
	}
	const output = Object.fromEntries(Object.entries(decoded).filter(([key]) => roots.has(key)))
	return projectCheckoutAddresses(sources, output, values.useShippingAsBilling) as CheckoutFieldValues
}

function projectedFormModel(sources: CheckoutFieldSources, values: CheckoutFormValues, output: CheckoutFieldValues) {
	const model = { ...resolveCheckoutFields(sources, output), addressDiagnostics: [] as CheckoutFieldDiagnostic[] }
	const diagnose = (diagnostic: CheckoutFieldDiagnostic) => {
		model.unsupported.push(diagnostic)
		model.addressDiagnostics.push(diagnostic)
	}
	const source = checkoutAddressSource(sources, values.useShippingAsBilling)
	const target = checkoutAddressTarget(sources, values.useShippingAsBilling)
	if (!source || !target) return model
	const sourceGroup = source === "billingAddress" ? "billing" : "shipping"
	const targetGroup = target === "billingAddress" ? "billing" : "shipping"
	const authoritative = values[source]
	if (!authoritative || typeof authoritative !== "object" || Array.isArray(authoritative))
		diagnose({
			fieldId: source,
			group: sourceGroup,
			path: [source],
			reason: "unavailable-data",
			message: `The authoritative ${source} is unavailable`,
		})
	model.fields[targetGroup] = model.fields[targetGroup].map((field) => {
		const copied = checkoutAddressPath(sources, values.useShippingAsBilling, field.key)
		const hidden = targetGroup === "shipping" || copied[0] !== field.key[0]
		if (!hidden) return field
		return { ...field, hidden: true }
	})
	return model
}

export function resolveCheckoutForm(sources: CheckoutFieldSources, values?: CheckoutFormValues) {
	const current = values ?? checkoutFormEncode(checkoutDefaults(sources) ?? {})
	return projectedFormModel(sources, current, projectedFormValues(sources, current))
}
export function isCheckoutFormName(sources: CheckoutFieldSources, name: string): boolean {
	if (controls.has(name)) return true
	return (sources.storefront?.address.fields ?? []).some((field) =>
		(field.location === "address" ? (["billing", "shipping"] as const) : [field.location]).some((group) => {
			const path = fieldPaths(field, group)?.input
			return path && checkoutFormName(path) === name
		}),
	)
}
export function checkoutFormSchema(getSources: () => CheckoutFieldSources): StandardFieldSchema<CheckoutFormValues> {
	const schema = checkoutFieldsSchema(getSources)
	return {
		"~standard": {
			version: 1,
			vendor: "kizlo",
			validate(candidate) {
				if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
					return { issues: [{ message: "Expected checkout form values", path: [] }] }
				const values = candidate as CheckoutFormValues
				if (values.useShippingAsBilling !== undefined && typeof values.useShippingAsBilling !== "boolean")
					return { issues: [{ message: "Expected an address-sharing boolean", path: ["useShippingAsBilling"] }] }
				const shapeIssues: { message: string; path: string[] }[] = []
				for (const group of ["billingAddress", "shippingAddress", "additionalFields"] as const) {
					const value = values[group]
					if (
						value !== undefined &&
						!(value === null && group === checkoutAddressTarget(getSources(), values.useShippingAsBilling)) &&
						(!value || typeof value !== "object" || Array.isArray(value))
					)
						shapeIssues.push({ message: "Expected field values", path: [group] })
					if (group !== "additionalFields") {
						const additional = readPath(value, ["additionalFields"])
						if (additional !== undefined && (!additional || typeof additional !== "object" || Array.isArray(additional)))
							shapeIssues.push({ message: "Expected additional fields", path: [group, "additionalFields"] })
					}
				}
				if (shapeIssues.length) return { issues: shapeIssues }
				const sources = getSources()
				try {
					const output = projectedFormValues(sources, values)
					const model = projectedFormModel(sources, values, output)
					const result = schema["~standard"].validate(output)
					if ("value" in result && !model.addressDiagnostics.length) return { value: values }
					const failures = [
						...("issues" in result ? result.issues : []),
						...model.addressDiagnostics.map(({ message, path }) => ({ message, path })),
					]
					const issues = failures.map((issue) => {
						const path = [...(issue.path ?? [])]
						const copied = checkoutAddressPath(sources, values.useShippingAsBilling, path.map(String))
						const editable = Object.values(model.fields).some((fields) =>
							fields.some((field) => !field.hidden && JSON.stringify(field.key) === JSON.stringify(copied)),
						)
						if (editable) path.splice(0, path.length, ...copied)
						return { ...issue, path: checkoutFormPath(path) }
					})
					return { issues: [...new Map(issues.map((issue) => [JSON.stringify(issue), issue])).values()] }
				} catch {
					return { issues: [{ message: "Checkout form values could not be converted", path: [] }] }
				}
			},
		},
	}
}

export type CheckoutFormState = {
	fields: Record<CheckoutFieldGroup, CheckoutFormField[]>
	unsupported: CheckoutFieldDiagnostic[]
	defaultValues: CheckoutFormValues | null
	canUseShippingAsBilling: boolean
	useShippingAsBilling: boolean
	signature: string
}
export function resolveCheckoutFormState(
	sources: CheckoutFieldSources,
	values: CheckoutFormValues | undefined,
	defaultValues: CheckoutFormValues | null,
	previous?: CheckoutFormState,
): CheckoutFormState {
	const model = resolveCheckoutForm(sources, values ?? defaultValues ?? undefined)
	const canUseShippingAsBilling = canShareCheckoutAddress(sources)
	const useShippingAsBilling = checkoutAddressSource(sources, (values ?? defaultValues)?.useShippingAsBilling) === "shippingAddress"
	const signature = JSON.stringify([model.fields, model.unsupported, canUseShippingAsBilling, useShippingAsBilling])
	if (previous?.signature === signature) return previous.defaultValues === defaultValues ? previous : { ...previous, defaultValues }
	const fields = Object.fromEntries(
		Object.entries(model.fields).map(([group, definitions]) => {
			const prior = previous?.fields[group as CheckoutFieldGroup]
			const resolved = definitions.map((field) => {
				const name = checkoutFormName(field.key)
				const existing = prior?.find((field) => field.name === name)
				if (existing) {
					const { name: _name, getProps: _getProps, ...metadata } = existing
					if (JSON.stringify(metadata) === JSON.stringify(field)) return existing
				}
				return { ...field, name, getProps: (binding: CheckoutFieldBinding) => checkoutFieldProps(field, name, binding) }
			})
			return [group, prior?.length === resolved.length && resolved.every((field, index) => field === prior[index]) ? prior : resolved]
		}),
	) as CheckoutFormState["fields"]
	return {
		fields,
		unsupported:
			JSON.stringify(previous?.unsupported) === JSON.stringify(model.unsupported)
				? (previous?.unsupported ?? model.unsupported)
				: model.unsupported,
		defaultValues,
		canUseShippingAsBilling,
		useShippingAsBilling,
		signature,
	}
}

/** A customer-requested copy updates native leaves while retaining independent billing data. */
export function checkoutShippingToBillingUpdates(values: CheckoutFormValues | undefined): readonly CheckoutFieldUpdate[] {
	const shipping = values?.shippingAddress
	if (!shipping || typeof shipping !== "object" || Array.isArray(shipping))
		throw new Error("Copying shipping to billing requires a shipping address in the form")
	return checkoutAddressKeys.flatMap((key) => {
		const value = readPath(shipping, [key]) as CheckoutFieldValue | undefined
		if (value === readPath(values?.billingAddress, [key])) return []
		return [{ name: checkoutFormName(["billingAddress", key]), value, options: { runListeners: false, meta: "update", validate: false } }]
	})
}

export function checkoutFieldUpdates(name: CheckoutFormFieldName): readonly CheckoutFieldUpdate[] {
	if (name !== "billingAddress.country" && name !== "shippingAddress.country") return []
	return [
		{
			name: name === "billingAddress.country" ? "billingAddress.state" : "shippingAddress.state",
			value: "",
			options: { runListeners: false, meta: "preserve", validate: false },
		},
	]
}
