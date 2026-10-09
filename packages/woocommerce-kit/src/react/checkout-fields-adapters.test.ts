// @vitest-environment happy-dom

import { standardSchemaResolver } from "@hookform/resolvers/standard-schema"
import { useField, useForm as useTanStackForm } from "@tanstack/react-form"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { createElement, type ReactNode, useState } from "react"
import { type Resolver, type ResolverResult, type UseFormReturn, useController, useForm as useReactHookForm } from "react-hook-form"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useReactHookFormCheckoutDefaults } from "../../types/checkout-form-rhf.example"
import { useTanStackCheckoutDefaults, validateCheckoutForm } from "../../types/checkout-form-tanstack.example"
import { cartQueryKey } from "../cart"
import { checkoutQueryKey } from "../checkout"
import { validationFailure, validationIssue } from "../test/checkout-errors-fixture"
import { field, fixtures } from "../test/checkout-fields-fixture"
import type { CheckoutFieldBinding, CheckoutFieldsApi, CheckoutFieldUpdate, CheckoutFormFieldName, CheckoutFormValues } from "../types"
import { useCheckout } from "./checkout"
import { useCheckoutFields } from "./checkout-fields"
import { checkoutErrorMessages, mergeCheckoutFormErrors, reactHookFormAdapter } from "./checkout-fields-react-hook-form"
import { checkoutFormErrorMessages, tanstackFormAdapter } from "./checkout-fields-tanstack-form"
import { WooCommerceProvider } from "./provider"
import { storefrontQueryKey } from "./storefront"

const { procedures } = vi.hoisted(() => {
	const procedure = () => ({ call: vi.fn() })
	return {
		procedures: {
			cart: { get: procedure(), update: procedure() },
			checkout: { get: procedure(), confirm: procedure() },
			storefront: { get: procedure() },
		},
	}
})
vi.mock("kizlo/react", () => {
	const client = { woocommerce: procedures }
	return { useKizloContext: () => ({ client }) }
})
const plugin = "plugin/a.b[0]'%"
const pluginName = "additionalFields.plugin%2Fa%2Eb%5B0%5D%27%25" as const
const clients: QueryClient[] = []
function setup() {
	const sources = fixtures([
		field("country", { location: "address", bindings: { billing: ["country"], shipping: ["country"] } }),
		field("state", { location: "address", bindings: { billing: ["state"], shipping: ["state"] } }),
		field("postcode", { location: "address", bindings: { billing: ["postcode"], shipping: ["postcode"] } }),
		field(plugin, { required: true }),
	])
	sources.checkout.shippingAddress.country = "IN"
	sources.checkout.shippingAddress.state = "KA"
	sources.checkout.additionalFields = { [plugin]: "initial" }
	const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } })
	clients.push(client)
	client.setQueryData(cartQueryKey, sources.cart)
	client.setQueryData(checkoutQueryKey, sources.checkout)
	client.setQueryData(storefrontQueryKey, sources.storefront)
	procedures.checkout.get.call.mockResolvedValue(sources.checkout)
	procedures.cart.get.call.mockResolvedValue(sources.cart)
	procedures.storefront.get.call.mockResolvedValue(sources.storefront)
	procedures.cart.update.call.mockImplementation(async ({ body }) => ({ ...client.getQueryData(cartQueryKey), ...body }))
	const wrapper = ({ children }: { children: ReactNode }) =>
		createElement(QueryClientProvider, { client }, createElement(WooCommerceProvider, { children }))
	return { sources, client, wrapper }
}
beforeEach(() => vi.clearAllMocks())
afterEach(() => {
	cleanup()
	vi.useRealTimers()
	for (const client of clients) client.clear()
	clients.length = 0
	vi.resetAllMocks()
})

