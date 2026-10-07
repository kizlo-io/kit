import { checkoutFieldProps } from "./checkout-field-bindings"
import { type CheckoutFieldSources, fieldPaths } from "./checkout-field-document"
import { checkoutFieldsSchema, resolveCheckoutFields } from "./checkout-fields"
import { readPath } from "./field-metadata"
import type {
	CheckoutFieldBinding,
	CheckoutFieldDiagnostic,
	CheckoutFieldGroup,
	CheckoutFieldUpdate,
	CheckoutFieldValues,
	CheckoutFormField,
	CheckoutFormFieldName,
	CheckoutFormValues,
	StandardFieldSchema,
} from "./types"

const escapes: Record<string, string> = { "%": "%25", "/": "%2F", ".": "%2E", "[": "%5B", "]": "%5D", "'": "%27", '"': "%22" }
const unescapes = Object.fromEntries(Object.entries(escapes).map(([key, value]) => [value, key]))
const nativeAddress = new Set(["firstName", "lastName", "company", "address1", "address2", "city", "state", "postcode", "country", "phone"])
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
export function checkoutFormInput(values: CheckoutFieldValues): CheckoutFormValues {
	return convert(values, false) as CheckoutFormValues
}
export function canShareCheckoutAddress(sources: CheckoutFieldSources): boolean {
	return !!sources.storefront && !!sources.cart && sources.cart.needsShipping && !sources.storefront.checkout.forcedBillingAddress
}
function sharesAddress(sources: CheckoutFieldSources, values: CheckoutFormValues): boolean {
	return canShareCheckoutAddress(sources) && values.useShippingAsBilling === true
}
export function sharedAddressPath(path: readonly string[]): boolean {
	return path.length === 2 && path[0] === "billingAddress" && nativeAddress.has(path[1] ?? "")
}

/** The same projection feeds rendering, validation and SDK output; it never writes the draft. */
export function checkoutFormOutput(sources: CheckoutFieldSources, values: CheckoutFormValues): CheckoutFieldValues {
	const decoded = convert(values, true) as Record<string, unknown>
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
	if (sharesAddress(sources, values)) {
		const billing = output.billingAddress && typeof output.billingAddress === "object" ? output.billingAddress : {}
		const shipping = output.shippingAddress
		output.billingAddress = { ...billing, ...Object.fromEntries([...nativeAddress].map((key) => [key, readPath(shipping, [key]) ?? ""])) }
	}
	if (sources.cart?.needsShipping === false) delete output.shippingAddress
	return output as CheckoutFieldValues
}
export function resolveCheckoutForm(sources: CheckoutFieldSources, values?: CheckoutFormValues) {
	const model = resolveCheckoutFields(sources, values === undefined ? undefined : checkoutFormOutput(sources, values))
	if (values && sharesAddress(sources, values)) {
		model.fields.billing = model.fields.billing.map((field) => (sharedAddressPath(field.key) ? { ...field, hidden: true } : field))
	}
	return model
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
					if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value)))
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
					const result = schema["~standard"].validate(checkoutFormOutput(sources, values))
					if ("value" in result) return { value: values }
					const issues = result.issues.map((issue) => {
						const path = [...(issue.path ?? [])]
						if (sharesAddress(sources, values) && sharedAddressPath(path.map(String))) path[0] = "shippingAddress"
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
	const useShippingAsBilling = (values ?? defaultValues)?.useShippingAsBilling === true
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
