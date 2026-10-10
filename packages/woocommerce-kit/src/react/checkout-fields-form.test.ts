// @vitest-environment happy-dom

import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { useField, useForm as useTanStackForm } from "@tanstack/react-form"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react"
import { createElement, type ReactNode, useState } from "react"
import { type UseFormReturn, useController, useForm as useRHF } from "react-hook-form"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TanStackCheckoutForm as TanStackFieldsForm } from "../../types/checkout-fields.example"
import { ReactHookFormCheckout as ReactHookFieldsForm } from "../../types/checkout-fields-rhf.example"
import { reactHookFormErrorMessages, reactHookFormServerErrors, tanStackValidateField } from "../../types/checkout-server-errors.example"
import { cartQueryKey } from "../cart"
import { checkoutQueryKey } from "../checkout"
import { checkoutFormEncode } from "../checkout-form"
import { validationFailure, validationIssue } from "../test/checkout-errors-fixture"
import { field, fixtures } from "../test/checkout-fields-fixture"
import type { Cart, CheckoutFieldsApi, CheckoutFieldUpdate, CheckoutFormValues } from "../types"
import { useCartAddress } from "./cart"
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
function TanStackCheckoutForm() {
	return createElement(TanStackFieldsForm)
}
function ReactHookFormCheckout() {
	return createElement(ReactHookFieldsForm)
}