describe.each(["TanStack", "React Hook Form"] as const)("%s update options", (library) => {
	it.each(
		[false, true].flatMap((runListeners) =>
			["preserve", "update"].flatMap((meta) => [false, true].map((validate) => ({ runListeners, meta, validate }))),
		) as CheckoutFieldUpdate["options"][],
	)("supports $runListeners listeners, $meta metadata and $validate validation", async (options) => {
		const listener = vi.fn()
		const validation = vi.fn()
		if (library === "TanStack") {
			const env = renderHook(() => {
				const form = useTanStackForm({
					defaultValues: { shippingAddress: { state: "KA" }, customerNote: "old" } as CheckoutFormValues,
					listeners: { onChange: listener },
					validators: {
						onChange: ({ value }) => {
							validation(structuredClone(value))
						},
					},
				})
				const state = useField({ form, name: "shippingAddress.state" })
				const note = useField({ form, name: "customerNote" })
				return { form, state, note, binding: tanstackFormAdapter(form) }
			})
			await act(async () => {
				await env.result.current.binding.setValues([
					{ name: "shippingAddress.state", value: "new", options },
					{ name: "customerNote", value: "batch", options: { ...options, validate: false } },
				])
			})
			expect(env.result.current.state.state.meta).toMatchObject({
				isDirty: options.meta === "update",
				isTouched: options.meta === "update",
			})
		} else {
			const env = renderHook(() => {
				const form = useReactHookForm<CheckoutFormValues>({
					defaultValues: { shippingAddress: { state: "KA" }, customerNote: "old" },
					resolver: (values) => {
						validation(structuredClone(values))
						return { values, errors: {} }
					},
				})
				useController({ control: form.control, name: "shippingAddress.state" })
				useController({ control: form.control, name: "customerNote" })
				return { form, binding: reactHookFormAdapter(form, { onChange: listener }) }
			})
			await act(async () => {
				await env.result.current.binding.setValues([
					{ name: "shippingAddress.state", value: "new", options },
					{ name: "customerNote", value: "batch", options: { ...options, validate: false } },
				])
			})
			expect(env.result.current.form.getFieldState("shippingAddress.state")).toMatchObject({
				isDirty: options.meta === "update",
				isTouched: options.meta === "update",
			})
		}
		expect(listener).toHaveBeenCalledTimes(options.runListeners ? 2 : 0)
		expect(validation).toHaveBeenCalledTimes(options.validate ? 1 : 0)
		if (options.validate) expect(validation.mock.calls[0]?.[0]).toMatchObject({ shippingAddress: { state: "new" }, customerNote: "batch" })
	})
})

// The harness owns the same native setup and lifecycle as a consuming application.
function useTanStackAdapter(
	submit = vi.fn(),
	validate?: () => unknown,
	validateAsync?: (value: string | undefined) => Promise<unknown>,
	validateFormAsync?: (values: CheckoutFormValues) => Promise<unknown>,
) {
	const [defaults, setDefaults] = useState<CheckoutFormValues>({})
	const form = useTanStackForm({
		defaultValues: defaults,
		validators: {
			onChange: ({ value }) => validateCheckoutForm(fields, value),
			onChangeAsync: validateFormAsync ? ({ value }) => validateFormAsync(value) : undefined,
			onSubmit: ({ value }) => validateCheckoutForm(fields, value),
		},
		listeners: {
			onChange: ({ fieldApi }) => fields.handleFieldChange(fieldApi.name, fieldApi.state.value),
			onBlur: ({ fieldApi }) => fields.handleFieldBlur(fieldApi.name),
		},
		onSubmit: ({ value }) => submit(fields.decode(value)),
	})
	const adapter = tanstackFormAdapter(form)
	const fields: CheckoutFieldsApi = useCheckoutFields(adapter)
	useTanStackCheckoutDefaults(form, fields, setDefaults)
	const country = useField({ form, name: "shippingAddress.country" })
	const state = useField({ form, name: "shippingAddress.state" })
	const postcode = useField({
		form,
		name: "shippingAddress.postcode",
		validators: { onChange: validate, onChangeAsync: validateAsync ? ({ value }) => validateAsync(value) : undefined },
	})
	const reference = useField({ form, name: pluginName })
	const note = useField({ form, name: "customerNote" })
	return { fields, adapter, form, country, state, postcode, reference, note, checkout: useCheckout() }
}
function useRHFAdapter(resolver?: Resolver<CheckoutFormValues>) {
	const form: UseFormReturn<CheckoutFormValues> = useReactHookForm<CheckoutFormValues>({
		defaultValues: {},
		resolver: (values, context, native) =>
			adapter.withResolver(async (input, ctx, options) => {
				const kit = fields.schema
					? await standardSchemaResolver(fields.schema)(input, ctx, options)
					: { values: {}, errors: { root: { type: "kitSchema", message: "Checkout fields are not ready" } } }
				const application = resolver ? await resolver(input, ctx, options) : { values: input, errors: {} }
				const errors = mergeCheckoutFormErrors(kit.errors, application.errors)
				return Object.keys(errors).length ? { values: {}, errors } : { values: application.values as CheckoutFormValues, errors: {} }
			})(values, context, native),
	})
	const adapter = reactHookFormAdapter(form)
	const fields: CheckoutFieldsApi = useCheckoutFields(adapter)
	useReactHookFormCheckoutDefaults(form, fields)
	const country = useController({ control: form.control, name: "shippingAddress.country" })
	const state = useController({ control: form.control, name: "shippingAddress.state" })
	const postcode = useController({ control: form.control, name: "shippingAddress.postcode" })
	const reference = useController({ control: form.control, name: pluginName })
	const note = useController({ control: form.control, name: "customerNote" })
	// Event routing belongs to the app, after native values and metadata have committed.
	const bind = (field: {
		name: CheckoutFormFieldName
		value: CheckoutFieldBinding["value"]
		onChange: (value: unknown) => void
		onBlur: () => void
	}): CheckoutFieldBinding => ({
		value: field.value,
		onValueChange: (value) => {
			field.onChange(value)
			fields.handleFieldChange(field.name, value)
		},
		onBlur: () => {
			field.onBlur()
			fields.handleFieldBlur(field.name)
		},
	})
	return { fields, adapter, bind, form, country, state, postcode, reference, note, checkout: useCheckout() }
}

