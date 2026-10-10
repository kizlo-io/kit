import { checkoutAddressKeys, checkoutAddressPath, checkoutAddressTarget, projectCheckoutAddresses } from "./checkout-address"
import type { CheckoutFieldSources } from "./checkout-field-document"
import { compileCheckoutSchema, type FieldIssue, fieldSchemaIssues } from "./checkout-field-schema"
import { checkoutFieldsSchema } from "./checkout-fields"
import { checkoutFormDecode, checkoutFormEncode, checkoutFormSchema } from "./checkout-form"
import type { CheckoutPreparationOptions, ConfirmCheckoutInput, FieldSchema } from "./types"

/** Local failures retain domain paths so the existing form error bridge can resolve the visible controls. */
export class CheckoutPreparationError extends Error {
	readonly code = "CHECKOUT_PREPARATION_FAILED"
	readonly data: { issues: readonly FieldIssue[] }
	constructor(issues: readonly FieldIssue[]) {
		super("Review the checkout fields before placing your order.")
		this.name = "CheckoutPreparationError"
		this.data = { issues }
	}
}

const additionalFields: FieldSchema = { type: "object", additionalProperties: { type: ["string", "boolean"] } }
const addressProperties = Object.fromEntries(checkoutAddressKeys.map((key) => [key, { type: "string" }]))
const shippingAddress: FieldSchema = {
	type: "object",
	properties: { ...addressProperties, additionalFields },
	required: [...checkoutAddressKeys, "additionalFields"],
}
const billingAddress: FieldSchema = {
	...shippingAddress,
	properties: {
		...addressProperties,
		email: { type: "string" },
		taxId: { type: "string" },
		additionalFields: { ...additionalFields, not: { required: ["kizlo/tax-id"] } },
	},
	required: [...checkoutAddressKeys, "email", "additionalFields"],
}
const relativePath: FieldSchema = { type: "string", pattern: "^/(?![/\\\\])" }
const submissionSchema: FieldSchema = {
	type: "object",
	required: ["billingAddress", "paymentMethod"],
	properties: {
		billingAddress,
		shippingAddress,
		paymentMethod: { type: "string" },
		customerNote: { type: "string" },
		createAccount: { type: "boolean" },
		customerPassword: { type: "string" },
		paymentData: {
			type: "array",
			items: {
				type: "object",
				required: ["key", "value"],
				properties: { key: { type: "string" }, value: { type: ["string", "boolean"] } },
			},
		},
		additionalFields,
		extensions: { type: "object" },
		successPath: relativePath,
		cancelPath: relativePath,
		expectedTotal: { type: "string", pattern: "^[0-9]+$" },
	},
}
const submissionRoots = new Set(Object.keys(submissionSchema.properties ?? {}))