const clients: QueryClient[] = []
const id = "plugin/a.b[0]'%"
const safeName = "additionalFields.plugin%2Fa%2Eb%5B0%5D%27%25" as const
function source() {
	const source = fixtures([
		field("country", { location: "address", bindings: { billing: ["country"], shipping: ["country"] } }),
		field("state", { location: "address", bindings: { billing: ["state"], shipping: ["state"] } }),
		field(id, { required: true, label: "Reference" }),
		field("consumer/quantity.a[0]'%%", { type: "text", label: "Quantity", schema: { type: "string", pattern: "^[1-9][0-9]*$" } }),
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
	procedures.cart.update.call.mockImplementation(async ({ body }) => {
		const cart = client.getQueryData<Cart>(cartQueryKey) ?? sources.cart
		return { ...cart, ...body }
	})
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
	vi.useRealTimers()
	for (const client of clients) client.clear()
	clients.length = 0
	vi.resetAllMocks()
})

describe("real form libraries", () => {
	it.each(["TanStack", "React Hook Form"] as const)(
		"%s applies application validators and preserves unrelated server errors during automatic saves",
		async (library) => {
			const { sources, wrapper } = setup()
			sources.storefront.address.fields.push(field("phone", { location: "address", bindings: { billing: ["phone"], shipping: ["phone"] } }))
			if (library === "TanStack") {
				const env = renderHook(
					() => {
						const fields: CheckoutFieldsApi = useCheckoutFields({
							getValues: () => form.state.values,
							setValues: (updates) => {
								for (const { name, value } of updates)
									form.setFieldValue(name, value, { dontValidate: true, dontUpdateMeta: true, dontRunListeners: true })
							},
							validateField: (name) => tanStackValidateField(form, name),
						})
						const form = useTanStackForm({
							defaultValues: { ...checkoutFormEncode(sources.values), useShippingAsBilling: false } as CheckoutFormValues,
							validators: { onChange: fields.schema ?? undefined },
							listeners: { onChange: ({ fieldApi }) => fields.handleFieldChange(fieldApi.name, fieldApi.state.value) },
						})
						const phone = useField({
							form,
							name: "billingAddress.phone",
							validators: { onChange: ({ value }) => (value === "blocked" ? "Application rejection" : undefined) },
						})
						const reference = useField({ form, name: safeName })
						return { fields, form, phone, reference }
					},
					{ wrapper },
				)
				await waitFor(() => expect(env.result.current.fields.schema).not.toBeNull())
				vi.useFakeTimers()
				act(() =>
					env.result.current.reference.setMeta((meta) => ({ ...meta, errorMap: { ...meta.errorMap, onServer: "Unrelated server error" } })),
				)
				act(() => env.result.current.phone.handleChange("blocked"))
				await act(async () => {
					await vi.advanceTimersByTimeAsync(1600)
				})
				expect(procedures.cart.update.call).not.toHaveBeenCalled()
				expect(env.result.current.phone.state.meta.errors).toContain("Application rejection")
				const meta = env.result.current.phone.state.meta
				act(() => env.result.current.phone.handleChange("allowed"))
				await act(async () => {
					await vi.advanceTimersByTimeAsync(1600)
				})
				expect(procedures.cart.update.call).toHaveBeenCalledTimes(1)
				expect(env.result.current.reference.state.meta.errorMap.onServer).toBe("Unrelated server error")
				expect(env.result.current.phone.state.meta).toMatchObject({ isDirty: meta.isDirty, isTouched: meta.isTouched })
			} else {
				const env = renderHook(
					() => {
						const [server] = useState<ReturnType<typeof reactHookFormServerErrors>>(() => reactHookFormServerErrors(() => form))
						const fields: CheckoutFieldsApi = useCheckoutFields({
							getValues: () => form.getValues(),
							setValues: (updates) => {
								for (const { name, value } of updates) form.setValue(name, value)
							},
							validateField: (name) => form.trigger(name),
							...server,
						})
						const form: UseFormReturn<CheckoutFormValues> = useRHF<CheckoutFormValues>({
							defaultValues: { ...checkoutFormEncode(sources.values), useShippingAsBilling: false } as CheckoutFormValues,
							resolver: fields.schema
								? server.withResolver(async (values, context, options) => {
										const result = await standardSchemaResolver(fields.schema as NonNullable<CheckoutFieldsApi["schema"]>)(
											values,
											context,
											options,
										)
										if (values.billingAddress?.phone === "blocked")
											return {
												values: {},
												errors: {
													...result.errors,
													billingAddress: {
														...result.errors.billingAddress,
														phone: { type: "application", message: "Application rejection" },
													},
												},
											}
										return result
									})
								: undefined,
						})
						const phone = useController({ control: form.control, name: "billingAddress.phone" })
						const reference = useController({ control: form.control, name: safeName })
						return { fields, form, phone, reference, server }
					},
					{ wrapper },
				)
				await waitFor(() => expect(env.result.current.fields.schema).not.toBeNull())
				vi.useFakeTimers()
				act(() => env.result.current.server.setErrors([{ name: safeName, messages: ["Unrelated server error"] }]))
				act(() => {
					env.result.current.phone.field.onChange("blocked")
					env.result.current.fields.handleFieldChange("billingAddress.phone", "blocked")
				})
				await act(async () => {
					await vi.advanceTimersByTimeAsync(1600)
				})
				expect(procedures.cart.update.call).not.toHaveBeenCalled()
				expect(env.result.current.phone.fieldState.error?.message).toBe("Application rejection")
				const meta = env.result.current.phone.fieldState
				act(() => {
					env.result.current.phone.field.onChange("allowed")
					env.result.current.fields.handleFieldChange("billingAddress.phone", "allowed")
				})
				await act(async () => {
					await vi.advanceTimersByTimeAsync(1600)
				})
				expect(procedures.cart.update.call).toHaveBeenCalledTimes(1)
				expect(env.result.current.reference.fieldState.error?.types?.kitServer).toEqual(["Unrelated server error"])
				expect(env.result.current.phone.fieldState).toMatchObject({ isDirty: meta.isDirty, isTouched: meta.isTouched })
			}
		},
	)
	it("TanStack background validation preserves interaction flags and does not undo a later real blur", async () => {
		let complete!: () => void
		const pending = new Promise<undefined>((resolve) => {
			complete = () => resolve(undefined)
		})
		const env = renderHook(() => {
			const form = useTanStackForm({ defaultValues: { billingAddress: { phone: "allowed" } } })
			const phone = useField({ form, name: "billingAddress.phone", validators: { onChangeAsync: () => pending } })
			return { form, phone }
		})
		act(() => env.result.current.phone.setMeta((meta) => ({ ...meta, isDirty: true, isTouched: false })))
		let result: Promise<boolean> | undefined
		act(() => {
			result = tanStackValidateField(env.result.current.form, "billingAddress.phone")
		})
		expect(env.result.current.phone.state.meta).toMatchObject({ isDirty: true, isTouched: false })
		act(() => env.result.current.phone.handleBlur())
		await act(async () => {
			complete()
			await result
		})
		expect(env.result.current.phone.state.meta).toMatchObject({ isDirty: true, isTouched: true })
	})
	it.each([
		["TanStack", TanStackCheckoutForm],
		["React Hook Form", ReactHookFormCheckout],
	] as const)(
		"%s blocks an invalid postcode before first submit and saves a correction despite an unrelated error",
		async (_name, Component) => {
			const { sources, wrapper } = setup()
			sources.storefront.address.fields.push(
				field("postcode", {
					location: "address",
					label: "PIN",
					required: true,
					bindings: { billing: ["postcode"], shipping: ["postcode"] },
				}),
			)
			render(createElement(Component), { wrapper })
			const reference = await screen.findByLabelText("Reference")
			const postcode = document.querySelector<HTMLInputElement>('input[name="shippingAddress.postcode"]')
			if (!postcode) throw new Error("Missing shipping postcode")
			vi.useFakeTimers()
			fireEvent.change(reference, { target: { value: "" } })
			fireEvent.change(postcode, { target: { value: "INVALID" } })
			await act(async () => {
				await vi.advanceTimersByTimeAsync(1600)
			})
			expect(procedures.cart.update.call).not.toHaveBeenCalled()
			expect(procedures.checkout.confirm.call).not.toHaveBeenCalled()
			fireEvent.change(postcode, { target: { value: "560002" } })
			fireEvent.blur(postcode)
			await act(async () => {
				await vi.advanceTimersByTimeAsync(50)
			})
			expect(procedures.cart.update.call).toHaveBeenCalledTimes(1)
			expect(procedures.cart.update.call.mock.calls[0]?.[0].body).toMatchObject({
				shippingAddress: { postcode: "560002" },
				billingAddress: { postcode: "560002" },
			})
			expect(reference).toHaveProperty("value", "")
			expect(procedures.checkout.confirm.call).not.toHaveBeenCalled()
		},
	)
	it.each(["TanStack", "React Hook Form"] as const)(
		"%s copies without requesting validation and allows the consumer to validate the complete batch",
		async (library) => {
			const { sources, wrapper } = setup()
			const defaultValues: CheckoutFormValues = {
				...checkoutFormEncode(sources.values),
				useShippingAsBilling: false,
				shippingAddress: { ...sources.checkout.shippingAddress, country: "GB", state: "London" },
			}
			const validate = vi.fn()
			const listen = vi.fn()
			if (library === "TanStack") {
				const { result } = renderHook(
					() => {
						const fields: CheckoutFieldsApi = useCheckoutFields({
							getValues: () => form.state.values,
							setValues: (updates) => {
								for (const { name, value, options } of updates)
									form.setFieldValue(name, value, {
										dontRunListeners: !options.runListeners,
										dontUpdateMeta: options.meta === "preserve",
										dontValidate: true,
									})
								for (const { name, options } of updates) if (options.validate) void form.validateField(name, "change")
							},
						})
						const form = useTanStackForm({
							defaultValues,
							listeners: {
								onChange: ({ fieldApi }) => {
									listen(fieldApi.name)
									fields.handleFieldChange(fieldApi.name, fieldApi.state.value)
								},
							},
						})
						const country = useField({
							form,
							name: "billingAddress.country",
							validators: {
								onChange: ({ value }) => {
									validate(value, form.state.values.billingAddress?.state)
								},
							},
						})
						const state = useField({ form, name: "billingAddress.state" })
						return { form, fields, country, state }
					},
					{ wrapper },
				)
				await waitFor(() => expect(result.current.fields.schema).not.toBeNull())
				act(() => result.current.fields.copyShippingToBilling())
				expect(result.current.form.state.values.billingAddress).toMatchObject({
					country: "GB",
					state: "London",
					email: "ada@example.com",
					taxId: "TAX",
				})
				expect(validate).not.toHaveBeenCalled()
				await act(async () => {
					await result.current.form.validateField("billingAddress.country", "change")
				})
				expect(validate.mock.calls).toEqual([["GB", "London"]])
				expect(result.current.country.state.meta).toMatchObject({ isDirty: true, isTouched: true })
				expect(result.current.state.state.meta).toMatchObject({ isDirty: true, isTouched: true })
				expect(listen).not.toHaveBeenCalled()
				expect(result.current.form.state.values.useShippingAsBilling).toBe(false)
				expect(result.current.fields.billing.fields.find((field) => field.id === "state")?.label).toBe("County")
			} else {
				const { result } = renderHook(
					() => {
						const fields: CheckoutFieldsApi = useCheckoutFields({
							getValues: () => form.getValues(),
							setValues: (updates) => {
								for (const { name, value, options } of updates) {
									form.setValue(name, value, {
										shouldDirty: options.meta === "update",
										shouldTouch: options.meta === "update",
										shouldValidate: false,
									})
									if (options.runListeners) {
										listen(name)
										fields.handleFieldChange(name, value)
									}
								}
								const names = updates.filter(({ options }) => options.validate).map(({ name }) => name)
								if (names.length) void form.trigger(names)
							},
						})
						const form: UseFormReturn<CheckoutFormValues> = useRHF<CheckoutFormValues>({
							defaultValues,
							resolver: (values) => {
								validate(values.billingAddress?.country, values.billingAddress?.state)
								return { values, errors: {} }
							},
						})
						const country = useController({ control: form.control, name: "billingAddress.country" })
						const state = useController({ control: form.control, name: "billingAddress.state" })
						return { form, fields, country, state }
					},
					{ wrapper },
				)
				await waitFor(() => expect(result.current.fields.schema).not.toBeNull())
				await act(async () => result.current.fields.copyShippingToBilling())
				expect(result.current.form.getValues("billingAddress")).toMatchObject({
					country: "GB",
					state: "London",
					email: "ada@example.com",
					taxId: "TAX",
				})
				expect(validate).not.toHaveBeenCalled()
				await act(async () => {
					await result.current.form.trigger()
				})
				expect(validate.mock.calls).toEqual([["GB", "London"]])
				expect(result.current.country.fieldState).toMatchObject({ isDirty: true, isTouched: true })
				expect(result.current.state.fieldState).toMatchObject({ isDirty: true, isTouched: true })
				expect(listen).not.toHaveBeenCalled()
				expect(result.current.form.getValues("useShippingAsBilling")).toBe(false)
				expect(result.current.fields.billing.fields.find((field) => field.id === "state")?.label).toBe("County")
			}
			expect(procedures.cart.update.call).not.toHaveBeenCalled()
			expect(procedures.checkout.confirm.call).not.toHaveBeenCalled()
		},
	)
	it.each([
		["TanStack", TanStackCheckoutForm],
		["React Hook Form", ReactHookFormCheckout],
	] as const)("%s example copies on demand and preserves separate billing after later shipping edits", async (_name, Component) => {
		const { sources, wrapper } = setup()
		sources.checkout.shippingAddress.country = "GB"
		sources.checkout.shippingAddress.state = "London"
		render(createElement(Component), { wrapper })
		const sharing = await screen.findByLabelText<HTMLInputElement>("Use shipping address for billing")
		fireEvent.click(sharing)
		const copy = await screen.findByRole("button", { name: "Copy shipping address to billing" })
		fireEvent.click(copy)
		await waitFor(() => expect(document.querySelector<HTMLInputElement>('input[name="billingAddress.state"]')?.value).toBe("London"))
		expect(document.querySelector<HTMLSelectElement>('select[name="billingAddress.country"]')?.value).toBe("GB")
		expect(sharing.checked).toBe(false)
		const shippingState = document.querySelector<HTMLInputElement>('input[name="shippingAddress.state"]')
		if (!shippingState) throw new Error("Missing shipping state")
		fireEvent.change(shippingState, { target: { value: "Later" } })
		expect(document.querySelector<HTMLInputElement>('input[name="billingAddress.state"]')?.value).toBe("London")
		await waitFor(() => expect(procedures.cart.update.call).toHaveBeenCalledTimes(1))
		expect(procedures.checkout.confirm.call).not.toHaveBeenCalled()
	})
	it.each([
		["TanStack", TanStackCheckoutForm],
		["React Hook Form", ReactHookFormCheckout],
	] as const)("%s example keeps hidden bindings registered, validates them and preserves boolean values", async (_name, Component) => {
		const { sources, wrapper } = setup()
		sources.storefront.address.fields.push(
			field("plugin/consent", {
				label: "Consent",
				type: "checkbox",
				required: true,
				schema: { type: "boolean" },
				hidden: { properties: { checkout: { properties: { create_account: { const: true } } } } },
			}),
		)
		sources.checkout.additionalFields = { ...sources.checkout.additionalFields, "plugin/consent": false }
		render(createElement(Component), { wrapper })
		const consent = await screen.findByRole<HTMLInputElement>("checkbox", { name: "Consent" })
		const account = screen.getByLabelText("Create account")
		fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2" } })
		fireEvent.click(account)
		await waitFor(() => expect(consent.closest("label")?.hidden).toBe(true))
		expect(screen.queryByRole("checkbox", { name: "Consent" })).toBeNull()
		expect(document.querySelector('input[name="additionalFields.plugin%2Fconsent"]')).toBe(consent)
		expect(consent.checked).toBe(false)
		const form = consent.closest("form")
		if (!form) throw new Error("Missing form")
		fireEvent.submit(form)
		await waitFor(() => expect(consent.getAttribute("aria-invalid")).toBe("true"))
		expect(procedures.checkout.confirm.call).not.toHaveBeenCalled()
		fireEvent.click(account)
		await waitFor(() => expect(consent.closest("label")?.hidden).toBe(false))
		expect(screen.getByRole("checkbox", { name: /^Consent\b/ })).toBe(consent)
		expect(consent.checked).toBe(false)
		fireEvent.click(consent)
		fireEvent.click(account)
		await waitFor(() => expect(consent.closest("label")?.hidden).toBe(true))
		expect(consent.checked).toBe(true)
		fireEvent.submit(form)
		await waitFor(() => expect(procedures.checkout.confirm.call).toHaveBeenCalledTimes(1))
		expect(procedures.checkout.confirm.call.mock.calls[0]?.[0].body.additionalFields["plugin/consent"]).toBe(true)
	})
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
						defaultValues: { ...checkoutFormEncode(sources.values), useShippingAsBilling: false } as CheckoutFormValues,
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
				[
					{ name: "billingAddress.state", value: "", options: { runListeners: false, meta: "preserve", validate: false } },
					{ name: "billingAddress.postcode", value: "", options: { runListeners: false, meta: "preserve", validate: false } },
				],
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
					const form: UseFormReturn<CheckoutFormValues> = useRHF<CheckoutFormValues>({
						defaultValues: { ...checkoutFormEncode(sources.values), useShippingAsBilling: false } as CheckoutFormValues,
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
			if (dirty)
				act(() => {
					result.current.form.setValue("billingAddress.state", "dirty", { shouldDirty: true, shouldTouch: true })
					result.current.fields.handleFieldChange("billingAddress.state", "dirty")
				})
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
					...checkoutFormEncode(sources.values),
					useShippingAsBilling: false,
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
	] as const)(
		"renders and submits the complete %s example with encoded names and SDK-compatible scalar answers",
		async (_name, Component) => {
			const { wrapper } = setup()
			render(createElement(Component), { wrapper })
			const reference = await screen.findByLabelText("Reference")
			expect(reference.getAttribute("name")).toBe(safeName)
			fireEvent.change(reference, { target: { value: "NEW" } })
			const quantity = screen.getByLabelText("Quantity")
			fireEvent.change(quantity, { target: { value: "12" } })
			const sharing = screen.getByLabelText<HTMLInputElement>("Use shipping address for billing")
			expect(sharing.checked).toBe(true)
			fireEvent.click(sharing)
			await waitFor(() => expect(document.querySelector('select[name="billingAddress.country"]')).not.toBeNull())
			const billingCountry = document.querySelector<HTMLSelectElement>('select[name="billingAddress.country"]')
			if (!billingCountry) throw new Error("Missing billing country")
			fireEvent.change(billingCountry, { target: { value: "GB" } })
			await waitFor(() => expect(document.querySelector('input[name="billingAddress.state"]')).not.toBeNull())
			expect(document.querySelector<HTMLInputElement>('input[name="billingAddress.state"]')?.value).toBe("")
			await waitFor(() => expect(procedures.cart.update.call).toHaveBeenCalledTimes(1))
			await waitFor(() => expect(screen.getByRole("button", { name: "Place order" }).hasAttribute("disabled")).toBe(false))
			expect(procedures.checkout.confirm.call).not.toHaveBeenCalled()
			fireEvent.click(screen.getByRole("button", { name: "Place order" }))
			await waitFor(() => expect(procedures.checkout.confirm.call).toHaveBeenCalledTimes(1))
			expect(procedures.checkout.confirm.call.mock.calls[0]?.[0].body).toMatchObject({
				billingAddress: { country: "GB", state: "" },
				additionalFields: { [id]: "NEW", "consumer/quantity.a[0]'%%": "12" },
			})
			expect(procedures.checkout.confirm.call.mock.calls[0]?.[0].body).not.toHaveProperty("useShippingAsBilling")
		},
	)
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
					defaultValues: { ...checkoutFormEncode(sources.values), useShippingAsBilling: false } as CheckoutFormValues,
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
				const [server] = useState<ReturnType<typeof reactHookFormServerErrors>>(() => reactHookFormServerErrors(() => form))
				const fields = useCheckoutFields({ getValues: () => form.getValues(), ...server })
				const form: UseFormReturn<CheckoutFormValues> = useRHF<CheckoutFormValues>({
					defaultValues: { ...checkoutFormEncode(sources.values), useShippingAsBilling: false },
				})
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
	] as const)("%s example replaces repeated submission failures and retries without stale server flags", async (_name, Component) => {
		const { sources, wrapper } = setup()
		const error = validationFailure([
			validationIssue({ registeredFields: [{ id, bucket: "additionalFields" }], message: "server one" }),
			validationIssue({ registeredFields: [{ id, bucket: "additionalFields" }], message: "server two" }),
			validationIssue({ scope: "group", target: ["billingAddress"], message: "billing section" }),
			validationIssue({ message: "summary refusal" }),
		])
		procedures.checkout.confirm.call
			.mockRejectedValueOnce(error)
			.mockRejectedValueOnce(
				validationFailure([validationIssue({ registeredFields: [{ id, bucket: "additionalFields" }], message: "new refusal" })]),
			)
			.mockResolvedValueOnce(sources.checkout)
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
		await screen.findByText("new refusal")
		expect(screen.queryByText(/server one, server two/)).toBeNull()
		await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Place order" }).disabled).toBe(false))
		fireEvent.click(screen.getByRole("button", { name: "Place order" }))
		await waitFor(() => expect(procedures.checkout.confirm.call).toHaveBeenCalledTimes(3))
		expect(screen.queryByText("new refusal")).toBeNull()
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
		expect(screen.getByLabelText<HTMLInputElement>("Use shipping address for billing").checked).toBe(true)
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
				defaultValues: { ...checkoutFormEncode(sources.values), useShippingAsBilling: false } as CheckoutFormValues,
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
				defaultValues: { ...checkoutFormEncode(sources.values), useShippingAsBilling: false } as CheckoutFormValues,
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

// Preparation supplies the empty method of a payment-free order and omits digital shipping.
it.each([
	["TanStack", TanStackCheckoutForm],
	["React Hook Form", ReactHookFormCheckout],
] as const)("%s prepares a payment-free digital confirmation directly", async (_name, Component) => {
	const { sources, wrapper } = setup()
	sources.cart.needsShipping = false
	sources.cart.needsPayment = false
	sources.checkout.paymentMethod = null
	render(createElement(Component), { wrapper })
	await screen.findByLabelText("Reference")
	fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2" } })
	fireEvent.click(screen.getByRole("button", { name: "Place order" }))
	await waitFor(() => expect(procedures.checkout.confirm.call).toHaveBeenCalledTimes(1))
	const output = procedures.checkout.confirm.call.mock.calls[0]?.[0].body
	expect(output).toMatchObject({ billingAddress: { country: "IN", additionalFields: {} }, paymentMethod: "" })
	expect(output).not.toHaveProperty("shippingAddress")
	expect(output).not.toHaveProperty("useShippingAsBilling")
})
it.each([
	["TanStack", TanStackCheckoutForm],
	["React Hook Form", ReactHookFormCheckout],
] as const)("%s stops an unselected registered enum through form validation", async (_name, Component) => {
	const { sources, wrapper } = setup()
	sources.storefront.address.fields.push(
		field("plugin/choice", {
			label: "Choice",
			type: "select",
			required: true,
			schema: { type: "string", enum: ["red", "blue"] },
			options: [
				{ label: "Red", value: "red" },
				{ label: "Blue", value: "blue" },
			],
		}),
	)
	render(createElement(Component), { wrapper })
	const control = await screen.findByLabelText("Choice")
	fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2" } })
	fireEvent.click(screen.getByRole("button", { name: "Place order" }))
	await waitFor(() => expect(control.getAttribute("aria-invalid")).toBe("true"))
	expect(procedures.checkout.confirm.call).not.toHaveBeenCalled()
	fireEvent.change(control, { target: { value: "red" } })
	fireEvent.click(screen.getByRole("button", { name: "Place order" }))
	await waitFor(() => expect(procedures.checkout.confirm.call).toHaveBeenCalledTimes(1))
	expect(procedures.checkout.confirm.call.mock.calls[0]?.[0].body.additionalFields).toHaveProperty("plugin/choice", "red")
})
it("editing and repricing an incomplete form use draft projection without requiring confirmable output", async () => {
	const { sources, wrapper } = setup()
	sources.storefront.checkout.forcedBillingAddress = true
	procedures.cart.update.call.mockResolvedValue(sources.cart)
	const defaultValues: CheckoutFormValues = {
		billingAddress: { country: "IN", state: "KA", city: "Bengaluru", postcode: "" },
		additionalFields: { "plugin%2Fchoice": "" },
	}
	const { result } = renderHook(
		() => {
			const address = useCartAddress({ addressDebounceMs: 0, shouldUpdateAddress: () => true })
			const fields: CheckoutFieldsApi = useCheckoutFields({ getValues: () => form.state.values })
			const form = useTanStackForm({
				defaultValues,
				listeners: {
					onChange: ({ fieldApi }) => {
						fields.handleFieldChange(fieldApi.name, fieldApi.state.value)
						const billing = form.state.values.billingAddress
						address.onAddressChange({
							billingAddress: {
								country: billing?.country ?? "",
								state: billing?.state ?? "",
								city: billing?.city ?? "",
								postcode: billing?.postcode ?? "",
							},
						})
					},
				},
			})
			const postcode = useField({ form, name: "billingAddress.postcode" })
			return { fields, form, postcode }
		},
		{ wrapper },
	)
	await waitFor(() => expect(result.current.fields.schema).not.toBeNull())
	expect(result.current.fields.decode(result.current.form.state.values)).toEqual({
		billingAddress: defaultValues.billingAddress,
		additionalFields: { "plugin/choice": "" },
	})
	act(() => result.current.postcode.handleChange("560002"))
	await waitFor(() => expect(procedures.cart.update.call).toHaveBeenCalledTimes(1))
	expect(result.current.fields.unsupported).toEqual([])
	expect(result.current.form.state.values.billingAddress?.postcode).toBe("560002")
	expect(procedures.cart.update.call.mock.calls[0]?.[0].body.shippingAddress).toMatchObject({ country: "IN", postcode: "560002" })
	expect(procedures.checkout.confirm.call).not.toHaveBeenCalled()
})

it.each([
	["TanStack", TanStackFieldsForm],
	["React Hook Form", ReactHookFieldsForm],
] as const)("%s example prepares a validated request with caller provider input", async (_name, Component) => {
	const { sources, wrapper } = setup()
	sources.cart.needsShipping = false
	render(createElement(Component, { input: { paymentData: [{ key: "token", value: "caller-token" }] } }), { wrapper })
	await screen.findByLabelText("Reference")
	fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "2" } })
	fireEvent.click(screen.getByRole("button", { name: "Place order" }))
	await waitFor(() => expect(procedures.checkout.confirm.call).toHaveBeenCalledTimes(1))
	const request = procedures.checkout.confirm.call.mock.calls[0]?.[0].body
	expect(request).toMatchObject({
		additionalFields: { [id]: "OLD", "consumer/quantity.a[0]'%%": "2" },
		billingAddress: { country: "IN" },
		paymentData: [{ key: "token", value: "caller-token" }],
		expectedTotal: "12345",
	})
	expect(request).not.toHaveProperty("shippingAddress")
	expect(request).not.toHaveProperty("useShippingAsBilling")
})