it("TanStack preserves other server errors on the same field when Kit clears", async () => {
	const { sources, wrapper } = setup()
	procedures.checkout.confirm.call.mockRejectedValue(
		validationFailure([validationIssue({ registeredFields: [{ id: plugin, bucket: "additionalFields" }], message: "Kit refusal" })]),
	)
	const env = renderHook(() => useTanStackAdapter(), { wrapper })
	await waitFor(() => expect(env.result.current.fields.schema).not.toBeNull())
	act(() =>
		env.result.current.reference.setMeta((meta) => ({ ...meta, errorMap: { ...meta.errorMap, onServer: "Application server refusal" } })),
	)
	await act(async () => {
		await env.result.current.checkout
			.confirmAsync({ billingAddress: sources.checkout.billingAddress, paymentMethod: "bacs" })
			.catch(() => {})
	})
	expect(checkoutFormErrorMessages(env.result.current.reference.state.meta.errorMap.onServer)).toBe(
		"Application server refusal, Kit refusal",
	)
	act(() => env.result.current.checkout.reset())
	expect(env.result.current.reference.state.meta.errorMap.onServer).toBe("Application server refusal")
})

it("React Hook Form preserves newer unrelated errors on the same field when Kit clears", async () => {
	const { sources, wrapper } = setup()
	procedures.checkout.confirm.call.mockRejectedValue(
		validationFailure([validationIssue({ registeredFields: [{ id: plugin, bucket: "additionalFields" }], message: "Kit refusal" })]),
	)
	const env = renderHook(() => useRHFAdapter(), { wrapper })
	await waitFor(() => expect(env.result.current.fields.schema).not.toBeNull())
	act(() => env.result.current.form.setError(pluginName, { type: "application", message: "Application refusal" }))
	await act(async () => {
		await env.result.current.checkout
			.confirmAsync({ billingAddress: sources.checkout.billingAddress, paymentMethod: "bacs" })
			.catch(() => {})
	})
	expect(checkoutErrorMessages(env.result.current.form.getFieldState(pluginName).error)).toBe("Application refusal, Kit refusal")
	act(() => {
		const error = env.result.current.form.getFieldState(pluginName).error
		env.result.current.form.setError(pluginName, { ...error, type: "application", message: "Newer refusal" })
		env.result.current.checkout.reset()
	})
	expect(env.result.current.form.getFieldState(pluginName).error).toMatchObject({ type: "application", message: "Newer refusal" })
	expect(env.result.current.form.getFieldState(pluginName).error?.types?.kitServer).toBeUndefined()
})