/** Construct a request only after validating both the effective merchant rules and the SDK submission structure. */
export function prepareCheckout(sources: CheckoutFieldSources, options: CheckoutPreparationOptions = {}): ConfirmCheckoutInput {
	const reject = (issues: readonly FieldIssue[]): never => {
		throw new CheckoutPreparationError(issues)
	}
	if (!sources.storefront || !sources.checkout || sources.checkout.isPaid || !sources.cart)
		return reject([{ message: "Checkout field sources are unavailable", path: [] }])
	if (!options.values || typeof options.values !== "object" || Array.isArray(options.values))
		return reject([{ message: "Supply checkout form values or bind a form adapter", path: [] }])
	if (options.input !== undefined && (!options.input || typeof options.input !== "object" || Array.isArray(options.input)))
		return reject([{ message: "Expected checkout input overrides", path: [] }])
	try {
		const decoded = checkoutFormDecode(options.values)
		const merged = { ...decoded, ...options.input }
		const output = projectCheckoutAddresses(
			sources,
			Object.fromEntries(Object.entries(merged).filter(([key, value]) => submissionRoots.has(key) && value !== undefined)),
			decoded.useShippingAsBilling,
		)
		const target = checkoutAddressTarget(sources, decoded.useShippingAsBilling)
		for (const root of ["billingAddress", "shippingAddress"] as const) {
			const address = output[root]
			if (!address || typeof address !== "object" || Array.isArray(address)) continue
			const allowed = new Set([...checkoutAddressKeys, "additionalFields", ...(root === "billingAddress" ? ["email", "taxId"] : [])])
			const normalized = Object.fromEntries(Object.entries(address).filter(([key, value]) => allowed.has(key) && value !== undefined))
			if (root === target && !merged[root]) normalized.additionalFields = {}
			const extras = normalized.additionalFields
			if (extras && typeof extras === "object" && !Array.isArray(extras))
				normalized.additionalFields = Object.fromEntries(Object.entries(extras).filter(([, value]) => value !== undefined))
			output[root] = normalized
		}
		if (output.additionalFields && typeof output.additionalFields === "object" && !Array.isArray(output.additionalFields))
			output.additionalFields = Object.fromEntries(Object.entries(output.additionalFields).filter(([, value]) => value !== undefined))
		// Cart totals are already minor-unit integers. Never re-read the cache or rescale by the currency exponent.
		if (!Object.hasOwn(options.input ?? {}, "expectedTotal")) {
			const total = sources.cart.totals.total
			if (!Number.isSafeInteger(total) || total < 0)
				return reject([{ message: "The reviewed cart total is invalid", path: ["expectedTotal"] }])
			output.expectedTotal = String(total)
		}
		const validate = compileCheckoutSchema<ConfirmCheckoutInput>(submissionSchema)
		const issues: FieldIssue[] = []
		const parsed: { value: ConfirmCheckoutInput } | { issues: FieldIssue[] } = validate(output)
			? { value: output }
			: { issues: fieldSchemaIssues(validate.errors, [], []) }
		if ("issues" in parsed) issues.push(...parsed.issues)
		validate.errors = null
		const result = checkoutFieldsSchema(() => sources)["~standard"].validate(output)
		if ("issues" in result) issues.push(...result.issues.map((issue) => ({ message: issue.message, path: [...(issue.path ?? [])] })))
		// Also enforce authoritative-address availability and the sharing control's shape before projection hides them.
		const formResult = checkoutFormSchema(() => sources)["~standard"].validate({
			...checkoutFormEncode(merged),
			useShippingAsBilling: decoded.useShippingAsBilling,
		})
		if ("issues" in formResult) {
			// Field rules above have raw domain paths; the form schema additionally owns only these preparation constraints.
			issues.push(
				...formResult.issues
					.filter(
						(issue) =>
							issue.path?.length === 1 && ["billingAddress", "shippingAddress", "useShippingAsBilling"].includes(String(issue.path[0])),
					)
					.map((issue) => ({ message: issue.message, path: [...(issue.path ?? [])] })),
			)
		}
		const paymentMethod = output.paymentMethod
		if (
			sources.cart.needsPayment &&
			(typeof paymentMethod !== "string" || !sources.cart.paymentMethods.some((method) => method.id === paymentMethod && method.enabled))
		)
			issues.push({ message: "Choose an available payment method", path: ["paymentMethod"] })
		if (issues.length)
			return reject([
				...new Map(
					issues.map((issue) => {
						const path = checkoutAddressPath(sources, decoded.useShippingAsBilling, issue.path.map(String))
						const mapped = { ...issue, path }
						return [JSON.stringify(mapped), mapped]
					}),
				).values(),
			])
		// The parser's successful type guard establishes required members; a decoded draft is never asserted to be a request.
		if ("value" in parsed) return structuredClone(parsed.value)
		return reject([{ message: "Checkout input could not be prepared", path: [] }])
	} catch (error) {
		if (error instanceof CheckoutPreparationError) throw error
		return reject([{ message: "Checkout form values could not be converted", path: [] }])
	}
}
