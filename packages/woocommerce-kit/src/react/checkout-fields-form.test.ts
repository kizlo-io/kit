// @vitest-environment happy-dom

import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { useField, useForm as useTanStackForm } from "@tanstack/react-form"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { createElement, type ReactNode, useState } from "react"
import { type UseFormReturn, useController, useForm as useRHF } from "react-hook-form"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TanStackCheckoutForm } from "../../types/checkout-fields.example"
import { ReactHookFormCheckout } from "../../types/checkout-fields-rhf.example"
import { reactHookFormErrorMessages, reactHookFormServerErrors } from "../../types/checkout-server-errors.example"
import { cartQueryKey } from "../cart"
import { checkoutQueryKey } from "../checkout"
import { checkoutFormInput } from "../checkout-form"
import { validationFailure, validationIssue } from "../test/checkout-errors-fixture"
import { field, fixtures } from "../test/checkout-fields-fixture"
import type { CheckoutFieldsApi, CheckoutFieldUpdate, CheckoutFormValues } from "../types"
import { useCheckout } from "./checkout"
import { useCheckoutFields } from "./checkout-fields"
import { WooCommerceProvider } from "./provider"
import { storefrontQueryKey } from "./storefront"

const { procedures } = vi.hoisted(() => {
	const procedure = () => ({ call: vi.fn() })
	return {
		procedures: {
			checkout: { get: procedure(), confirm: procedure() },
			cart: { get: procedure(), update: procedure(), selectShippingRate: procedure() },
			storefront: { get: procedure() },
		},
	}
})
vi.mock("kizlo/react", () => {
	const client = { woocommerce: procedures }
	return { useKizloContext: () => ({ client }) }
})
const clients: QueryClient[] = []
const id = "plugin/a.b[0]'%"
const safeName = "additionalFields.plugin%2Fa%2Eb%5B0%5D%27%25" as const
function source() {
	const source = fixtures([
		field("country", { location: "address", bindings: { billing: ["country"], shipping: ["country"] } }),
		field("state", { location: "address", bindings: { billing: ["state"], shipping: ["state"] } }),
		field(id, { required: true, label: "Reference" }),
		field("consumer/quantity.a[0]'%%", { type: "number", label: "Quantity", schema: { type: "number", minimum: 1 } }),
	])
	source.checkout.shippingAddress.country = "IN"
	source.checkout.shippingAddress.state = "KA"
	source.values.additionalFields = { [id]: "OLD" }
	source.checkout.additionalFields = { [id]: "OLD" }
	return source
}
function setup() {
	const sources = source()
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
	clients.push(client)
	client.setQueryData(cartQueryKey, sources.cart)
	client.setQueryData(checkoutQueryKey, sources.checkout)
	client.setQueryData(storefrontQueryKey, sources.storefront)
	const wrapper = ({ children }: { children: ReactNode }) =>
		createElement(QueryClientProvider, { client }, createElement(WooCommerceProvider, { children }))
	return { sources, wrapper, client }
}
beforeEach(() => {
	const sources = source()
	procedures.checkout.get.call.mockResolvedValue(sources.checkout)
	procedures.storefront.get.call.mockResolvedValue(sources.storefront)
	procedures.cart.get.call.mockResolvedValue(sources.cart)
	procedures.checkout.confirm.call.mockResolvedValue(sources.checkout)
})
afterEach(() => {
	cleanup()
	for (const client of clients) client.clear()
	clients.length = 0
	vi.resetAllMocks()
})