it.each(["TanStack", "React Hook Form"] as const)(
	"%s preserves edits on query refresh and resets on acknowledged session replacement",
	async (library) => {
		const { sources, client, wrapper } = setup()
		if (library === "TanStack") {
			const env = renderHook(() => useTanStackAdapter(), { wrapper })
			await waitFor(() => expect(env.result.current.fields.schema).not.toBeNull())
			act(() => env.result.current.note.handleChange("unfinished"))
			act(() => client.setQueryData(checkoutQueryKey, { ...sources.checkout, customerNote: "server" }))
			expect(env.result.current.form.state.values.customerNote).toBe("unfinished")
			act(() =>
				client.setQueryData(checkoutQueryKey, { ...sources.checkout, orderId: 99, orderKey: "replacement", customerNote: "new session" }),
			)
			await waitFor(() => expect(env.result.current.form.state.values.customerNote).toBe("new session"))
			expect(env.result.current.note.state.meta.isDirty).toBe(false)
		} else {
			const env = renderHook(() => useRHFAdapter(), { wrapper })
			await waitFor(() => expect(env.result.current.fields.schema).not.toBeNull())
			act(() => env.result.current.bind(env.result.current.note.field).onValueChange("unfinished"))
			act(() => client.setQueryData(checkoutQueryKey, { ...sources.checkout, customerNote: "server" }))
			expect(env.result.current.form.getValues("customerNote")).toBe("unfinished")
			act(() =>
				client.setQueryData(checkoutQueryKey, { ...sources.checkout, orderId: 99, orderKey: "replacement", customerNote: "new session" }),
			)
			await waitFor(() => expect(env.result.current.form.getValues("customerNote")).toBe("new session"))
			expect(env.result.current.form.getFieldState("customerNote").isDirty).toBe(false)
		}
		expect(procedures.cart.update.call).not.toHaveBeenCalled()
	},
)

it.each(["TanStack", "React Hook Form"] as const)(
	"%s applies country dependencies without dirtying or validating cleared fields",
	async (library) => {
		const { wrapper } = setup()
		if (library === "TanStack") {
			const env = renderHook(() => useTanStackAdapter(), { wrapper })
			await waitFor(() => expect(env.result.current.fields.schema).not.toBeNull())
			act(() => env.result.current.country.handleChange("AE"))
			expect(env.result.current.form.state.values.shippingAddress).toMatchObject({ country: "AE", state: "", postcode: "" })
			expect(env.result.current.state.state.meta).toMatchObject({ isDirty: false, isTouched: false })
		} else {
			const env = renderHook(() => useRHFAdapter(), { wrapper })
			await waitFor(() => expect(env.result.current.fields.schema).not.toBeNull())
			act(() => env.result.current.bind(env.result.current.country.field).onValueChange("AE"))
			expect(env.result.current.form.getValues("shippingAddress")).toMatchObject({ country: "AE", state: "", postcode: "" })
			expect(env.result.current.form.getFieldState("shippingAddress.state")).toMatchObject({ isDirty: false, isTouched: false })
		}
		await waitFor(() => expect(procedures.cart.update.call).toHaveBeenCalledTimes(1))
	},
)

it("TanStack async validation does not erase a later blur while preserving programmatic metadata", async () => {
	let finish!: (value: undefined) => void
	const validation = new Promise<undefined>((resolve) => {
		finish = resolve
	})
	const env = renderHook(() => {
		const form = useTanStackForm({ defaultValues: { customerNote: "old" } as CheckoutFormValues })
		const note = useField({ form, name: "customerNote", validators: { onChangeAsync: () => validation } })
		return { form, note, binding: tanstackFormAdapter(form) }
	})
	let pending!: Promise<void>
	act(() => {
		pending = env.result.current.binding.setValues([
			{ name: "customerNote", value: "draft", options: { runListeners: false, meta: "preserve", validate: true } },
		])
	})
	expect(env.result.current.note.state.meta.isTouched).toBe(false)
	act(() => env.result.current.note.handleBlur())
	await act(async () => {
		finish(undefined)
		await pending
	})
	expect(env.result.current.note.state.meta).toMatchObject({ isDirty: false, isTouched: true, isBlurred: true })
})

