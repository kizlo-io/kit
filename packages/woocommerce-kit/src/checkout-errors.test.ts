import { describe, expect, it, vi } from "vitest"
import { checkoutErrorStore, createCheckoutErrorBridge, createCheckoutErrorStore, projectCheckoutErrors } from "./checkout-errors"
import { checkoutFormInput, resolveCheckoutFormState } from "./checkout-form"
import { validationFailure, validationIssue } from "./test/checkout-errors-fixture"
import { field, fixtures } from "./test/checkout-fields-fixture"
import type { CheckoutError, CheckoutFormFieldName, CheckoutValidationIssue } from "./types"

function addressFields() {
	return [
		field("postcode", { location: "address", bindings: { billing: ["postcode"], shipping: ["postcode"] } }),
		field("email", { location: "contact", bindings: { other: ["billingAddress", "email"] } }),
		field("kizlo/tax-id", { location: "address", bindings: { billing: ["taxId"] } }),
	]
}
function project(issues: CheckoutValidationIssue[], definitions = addressFields(), sharing = false) {
	const sources = fixtures(definitions)
	const values = { ...checkoutFormInput(sources.values), useShippingAsBilling: sharing }
	const fields = resolveCheckoutFormState(sources, values, values).fields
	const store = createCheckoutErrorStore()
	store.fail(store.start("session"), validationFailure(issues))
	return { store, sources, values, fields, projection: projectCheckoutErrors(store.state.get().issues, sources, fields, values) }
}

describe("checkout server-error lifecycle", () => {
	it("isolates clients and caches, preserves evidence/messages and assigns batch and issue identities", () => {
		const client = {},
			cache = {}
		const a = checkoutErrorStore(client, cache)
		expect(checkoutErrorStore(client, cache)).toBe(a)
		expect(checkoutErrorStore({}, cache)).not.toBe(a)
		expect(checkoutErrorStore(client, {})).not.toBe(a)
		const error = validationFailure([validationIssue({ message: "first" }), validationIssue({ message: "second" })])
		const attempt = a.start("s")
		a.fail(attempt, error)
		expect(a.state.get().error).toBe(error)
		expect(a.state.get().issues).toMatchObject([
			{ message: "first", source: "diagnostic_only", submissionId: attempt },
			{ message: "second", submissionId: attempt },
		])
		expect(new Set(a.state.get().issues.map((issue) => issue.id)).size).toBe(2)
		a.settle(attempt)
		a.reset()
		expect(a.state.get().issues).toEqual([])
	})
	it("rejects old completions after a newer submission, reset or revived session", () => {
		const s = createCheckoutErrorStore(),
			error = validationFailure([validationIssue()])
		const old = s.start("s"),
			next = s.start("s")
		s.fail(next, error)
		s.fail(old, validationFailure([validationIssue({ message: "stale" })]))
		s.succeed(old, "old")
		expect(s.state.get().issues[0]?.message).toBe("Server refusal")
		s.reset()
		expect(s.state.get().issues).toHaveLength(1)
		s.settle(old)
		s.settle(next)
		s.reset()
		s.fail(next, error)
		expect(s.state.get().issues).toEqual([])
		const pending = s.start("s")
		s.syncSession("revived")
		s.fail(pending, error)
		expect(s.state.get().issues).toEqual([])
		s.settle(pending)
	})
	it("clears on submission and success and preserves non-validation codes/messages", () => {
		const s = createCheckoutErrorStore()
		const error = Object.assign(new Error("Payment declined"), { code: "CHECKOUT_PAYMENT_FAILED" }) as CheckoutError
		const attempt = s.start("s")
		s.fail(attempt, error)
		s.settle(attempt)
		expect(s.state.get().issues[0]).toMatchObject({
			code: "CHECKOUT_PAYMENT_FAILED",
			errorCode: "CHECKOUT_PAYMENT_FAILED",
			message: "Payment declined",
			scope: "unresolved",
		})
		const next = s.start("s")
		expect(s.state.get().issues).toEqual([])
		s.fail(next, error)
		s.succeed(next, "done")
		s.settle(next)
		expect(s.state.get().error).toBeNull()
	})
})