describe("real form libraries", () => {
	it.each([false, true])(
		"TanStack preserves state metadata (already dirty: %s) and suppresses dependency listeners/validation",
		async (dirty) => {
			const { sources, wrapper } = setup()
			const writes: (readonly CheckoutFieldUpdate[])[] = []
			const listen = vi.fn()
			const validate = vi.fn(() => undefined)
			const { result } = renderHook(
				() => {
					const fields: CheckoutFieldsApi = useCheckoutFields({
						getValues: (): CheckoutFormValues => form.state.values,
						setValues: (updates) => {
							writes.push(updates)
							for (const { name, value, options } of updates)
								form.setFieldValue(name, value, {
									dontUpdateMeta: options.meta === "preserve",
									dontRunListeners: !options.runListeners,
									dontValidate: !options.validate,
								})
						},
					})
					const form = useTanStackForm({
						defaultValues: checkoutFormInput(sources.values),
						listeners: {
							onChange: ({ fieldApi }) => {
								listen(fieldApi.name)
								fields.handleFieldChange(fieldApi.name, fieldApi.state.value)
							},
						},
					})
					const country = useField({ form, name: "billingAddress.country" })
					const state = useField({ form, name: "billingAddress.state", validators: { onChange: validate } })
					const shippingCountry = useField({ form, name: "shippingAddress.country" })
					const shippingState = useField({ form, name: "shippingAddress.state" })
					return { form, fields, country, state, shippingCountry, shippingState }
				},
				{ wrapper },
			)
			await waitFor(() => expect(result.current.fields.schema).not.toBeNull())
			act(() => result.current.state.setMeta((meta) => ({ ...meta, isDirty: dirty, isTouched: dirty })))
			act(() => result.current.country.handleChange("GB"))
			expect(writes).toEqual([
				[{ name: "billingAddress.state", value: "", options: { runListeners: false, meta: "preserve", validate: false } }],
			])
			expect(result.current.form.state.values.billingAddress?.state).toBe("")
			expect(result.current.state.state.meta).toMatchObject({ isDirty: dirty, isTouched: dirty })
			expect(listen.mock.calls).toEqual([["billingAddress.country"]])
			expect(validate).not.toHaveBeenCalled()
			expect(result.current.fields.billing.fields.find((field) => field.id === "state")?.type).toBe("text")
			act(() => result.current.shippingCountry.handleChange("AE"))
			expect(result.current.form.state.values.shippingAddress?.state).toBe("")
			expect(writes).toHaveLength(2)
			const meta = result.current.form.getFieldMeta("billingAddress.state")
			await act(async () => {
				await result.current.form.validateField("billingAddress.state", "change")
				result.current.form.setFieldMeta("billingAddress.state", (next) => ({
					...next,
					isDirty: meta?.isDirty ?? false,
					isTouched: meta?.isTouched ?? false,
				}))
			})
			expect(validate).toHaveBeenCalledTimes(1)
			expect(result.current.state.state.meta).toMatchObject({ isDirty: dirty, isTouched: dirty })
			expect(procedures.cart.update.call).not.toHaveBeenCalled()
		},
	)
	it.each([false, true])(
		"React Hook Form preserves state metadata (already dirty: %s) and validates only after the patch",
		async (dirty) => {
			const { sources, wrapper } = setup()
			const validate = vi.fn()
			const { result } = renderHook(
				() => {
					const fields: CheckoutFieldsApi = useCheckoutFields({
						getValues: (): CheckoutFormValues => form.getValues(),
						setValues: (updates) => {
							for (const { name, value, options } of updates)
								form.setValue(name, value, {
									shouldDirty: options.meta === "update",
									shouldTouch: options.meta === "update",
									shouldValidate: false,
								})
							const names = updates.filter((update) => update.options.validate).map((update) => update.name)
							if (names.length) void form.trigger(names)
						},
					})
					const form = useRHF<CheckoutFormValues>({
						defaultValues: checkoutFormInput(sources.values),
						resolver: fields.schema
							? (values, context, options) => {
									validate(values.billingAddress?.state)
									return standardSchemaResolver(fields.schema as NonNullable<CheckoutFieldsApi["schema"]>)(values, context, options)
								}
							: undefined,
					})
					const country = useController({ control: form.control, name: "billingAddress.country" })
					const state = useController({ control: form.control, name: "billingAddress.state" })
					return { fields, form, country, state }
				},
				{ wrapper },
			)
			await waitFor(() => expect(result.current.fields.schema).not.toBeNull())
			if (dirty) act(() => result.current.form.setValue("billingAddress.state", "dirty", { shouldDirty: true, shouldTouch: true }))
			act(() => {
				result.current.country.field.onChange("GB")
				result.current.fields.handleFieldChange("billingAddress.country", "GB")
			})
			expect(result.current.form.getValues("billingAddress.state")).toBe("")
			expect(result.current.form.getFieldState("billingAddress.state")).toMatchObject({ isDirty: dirty, isTouched: dirty })
			expect(validate).not.toHaveBeenCalled()
			await act(async () => {
				await result.current.form.trigger()
			})
			expect(validate.mock.calls).toEqual([[""]])
			expect(result.current.form.getFieldState("billingAddress.state")).toMatchObject({ isDirty: dirty, isTouched: dirty })
			act(() => {
				result.current.form.reset({
					...checkoutFormInput(sources.values),
					billingAddress: { ...sources.checkout.billingAddress, country: "GB", state: "London" },
				})
				result.current.fields.reevaluate()
			})
			expect(result.current.form.getValues("billingAddress.state")).toBe("London")
			expect(result.current.fields.billing.fields.find((field) => field.id === "state")?.type).toBe("text")
		},
	)
	it.each([
		["TanStack", TanStackCheckoutForm],
		["React Hook Form", ReactHookFormCheckout],
	] as const)("renders and submits the complete %s example with encoded names and native number values", async (_name, Component) => {
		const { wrapper } = setup()
		render(createElement(Component), { wrapper })
		const reference = await screen.findByLabelText("Reference")
		expect(reference.getAttribute("name")).toBe(safeName)
		fireEvent.change(reference, { target: { value: "NEW" } })
		const quantity = screen.getByLabelText("Quantity")
		fireEvent.change(quantity, { target: { value: "12" } })
		const billingCountry = document.querySelector<HTMLSelectElement>('select[name="billingAddress.country"]')
		if (!billingCountry) throw new Error("Missing billing country")
		fireEvent.change(billingCountry, { target: { value: "GB" } })
		await waitFor(() => expect(document.querySelector('input[name="billingAddress.state"]')).not.toBeNull())
		expect(document.querySelector<HTMLInputElement>('input[name="billingAddress.state"]')?.value).toBe("")
		expect(procedures.cart.update.call).not.toHaveBeenCalled()
		expect(procedures.checkout.confirm.call).not.toHaveBeenCalled()
		fireEvent.click(screen.getByRole("button", { name: "Place order" }))
		await waitFor(() => expect(procedures.checkout.confirm.call).toHaveBeenCalledTimes(1))
		expect(procedures.checkout.confirm.call.mock.calls[0]?.[0].body).toMatchObject({
			billingAddress: { country: "GB", state: "" },
			additionalFields: { [id]: "NEW", "consumer/quantity.a[0]'%%": 12 },
		})
		expect(procedures.checkout.confirm.call.mock.calls[0]?.[0].body).not.toHaveProperty("useShippingAsBilling")
	})
})