it.each(["TanStack", "React Hook Form"] as const)(
	"%s preserves an edit made before initialization and supports silent prefill/native reset",
	async (library) => {
		const { sources, client, wrapper } = setup()
		let finish!: (checkout: typeof sources.checkout) => void
		procedures.checkout.get.call.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve
			}),
		)
		client.removeQueries({ queryKey: checkoutQueryKey })
		if (library === "TanStack") {
			const env = renderHook(() => useTanStackAdapter(), { wrapper })
			act(() => env.result.current.note.handleChange("early draft"))
			await act(async () => finish(sources.checkout))
			await waitFor(() => expect(env.result.current.fields.schema).not.toBeNull())
			expect(env.result.current.form.state.values.customerNote).toBe("early draft")
			expect(env.result.current.note.state.meta.isDirty).toBe(true)
			await act(async () => {
				await env.result.current.adapter.setValues([
					{ name: "customerNote", value: "prefill", options: { runListeners: false, meta: "preserve", validate: false } },
				])
				env.result.current.fields.reevaluate()
			})
			expect(env.result.current.form.state.values.customerNote).toBe("prefill")
			act(() => env.result.current.form.reset({ customerNote: "explicit reset", paymentMethod: "" }, { keepDefaultValues: true }))
			env.rerender()
			expect(env.result.current.form.state.values.customerNote).toBe("explicit reset")
			expect(env.result.current.fields.decode(env.result.current.form.state.values)).toEqual({
				customerNote: "explicit reset",
				paymentMethod: "",
			})
		} else {
			const env = renderHook(() => useRHFAdapter(), { wrapper })
			act(() => env.result.current.bind(env.result.current.note.field).onValueChange("early draft"))
			await act(async () => finish(sources.checkout))
			await waitFor(() => expect(env.result.current.fields.schema).not.toBeNull())
			expect(env.result.current.form.getValues("customerNote")).toBe("early draft")
			expect(env.result.current.form.getFieldState("customerNote").isDirty).toBe(true)
			await act(async () => {
				await env.result.current.adapter.setValues([
					{ name: "customerNote", value: "prefill", options: { runListeners: false, meta: "preserve", validate: false } },
				])
				env.result.current.fields.reevaluate()
			})
			expect(env.result.current.form.getValues("customerNote")).toBe("prefill")
			act(() => env.result.current.form.reset({ customerNote: "explicit reset", paymentMethod: "" }))
			env.rerender()
			expect(env.result.current.form.getValues("customerNote")).toBe("explicit reset")
			expect(env.result.current.fields.decode(env.result.current.form.getValues())).toMatchObject({
				customerNote: "explicit reset",
				paymentMethod: "",
			})
		}
		expect(procedures.cart.update.call).not.toHaveBeenCalled()
	},
)

it.each(["TanStack", "React Hook Form"] as const)(
	"%s does not save an invalid edit or stale async result, and flushes a valid edit on blur",
	async (library) => {
		const { wrapper } = setup()
		let finish!: () => void
		const pending = new Promise<void>((resolve) => {
			finish = resolve
		})
		const started = vi.fn()
		if (library === "TanStack") {
			const env = renderHook(
				() =>
					useTanStackAdapter(undefined, undefined, async (value) => {
						if (value === "560002") {
							started()
							await pending
						}
						return value === "560004" ? "Application rejection" : undefined
					}),
				{ wrapper },
			)
			await waitFor(() => expect(env.result.current.fields.schema).not.toBeNull())
			act(() => env.result.current.postcode.handleChange("560002"))
			await waitFor(() => expect(started).toHaveBeenCalled())
			act(() => env.result.current.postcode.handleChange("560004"))
			await act(async () => {
				finish()
				await pending
			})
			expect(procedures.cart.update.call).not.toHaveBeenCalled()
			act(() => env.result.current.postcode.handleChange("560003"))
			act(() => env.result.current.postcode.handleBlur())
		} else {
			const env = renderHook(
				() =>
					useRHFAdapter(async (values): Promise<ResolverResult<CheckoutFormValues>> => {
						if (values.shippingAddress?.postcode === "560002") {
							started()
							await pending
						}
						return values.shippingAddress?.postcode === "560004"
							? { values: {}, errors: { shippingAddress: { postcode: { type: "application", message: "Application rejection" } } } }
							: { values, errors: {} }
					}),
				{ wrapper },
			)
			await waitFor(() => expect(env.result.current.fields.schema).not.toBeNull())
			act(() => env.result.current.bind(env.result.current.postcode.field).onValueChange("560002"))
			await waitFor(() => expect(started).toHaveBeenCalled())
			act(() => env.result.current.bind(env.result.current.postcode.field).onValueChange("560004"))
			await act(async () => {
				finish()
				await pending
			})
			expect(procedures.cart.update.call).not.toHaveBeenCalled()
			act(() => env.result.current.bind(env.result.current.postcode.field).onValueChange("560003"))
			act(() => env.result.current.bind(env.result.current.postcode.field).onBlur?.())
		}
		await waitFor(() => expect(procedures.cart.update.call).toHaveBeenCalledTimes(1))
		expect(procedures.cart.update.call.mock.calls[0]?.[0].body.shippingAddress.postcode).toBe("560003")
	},
)

