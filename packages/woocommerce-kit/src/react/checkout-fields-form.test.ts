// @vitest-environment happy-dom

import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { useField, useForm as useTanStackForm } from "@tanstack/react-form"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { useController, useForm as useRHF } from "react-hook-form"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TanStackCheckoutForm } from "../../types/checkout-fields.example"
import { ReactHookFormCheckout } from "../../types/checkout-fields-rhf.example"
import { cartQueryKey } from "../cart"
import { checkoutQueryKey } from "../checkout"
import { checkoutFormInput } from "../checkout-form"
import { field, fixtures } from "../test/checkout-fields-fixture"
import type { CheckoutFieldsApi, CheckoutFieldUpdate, CheckoutFormValues } from "../types"
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
vi.mock("kizlo/react", () => ({ useKizloContext: () => ({ client: { woocommerce: procedures } }) }))
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
			expect(result.current.fields.fields.billing.find((field) => field.id === "state")?.type).toBe("text")
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
			expect(result.current.fields.fields.billing.find((field) => field.id === "state")?.type).toBe("text")
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