describe("real form server channels", () => {
	const failure = () =>
		validationFailure([
			validationIssue({ scope: "field", target: ["billingAddress", "state"], message: "server one" }),
			validationIssue({ scope: "field", target: ["billingAddress", "state"], message: "server two" }),
			validationIssue({ scope: "group", target: ["billingAddress"], message: "billing section" }),
			validationIssue({ scope: "group", target: ["shippingAddress"], message: "shipping section" }),
		])
	it("TanStack applies multiple messages without changing client errors, metadata or validators; edits clear only server issues", async () => {
		const { sources, wrapper } = setup(),
			validate = vi.fn((): string | undefined => undefined)
		procedures.checkout.confirm.call.mockRejectedValue(failure())
		const { result } = renderHook(
			() => {
				const checkout = useCheckout()
				const fields: CheckoutFieldsApi = useCheckoutFields({
					getValues: () => form.state.values,
					setErrors: (patches) => {
						for (const { name, messages } of patches)
							form.setFieldMeta(name, (meta) => ({ ...meta, errorMap: { ...meta.errorMap, onServer: [...messages] } }))
					},
					clearErrors: (names) => {
						for (const name of names) form.setFieldMeta(name, (meta) => ({ ...meta, errorMap: { ...meta.errorMap, onServer: undefined } }))
					},
				})
				const form = useTanStackForm({
					defaultValues: checkoutFormInput(sources.values),
					listeners: { onChange: ({ fieldApi }) => fields.handleFieldChange(fieldApi.name, fieldApi.state.value) },
				})
				const state = useField({ form, name: "billingAddress.state", validators: { onChange: validate } })
				return { fields, checkout, form, state }
			},
			{ wrapper },
		)
		act(() =>
			result.current.state.setMeta((meta) => ({
				...meta,
				isDirty: true,
				isTouched: true,
				errorMap: { ...meta.errorMap, onChange: "client refusal" },
			})),
		)
		await act(async () => {
			await result.current.checkout.confirmAsync({ billingAddress: sources.checkout.billingAddress, paymentMethod: "bacs" }).catch(() => {})
		})
		expect(result.current.state.state.meta).toMatchObject({
			isDirty: true,
			isTouched: true,
			errorMap: { onChange: "client refusal", onServer: ["server one", "server two"] },
		})
		expect(validate).not.toHaveBeenCalled()
		expect(result.current.form.state.values.billingAddress?.state).toBe("KA")
		// A silent committed edit avoids rerunning client validation in this channel-isolation assertion.
		act(() => {
			result.current.form.setFieldValue("billingAddress.state", "new", { dontRunListeners: true, dontValidate: true, dontUpdateMeta: true })
			result.current.fields.handleFieldChange("billingAddress.state", "new")
		})
		expect(result.current.state.state.meta.errorMap.onChange).toBe("client refusal")
		expect(result.current.state.state.meta.errorMap.onServer).toBeUndefined()
		expect(result.current.fields.billing.errors[0]?.message).toBe("billing section")
		expect(result.current.fields.shipping.errors[0]?.message).toBe("shipping section")
	})
	it("React Hook Form restores client errors, preserves dirty/touched values and keeps newer validation errors", async () => {
		const { sources, wrapper } = setup()
		procedures.checkout.confirm.call.mockRejectedValue(failure())
		const { result } = renderHook(
			() => {
				const checkout = useCheckout()
				const [server] = useState(() => reactHookFormServerErrors(() => form))
				const fields = useCheckoutFields({ getValues: () => form.getValues(), ...server })
				const form = useRHF<CheckoutFormValues>({ defaultValues: checkoutFormInput(sources.values) })
				const state = useController({ control: form.control, name: "billingAddress.state" })
				return { fields, form, checkout, state }
			},
			{ wrapper },
		)
		act(() => {
			result.current.form.setValue("billingAddress.state", "dirty", { shouldDirty: true, shouldTouch: true })
			result.current.form.setError("billingAddress.state", {
				type: "client",
				message: "client refusal",
				types: { client: "client refusal" },
			})
		})
		await act(async () => {
			await result.current.checkout.confirmAsync({ billingAddress: sources.checkout.billingAddress, paymentMethod: "bacs" }).catch(() => {})
		})
		expect(result.current.form.getFieldState("billingAddress.state")).toMatchObject({
			isDirty: true,
			isTouched: true,
			error: { type: "client", message: "client refusal", types: { client: "client refusal", kitServer: ["server one", "server two"] } },
		})
		expect(reactHookFormErrorMessages(result.current.form.getFieldState("billingAddress.state").error)).toBe(
			"client refusal, server one, server two",
		)
		act(() => {
			result.current.form.setValue("billingAddress.state", "new")
			result.current.fields.handleFieldChange("billingAddress.state", "new")
		})
		expect(result.current.form.getFieldState("billingAddress.state")).toMatchObject({
			isDirty: true,
			isTouched: true,
			error: { type: "client", message: "client refusal", types: { client: "client refusal" } },
		})
		expect(result.current.form.getFieldState("billingAddress.state").error?.types?.kitServer).toBeUndefined()
		expect(result.current.fields.billing.errors).toHaveLength(1)
		expect(result.current.fields.shipping.errors).toHaveLength(1)
		await act(async () => {
			await result.current.checkout.confirmAsync({ billingAddress: sources.checkout.billingAddress, paymentMethod: "bacs" }).catch(() => {})
		})
		act(() => {
			result.current.form.setError("billingAddress.state", { type: "client", message: "new client refusal" })
			result.current.checkout.reset()
		})
		expect(result.current.form.getFieldState("billingAddress.state").error?.message).toBe("new client refusal")
	})
	it.each([
		["TanStack", TanStackCheckoutForm],
		["React Hook Form", ReactHookFormCheckout],
	] as const)("%s example renders server messages and resubmits without stale server flags", async (_name, Component) => {
		const { sources, wrapper } = setup()
		const error = validationFailure([
			validationIssue({ registeredFields: [{ id, bucket: "additionalFields" }], message: "server one" }),
			validationIssue({ registeredFields: [{ id, bucket: "additionalFields" }], message: "server two" }),
			validationIssue({ scope: "group", target: ["billingAddress"], message: "billing section" }),
			validationIssue({ message: "summary refusal" }),
		])
		procedures.checkout.confirm.call.mockRejectedValueOnce(error).mockResolvedValueOnce(sources.checkout)
		render(createElement(Component), { wrapper })
		await screen.findByLabelText("Reference")
		fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2" } })
		fireEvent.click(screen.getByRole("button", { name: "Place order" }))
		await screen.findByText("billing section")
		expect(screen.getByText("summary refusal")).toBeDefined()
		expect(screen.getByText(/server one, server two/)).toBeDefined()
		// No edit: the next attempt must clear server flags before the form runs submission validation.
		await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Place order" }).disabled).toBe(false))
		fireEvent.click(screen.getByRole("button", { name: "Place order" }))
		await waitFor(() => expect(procedures.checkout.confirm.call).toHaveBeenCalledTimes(2))
		expect(screen.queryByText("billing section")).toBeNull()
		expect(screen.queryByText("summary refusal")).toBeNull()
	})
	it.each([
		["TanStack", TanStackCheckoutForm],
		["React Hook Form", ReactHookFormCheckout],
	] as const)("%s initialization preserves active server errors when the form remounts", async (_name, Component) => {
		const { wrapper } = setup()
		procedures.checkout.confirm.call.mockRejectedValue(
			validationFailure([validationIssue({ registeredFields: [{ id, bucket: "additionalFields" }], message: "still active" })]),
		)
		const first = render(createElement(Component), { wrapper })
		await screen.findByLabelText("Reference")
		fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2" } })
		fireEvent.click(screen.getByRole("button", { name: "Place order" }))
		await screen.findByText("still active")
		first.unmount()
		render(createElement(Component), { wrapper })
		await screen.findByLabelText(/Reference/)
		await screen.findByText("still active")
		expect(procedures.checkout.confirm.call).toHaveBeenCalledTimes(1)
	})
	it.each([
		["TanStack", TanStackCheckoutForm],
		["React Hook Form", ReactHookFormCheckout],
	] as const)("%s clears copied billing issues through the shipping control and retains section failures", async (_name, Component) => {
		const { wrapper } = setup()
		procedures.checkout.confirm.call.mockRejectedValue(
			validationFailure([
				validationIssue({ scope: "field", target: ["billingAddress", "state"], message: "copied refusal" }),
				validationIssue({ scope: "group", target: ["billingAddress"], message: "billing section" }),
				validationIssue({ scope: "group", target: ["shippingAddress"], message: "shipping section" }),
			]),
		)
		render(createElement(Component), { wrapper })
		await screen.findByLabelText("Reference")
		fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2" } })
		fireEvent.click(screen.getByLabelText("Use shipping address for billing"))
		fireEvent.click(screen.getByRole("button", { name: "Place order" }))
		await screen.findByText("copied refusal")
		const control = document.querySelector<HTMLSelectElement>('select[name="shippingAddress.state"]')
		if (!control) throw new Error("Missing copied-address control")
		expect(control.getAttribute("aria-invalid")).toBe("true")
		fireEvent.change(control, { target: { value: "" } })
		await waitFor(() => expect(screen.queryByText("copied refusal")).toBeNull())
		expect(screen.getByText("billing section")).toBeDefined()
		expect(screen.getByText("shipping section")).toBeDefined()
		fireEvent.click(screen.getByLabelText("Use shipping address for billing"))
		expect(screen.queryByText("copied refusal")).toBeNull()
	})
})