it("TanStack named validation includes form-level async errors without touching pristine fields", async () => {
	const env = renderHook(() => {
		const form = useTanStackForm({
			defaultValues: { shippingAddress: { postcode: "560004" } } as CheckoutFormValues,
			validators: {
				onChangeAsync: async ({ value }) =>
					value.shippingAddress?.postcode === "560004"
						? { fields: { "shippingAddress.postcode": "Application async rejection" } }
						: undefined,
			},
		})
		const postcode = useField({ form, name: "shippingAddress.postcode" })
		return { form, postcode, adapter: tanstackFormAdapter(form) }
	})
	let valid = true
	await act(async () => {
		valid = await env.result.current.adapter.validateField("shippingAddress.postcode")
	})
	expect(env.result.current.postcode.state.meta.errors).toContain("Application async rejection")
	expect(valid).toBe(false)
	expect(env.result.current.postcode.state.meta).toMatchObject({ isDirty: false, isTouched: false })
	await act(async () => {
		await env.result.current.adapter.setFieldValue("shippingAddress.postcode", "560003", {
			runListeners: false,
			meta: "preserve",
			validate: false,
		})
		valid = await env.result.current.adapter.validateField("shippingAddress.postcode")
	})
	expect(valid).toBe(true)
	expect(env.result.current.postcode.state.meta.errors).toEqual([])
	expect(env.result.current.postcode.state.meta).toMatchObject({ isDirty: false, isTouched: false })
})

it("TanStack form-level async rejection prevents an address save and a correction saves once", async () => {
	const { wrapper } = setup()
	const env = renderHook(
		() =>
			useTanStackAdapter(undefined, undefined, undefined, async (values) =>
				values.shippingAddress?.postcode === "560004"
					? { fields: { "shippingAddress.postcode": "Application async rejection" } }
					: undefined,
			),
		{ wrapper },
	)
	await waitFor(() => expect(env.result.current.fields.schema).not.toBeNull())
	vi.useFakeTimers()
	act(() => env.result.current.postcode.handleChange("560004"))
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1600)
	})
	expect(env.result.current.postcode.state.meta.errors).toContain("Application async rejection")
	expect(procedures.cart.update.call).not.toHaveBeenCalled()
	act(() => env.result.current.postcode.handleChange("560003"))
	act(() => env.result.current.postcode.handleBlur())
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1600)
	})
	expect(env.result.current.postcode.state.meta.errors).toEqual([])
	expect(procedures.cart.update.call).toHaveBeenCalledTimes(1)
	expect(procedures.cart.update.call.mock.calls[0]?.[0].body.shippingAddress.postcode).toBe("560003")
})

it.each(["manual", "resolver"] as const)("React Hook Form clears Kit text from a message-less %s error", async (source) => {
	const { sources, wrapper } = setup()
	const resolver: Resolver<CheckoutFormValues> | undefined =
		source === "resolver" ? async () => ({ values: {}, errors: { customerNote: { type: "application" } } }) : undefined
	const env = renderHook(() => useRHFAdapter(resolver), { wrapper })
	await waitFor(() => expect(env.result.current.fields.schema).not.toBeNull())
	if (source === "manual") act(() => env.result.current.form.setError("customerNote", { type: "application" }))
	else
		await act(async () => {
			await env.result.current.form.trigger("customerNote")
		})
	const original = env.result.current.form.getFieldState("customerNote")
	const value = env.result.current.form.getValues("customerNote")
	expect(original.error).toMatchObject({ type: "application" })
	expect(original.error?.message).toBeUndefined()
	procedures.checkout.confirm.call.mockRejectedValue(
		validationFailure([validationIssue({ scope: "field", target: ["customerNote"], message: "Kit refusal" })]),
	)
	await act(async () => {
		await env.result.current.checkout
			.confirmAsync({ billingAddress: sources.checkout.billingAddress, paymentMethod: "bacs" })
			.catch(() => {})
		if (source === "resolver") await env.result.current.form.trigger("customerNote")
	})
	expect(checkoutErrorMessages(env.result.current.form.getFieldState("customerNote").error)).toBe("Kit refusal")
	act(() => env.result.current.checkout.reset())
	const cleared = env.result.current.form.getFieldState("customerNote")
	expect(cleared.error?.type).toBe("application")
	expect(cleared.error?.message).toBeUndefined()
	expect(cleared.error?.types?.kitServer).toBeUndefined()
	expect(checkoutErrorMessages(cleared.error)).toBe("")
	expect(cleared).toMatchObject({ isDirty: original.isDirty, isTouched: original.isTouched })
	expect(env.result.current.form.getValues("customerNote")).toBe(value)
})