describe("SDK identity and editable-control projection", () => {
	it("maps native targets, copied addresses and separate email/tax ID while retaining group/summary errors", () => {
		const { projection } = project(
			[
				validationIssue({ scope: "field", target: ["billingAddress", "postcode"], message: "postcode one" }),
				validationIssue({ scope: "field", target: ["billingAddress", "postcode"], message: "postcode two" }),
				validationIssue({ scope: "field", target: ["billingAddress", "email"] }),
				validationIssue({ registeredFields: [{ id: "kizlo/tax-id", bucket: "billingAddress" }] }),
				validationIssue({ scope: "group", target: ["billingAddress"] }),
				validationIssue({ scope: "group", target: ["shippingAddress"] }),
				validationIssue({ scope: "group", target: ["additionalFields"] }),
				validationIssue(),
			],
			addressFields(),
			true,
		)
		expect(projection.fields).toMatchObject([
			{ name: "shippingAddress.postcode", messages: ["postcode one", "postcode two"] },
			{ name: "billingAddress.email" },
			{ name: "billingAddress.taxId" },
		])
		expect(projection.sections.billing).toHaveLength(1)
		expect(projection.sections.shipping).toHaveLength(1)
		expect(projection.errors).toHaveLength(2)
	})
	it.each(["plugin/a.b[0]'\"%", "plugin%2Fid", "literal.with.dots", "shippingAddress[plugin/id]"])(
		"keeps %s literal through registry matching and safe-name encoding",
		(id) => {
			const { projection } = project([validationIssue({ registeredFields: [{ id, bucket: "additionalFields" }] })], [field(id)])
			expect(projection.fields[0]?.name).toBe(resolveCheckoutFormState(fixtures([field(id)]), undefined, null).fields.order[0]?.name)
			expect(projection.errors).toEqual([])
		},
	)
	it("resolves each registered location using its binding and rejects ambiguous address identities", () => {
		const defs = [
			field("address/id", {
				location: "address",
				bindings: { billing: ["additionalFields", "address/id"], shipping: ["additionalFields", "address/id"] },
			}),
			field("contact/id", { location: "contact" }),
			field("order/id"),
		]
		const { projection } = project(
			[
				validationIssue({ registeredFields: [{ id: "address/id", bucket: "billingAddress" }] }),
				validationIssue({ registeredFields: [{ id: "address/id", bucket: "shippingAddress" }] }),
				validationIssue({ registeredFields: [{ id: "address/id", bucket: null }] }),
				validationIssue({ registeredFields: [{ id: "contact/id", bucket: "additionalFields" }] }),
				validationIssue({ registeredFields: [{ id: "order/id", bucket: "additionalFields" }] }),
			],
			defs,
			true,
		)
		expect(projection.fields.map((patch) => patch.name)).toEqual([
			"billingAddress.additionalFields.address%2Fid",
			"shippingAddress.additionalFields.address%2Fid",
			"additionalFields.contact%2Fid",
			"additionalFields.order%2Fid",
		])
		expect(projection.errors).toHaveLength(1)
	})
	it("never assigns an unqualified address ID even when only one side has a binding", () => {
		const { projection } = project(
			[validationIssue({ registeredFields: [{ id: "only/billing", bucket: null }] })],
			[field("only/billing", { location: "address", bindings: { billing: ["additionalFields", "only/billing"] } })],
		)
		expect(projection.fields).toEqual([])
		expect(projection.errors).toHaveLength(1)
	})
	it("honors reliable SDK targets and never splits a literal field ID", () => {
		const id = "plugin.with/slash[0]"
		const { projection } = project(
			[validationIssue({ scope: "field", target: ["additionalFields", id], registeredFields: [{ id: "conflicting", bucket: null }] })],
			[field(id), field("conflicting")],
		)
		expect(projection.fields[0]?.name).toBe("additionalFields.plugin%2Ewith%2Fslash%5B0%5D")
	})

	it("preserves hidden, unknown, duplicate and conflicting identities without parsing source paths", () => {
		const { projection } = project(
			[
				validationIssue({ registeredFields: [{ id: "hidden", bucket: "additionalFields" }] }),
				validationIssue({ registeredFields: [{ id: "missing", bucket: null }] }),
				validationIssue({ registeredFields: [{ id: "duplicate", bucket: null }] }),
				validationIssue({
					registeredFields: [
						{ id: "a", bucket: null },
						{ id: "b", bucket: null },
					],
				}),
				validationIssue({ source: "a", sourcePath: ["additionalFields", "a"] }),
				validationIssue({ scope: "field", target: ["billingAddress", "unknown"] }),
			],
			[field("hidden", { hidden: true }), field("duplicate"), field("duplicate"), field("a"), field("b")],
		)
		expect(projection.fields).toEqual([])
		expect(projection.errors).toHaveLength(4)
		expect(projection.sections.order).toHaveLength(1)
		expect(projection.sections.billing).toHaveLength(1)
	})
	it("clears individual associated issues and reprojects only still-active messages", () => {
		const { store, sources, fields, values, projection } = project(
			[
				validationIssue({ scope: "field", target: ["billingAddress", "postcode"] }),
				validationIssue({ scope: "field", target: ["shippingAddress", "postcode"] }),
				validationIssue({ scope: "group", target: ["billingAddress"] }),
			],
			addressFields(),
			true,
		)
		store.clearIssues(new Set([...projection.associations].filter(([, name]) => name === "shippingAddress.postcode").map(([id]) => id)))
		expect(store.state.get().issues).toHaveLength(1)
		const next = projectCheckoutErrors(store.state.get().issues, sources, fields, { ...values, useShippingAsBilling: false })
		expect(next.fields).toEqual([])
		expect(next.sections.billing).toHaveLength(1)
	})
	it("keeps unavailable account controls in the summary instead of sending invisible form patches", () => {
		const { projection } = project([validationIssue({ scope: "field", target: ["customerPassword"], message: "Password refused" })])
		expect(projection.fields).toEqual([])
		expect(projection.errors[0]?.message).toBe("Password refused")
	})
})

it("bridges changed patches once, uses new callbacks without replay and clears on cleanup", () => {
	const bridge = createCheckoutErrorBridge(),
		set = vi.fn(),
		clear = vi.fn(),
		latest = vi.fn()
	const name: CheckoutFormFieldName = "billingAddress.postcode"
	bridge.update([{ name, messages: ["one", "two"] }], set, clear)
	bridge.update([{ name, messages: ["one", "two"] }], latest, clear)
	expect(set).toHaveBeenCalledTimes(1)
	expect(latest).not.toHaveBeenCalled()
	bridge.update([{ name: "shippingAddress.postcode", messages: ["one", "two"] }], latest, clear)
	expect(clear).toHaveBeenCalledWith([name])
	bridge.cleanup(clear)
	expect(clear).toHaveBeenLastCalledWith(["shippingAddress.postcode"])
})