// Native controls are rendered by the application rather than storefront field definitions.
it.each([
	["TanStack", TanStackCheckoutForm],
	["React Hook Form", ReactHookFormCheckout],
] as const)("%s renders manual control errors, clears edits and preserves summary fallback", async (_name, Component) => {
	const { wrapper } = setup()
	procedures.checkout.confirm.call.mockRejectedValue(
		validationFailure([
			validationIssue({ scope: "field", target: ["paymentMethod"], message: "Payment refused" }),
			validationIssue({ scope: "field", target: ["customerNote"], message: "Note refused" }),
			validationIssue({ scope: "field", target: ["createAccount"], message: "Account refused" }),
			validationIssue({ scope: "field", target: ["customerPassword"], message: "Password refused" }),
		]),
	)
	render(createElement(Component), { wrapper })
	await screen.findByLabelText("Reference")
	fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2" } })
	fireEvent.click(screen.getByRole("button", { name: "Place order" }))
	await screen.findByText("Payment refused")
	expect(screen.getByText("Note refused")).toBeDefined()
	expect(screen.getByText("Account refused")).toBeDefined()
	expect(screen.getByText("Password refused")).toBeDefined()
	const payment = screen.getByLabelText("Payment method")
	expect(payment.getAttribute("aria-invalid")).toBe("true")
	expect(payment.getAttribute("aria-describedby")).toBe("paymentMethod-error")
	fireEvent.change(payment, { target: { value: "cod" } })
	await waitFor(() => expect(screen.queryByText("Payment refused")).toBeNull())
	expect(payment.getAttribute("aria-invalid")).toBe("false")
	expect(screen.getByText("Note refused")).toBeDefined()
	expect(screen.getByText("Account refused")).toBeDefined()
	expect(screen.getByText("Password refused")).toBeDefined()
})
it("React Hook Form retains server messages through blur without editing and clears them before resubmission", async () => {
	const { sources, wrapper } = setup()
	procedures.checkout.confirm.call
		.mockRejectedValueOnce(
			validationFailure([
				validationIssue({ registeredFields: [{ id, bucket: "additionalFields" }], message: "server one" }),
				validationIssue({ registeredFields: [{ id, bucket: "additionalFields" }], message: "server two" }),
			]),
		)
		.mockResolvedValueOnce(sources.checkout)
	render(createElement(ReactHookFormCheckout), { wrapper })
	await screen.findByLabelText("Reference")
	fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2" } })
	fireEvent.click(screen.getByRole("button", { name: "Place order" }))
	await screen.findByText("server one, server two")
	await act(async () => fireEvent.blur(screen.getByLabelText(/Reference/)))
	expect(screen.getByLabelText(/Reference/).getAttribute("aria-invalid")).toBe("true")
	expect(screen.getByText("server one, server two")).toBeDefined()
	await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Place order" }).disabled).toBe(false))
	fireEvent.click(screen.getByRole("button", { name: "Place order" }))
	await waitFor(() => expect(procedures.checkout.confirm.call).toHaveBeenCalledTimes(2))
	expect(screen.queryByText("server one, server two")).toBeNull()
})