it("React Hook Form cannot resurrect cleared Kit errors after asynchronous adapter validation", async () => {
	const { sources, wrapper } = setup()
	let finish!: () => void
	const pending = new Promise<void>((resolve) => {
		finish = resolve
	})
	const started = vi.fn()
	const env = renderHook(
		() =>
			useRHFAdapter(async (values): Promise<ResolverResult<CheckoutFormValues>> => {
				started()
				await pending
				return { values, errors: {} }
			}),
		{ wrapper },
	)
	await waitFor(() => expect(env.result.current.fields.schema).not.toBeNull())
	procedures.checkout.confirm.call.mockRejectedValue(
		validationFailure([validationIssue({ registeredFields: [{ id: plugin, bucket: "additionalFields" }], message: "old refusal" })]),
	)
	await act(async () => {
		await env.result.current.checkout
			.confirmAsync({ billingAddress: sources.checkout.billingAddress, paymentMethod: "bacs" })
			.catch(() => {})
	})
	let validating!: Promise<boolean>
	act(() => {
		validating = env.result.current.form.trigger(pluginName)
	})
	await waitFor(() => expect(started).toHaveBeenCalled())
	act(() => env.result.current.checkout.reset())
	await act(async () => {
		finish()
		await validating
	})
	expect(env.result.current.form.getFieldState(pluginName).error).toBeUndefined()
})

it.each(["TanStack", "React Hook Form"] as const)("%s keeps fresh client validation when Kit errors clear", async (library) => {
	const { sources, wrapper } = setup()
	procedures.checkout.confirm.call.mockRejectedValue(
		validationFailure([validationIssue({ scope: "field", target: ["shippingAddress", "postcode"], message: "Kit refusal" })]),
	)
	if (library === "TanStack") {
		const env = renderHook(() => useTanStackAdapter(undefined, () => "Client refusal"), { wrapper })
		await waitFor(() => expect(env.result.current.fields.schema).not.toBeNull())
		await act(async () => {
			await env.result.current.checkout
				.confirmAsync({ billingAddress: sources.checkout.billingAddress, paymentMethod: "bacs" })
				.catch(() => {})
			await env.result.current.form.validateField("shippingAddress.postcode", "change")
		})
		expect(checkoutFormErrorMessages(env.result.current.postcode.state.meta.errors)).toContain("Client refusal")
		expect(checkoutFormErrorMessages(env.result.current.postcode.state.meta.errors)).toContain("Kit refusal")
		const metadata = env.result.current.postcode.state.meta
		act(() => env.result.current.checkout.reset())
		expect(checkoutFormErrorMessages(env.result.current.postcode.state.meta.errors)).toBe("Client refusal")
		expect(env.result.current.postcode.state.meta).toMatchObject({ isTouched: metadata.isTouched, isDirty: metadata.isDirty })
	} else {
		const env = renderHook(
			() =>
				useRHFAdapter(
					async (): Promise<ResolverResult<CheckoutFormValues>> => ({
						values: {},
						errors: { shippingAddress: { postcode: { type: "application", message: "Client refusal" } } },
					}),
				),
			{ wrapper },
		)
		await waitFor(() => expect(env.result.current.fields.schema).not.toBeNull())
		await act(async () => {
			await env.result.current.checkout
				.confirmAsync({ billingAddress: sources.checkout.billingAddress, paymentMethod: "bacs" })
				.catch(() => {})
			await env.result.current.form.trigger("shippingAddress.postcode")
		})
		expect(checkoutErrorMessages(env.result.current.postcode.fieldState.error)).toContain("Client refusal")
		expect(checkoutErrorMessages(env.result.current.postcode.fieldState.error)).toContain("Kit refusal")
		const metadata = env.result.current.postcode.fieldState
		act(() => env.result.current.checkout.reset())
		expect(checkoutErrorMessages(env.result.current.postcode.fieldState.error)).toBe("Client refusal")
		expect(env.result.current.postcode.fieldState).toMatchObject({ isTouched: metadata.isTouched, isDirty: metadata.isDirty })
	}
})