it.each([
	["TanStack", TanStackFieldsForm],
	["React Hook Form", ReactHookFieldsForm],
] as const)("%s retains native number controls but reports SDK-incompatible request answers locally", async (_name, Component) => {
	const { sources, wrapper } = setup()
	const quantity = sources.storefront.address.fields.find((definition) => definition.label === "Quantity")
	if (!quantity) throw new Error("Expected the quantity fixture")
	quantity.type = "number"
	quantity.schema = { type: "number", minimum: 1 }
	render(createElement(Component), { wrapper })
	const control = await screen.findByLabelText("Quantity")
	fireEvent.change(control, { target: { value: "2" } })
	fireEvent.click(screen.getByRole("button", { name: "Place order" }))
	await waitFor(() => expect(control.getAttribute("aria-invalid")).toBe("true"))
	expect(procedures.checkout.confirm.call).not.toHaveBeenCalled()
})

it.each([
	["TanStack", TanStackFieldsForm],
	["React Hook Form", ReactHookFieldsForm],
] as const)("%s displays a mismatched total, preserves the draft and requires an explicit retry", async (_name, Component) => {
	const { sources, wrapper } = setup()
	const updated = { ...sources.cart, totals: { ...sources.cart.totals, total: 22222 } }
	procedures.checkout.confirm.call.mockRejectedValueOnce(
		Object.assign(new Error("Total increased"), {
			code: "CHECKOUT_TOTAL_MISMATCH",
			data: { cart: updated, expectedTotal: "12345", actualTotal: "22222" },
		}),
	)
	render(createElement(Component), { wrapper })
	const note = (await screen.findByLabelText("Order note")) as HTMLTextAreaElement
	fireEvent.change(note, { target: { value: "keep this draft" } })
	fireEvent.change(screen.getByLabelText("Quantity"), { target: { value: "12" } })
	fireEvent.click(screen.getByRole("button", { name: "Place order" }))
	await screen.findByText("Review the updated checkout total and submit again.")
	expect(screen.getByText(/Total:.*222\.22/)).toBeTruthy()
	expect(note.value).toBe("keep this draft")
	expect(procedures.checkout.confirm.call).toHaveBeenCalledTimes(1)
	expect(procedures.checkout.confirm.call.mock.calls[0]?.[0].body.expectedTotal).toBe("12345")
	fireEvent.click(screen.getByRole("button", { name: "Place order" }))
	await waitFor(() => expect(procedures.checkout.confirm.call).toHaveBeenCalledTimes(2))
	expect(procedures.checkout.confirm.call.mock.calls[1]?.[0].body).toMatchObject({
		expectedTotal: "22222",
		customerNote: "keep this draft",
	})
})