it("React Hook Form retains the latest resolver client error when the server channel clears", async () => {
	const { sources, wrapper } = setup()
	procedures.checkout.confirm.call.mockRejectedValue(
		validationFailure([validationIssue({ registeredFields: [{ id, bucket: "additionalFields" }], message: "server refusal" })]),
	)
	const { result } = renderHook(
		() => {
			const [server] = useState<ReturnType<typeof reactHookFormServerErrors>>(() => reactHookFormServerErrors(() => form))
			const fields = useCheckoutFields({ getValues: () => form.getValues(), ...server })
			const form: UseFormReturn<CheckoutFormValues> = useRHF<CheckoutFormValues>({
				defaultValues: checkoutFormInput(sources.values),
				resolver: fields.schema ? server.withResolver(standardSchemaResolver(fields.schema)) : undefined,
			})
			const control = useController({ control: form.control, name: safeName })
			return { form, fields, control, checkout: useCheckout() }
		},
		{ wrapper },
	)
	await waitFor(() => expect(result.current.fields.schema).not.toBeNull())
	act(() => {
		result.current.form.setValue(safeName, "", { shouldDirty: true, shouldTouch: true })
	})
	await act(async () => {
		await result.current.checkout.confirmAsync({ billingAddress: sources.checkout.billingAddress, paymentMethod: "bacs" }).catch(() => {})
		await result.current.form.trigger(safeName)
	})
	const error = result.current.form.getFieldState(safeName).error
	expect(error?.type).not.toBe("kitServer")
	expect(error?.message).toBeTruthy()
	expect(reactHookFormErrorMessages(error)).toContain("server refusal")
	act(() => result.current.checkout.reset())
	expect(result.current.form.getFieldState(safeName)).toMatchObject({
		isDirty: true,
		isTouched: true,
		error: { type: error?.type, message: error?.message },
	})
	expect(result.current.form.getFieldState(safeName).error?.types?.kitServer).toBeUndefined()
})
it("React Hook Form cannot resurrect server messages when reset occurs during resolver validation", async () => {
	const { sources, wrapper } = setup()
	let finish!: () => void
	const validation = new Promise<void>((resolve) => {
		finish = resolve
	})
	const validating = vi.fn()
	procedures.checkout.confirm.call.mockRejectedValue(
		validationFailure([validationIssue({ registeredFields: [{ id, bucket: "additionalFields" }], message: "server refusal" })]),
	)
	const { result } = renderHook(
		() => {
			const [server] = useState<ReturnType<typeof reactHookFormServerErrors>>(() => reactHookFormServerErrors(() => form))
			const fields = useCheckoutFields({ getValues: () => form.getValues(), ...server })
			const form: UseFormReturn<CheckoutFormValues> = useRHF<CheckoutFormValues>({
				defaultValues: checkoutFormInput(sources.values),
				resolver: server.withResolver(async (values) => {
					validating()
					await validation
					return { values, errors: {} }
				}),
			})
			const control = useController({ control: form.control, name: safeName })
			return { form, fields, control, checkout: useCheckout() }
		},
		{ wrapper },
	)
	await act(async () => {
		await result.current.checkout.confirmAsync({ billingAddress: sources.checkout.billingAddress, paymentMethod: "bacs" }).catch(() => {})
	})
	expect(result.current.form.getFieldState(safeName).error?.types?.kitServer).toEqual(["server refusal"])
	let pending!: Promise<boolean>
	act(() => {
		pending = result.current.form.trigger(safeName)
	})
	await waitFor(() => expect(validating).toHaveBeenCalled())
	act(() => result.current.checkout.reset())
	await act(async () => {
		finish()
		await expect(pending).resolves.toBe(true)
	})
	expect(result.current.form.getFieldState(safeName).error).toBeUndefined()
	expect(result.current.fields.errors).toEqual([])
})