it.each(["TanStack", "React Hook Form"] as const)("%s remounts from cached defaults without persisting a second draft", async (library) => {
	const { wrapper } = setup()
	const mount = () =>
		library === "TanStack" ? renderHook(() => useTanStackAdapter(), { wrapper }) : renderHook(() => useRHFAdapter(), { wrapper })
	const first = mount()
	await waitFor(() => expect(first.result.current.fields.defaultValues).not.toBeNull())
	const initial = first.result.current.adapter.getFieldValue("customerNote")
	await act(async () => {
		await first.result.current.adapter.setFieldValue("customerNote", "unfinished")
	})
	expect(first.result.current.adapter.getFieldValue("customerNote")).toBe("unfinished")
	first.unmount()
	const second = mount()
	await waitFor(() => expect(second.result.current.fields.defaultValues).not.toBeNull())
	expect(second.result.current.adapter.getFieldValue("customerNote")).toBe(initial)
	expect(procedures.cart.update.call).not.toHaveBeenCalled()
})

// These assertions protect the external dependency boundary, independent of the app harness.
it("TanStack factory has no native lifecycle side effects and retains its error channel across calls", () => {
	const env = renderHook(() => {
		const form = useTanStackForm({ defaultValues: { customerNote: "owned draft" } as CheckoutFormValues })
		useField({ form, name: "customerNote" })
		return form
	})
	const form = env.result.current
	const reset = vi.spyOn(form, "reset")
	const update = vi.spyOn(form, "update")
	const write = vi.spyOn(form, "setFieldValue")
	const submit = vi.spyOn(form, "handleSubmit")
	const subscribe = vi.spyOn(form.store, "subscribe")
	const adapter = tanstackFormAdapter(form)
	expect(tanstackFormAdapter(form)).toBe(adapter)
	for (const spy of [reset, update, write, submit, subscribe]) expect(spy).not.toHaveBeenCalled()
	expect(adapter.getValues().customerNote).toBe("owned draft")
	act(() => adapter.setErrors([{ name: "customerNote", messages: ["Kit refusal"] }]))
	expect(subscribe).toHaveBeenCalledTimes(1)
	const stop = vi.spyOn(subscribe.mock.results[0]?.value, "unsubscribe")
	act(() => tanstackFormAdapter(form).clearErrors(["customerNote"]))
	expect(form.getFieldMeta("customerNote")?.errorMap.onServer).toBeUndefined()
	expect(stop).toHaveBeenCalledTimes(1)
})

it("React Hook Form factory has no native lifecycle side effects and shares errors across listener options", async () => {
	const env = renderHook(() => useReactHookForm<CheckoutFormValues>({ defaultValues: { customerNote: "owned draft" } }))
	const form = env.result.current
	const reset = vi.spyOn(form, "reset")
	const write = vi.spyOn(form, "setValue")
	const trigger = vi.spyOn(form, "trigger")
	const subscribe = vi.spyOn(form, "subscribe")
	const submit = vi.spyOn(form, "handleSubmit")
	const first = reactHookFormAdapter(form)
	expect(reactHookFormAdapter(form)).toBe(first)
	const listener = vi.fn()
	const second = reactHookFormAdapter(form, { onChange: listener })
	for (const spy of [reset, write, trigger, subscribe, submit]) expect(spy).not.toHaveBeenCalled()
	act(() => first.setErrors([{ name: "customerNote", messages: ["Kit refusal"] }]))
	const native: Resolver<CheckoutFormValues> = (values) => ({ values, errors: {} })
	const result = await second.withResolver(native)({ customerNote: "draft" }, undefined, { fields: {}, shouldUseNativeValidation: false })
	expect(result.errors.customerNote?.types?.kitServer).toEqual(["Kit refusal"])
	act(() => second.clearErrors(["customerNote"]))
	expect(form.getFieldState("customerNote").error).toBeUndefined()
	expect(first.getValues().customerNote).toBe("owned draft")
	expect(listener).not.toHaveBeenCalled()
})
