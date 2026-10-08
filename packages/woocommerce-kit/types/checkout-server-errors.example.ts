import type { CheckoutFormFieldName, CheckoutFormValues, CheckoutServerErrorCallbacks } from "@kizlo/woocommerce-kit/react/checkout-fields"
import type { AnyFormApi } from "@tanstack/react-form"
import { type FieldError, get, type Resolver, set, type UseFormReturn } from "react-hook-form"

export function tanStackValidateField(form: AnyFormApi, name: CheckoutFormFieldName): Promise<boolean> {
	const touched = form.getFieldMeta(name)?.isTouched ?? false
	const result = form.validateField(name, "change")
	// validateField touches synchronously. Restore now so async completion cannot erase a later blur.
	if (!touched) form.setFieldMeta(name, (meta) => ({ ...meta, isTouched: false }))
	return Promise.resolve(result).then((errors) => errors.length === 0)
}

function withServerMessages(client: FieldError | undefined, messages: readonly string[]): FieldError {
	return {
		...client,
		type: client?.type ?? "kitServer",
		message: client?.message ?? messages.join(", "),
		types: { ...client?.types, kitServer: [...messages] },
	}
}

/** React Hook Form has one field error object; reserve a named entry for Kit and restore the client channel on clear. */
export function reactHookFormServerErrors(
	getForm: () => UseFormReturn<CheckoutFormValues>,
): CheckoutServerErrorCallbacks & { withResolver: (resolver: Resolver<CheckoutFormValues>) => Resolver<CheckoutFormValues> } {
	const clientErrors = new Map<CheckoutFormFieldName, FieldError | undefined>()
	const serverErrors = new Map<CheckoutFormFieldName, readonly string[]>()
	return {
		setErrors(patches) {
			const form = getForm()
			for (const { name, messages } of patches) {
				const current = form.getFieldState(name).error
				const client = current?.types?.kitServer ? clientErrors.get(name) : current
				clientErrors.set(name, client)
				serverErrors.set(name, messages)
				form.setError(name, withServerMessages(client, messages))
			}
		},
		clearErrors(names) {
			const form = getForm()
			for (const name of names) {
				serverErrors.delete(name)
				// Validation may have replaced the server channel with a newer client error.
				if (form.getFieldState(name).error?.types?.kitServer) {
					const client = clientErrors.get(name)
					if (client) form.setError(name, client)
					else form.clearErrors(name)
				}
				clientErrors.delete(name)
			}
		},
		withResolver: (resolver) => async (values, context, options) => {
			const result = await resolver(values, context, options)
			const errors = { ...result.errors }
			// Read the active patches after validation settles so edits/reset cannot resurrect an old server channel.
			for (const [name, messages] of serverErrors) {
				const client: FieldError | undefined = get(result.errors, name)
				clientErrors.set(name, client)
				// Copy nested branches before adding Kit's channel to the resolver's client-only result.
				const segments = name.split(".")
				for (let index = 1; index < segments.length; index++) {
					const path = segments.slice(0, index).join(".")
					const branch = get(errors, path)
					set(errors, path, Array.isArray(branch) ? [...branch] : { ...branch })
				}
				set(errors, name, withServerMessages(client, messages))
			}
			return Object.keys(errors).length ? { values: {}, errors } : result
		},
	}
}

export function reactHookFormErrorMessages(error: FieldError | undefined): string {
	if (!error) return ""
	const server = Array.isArray(error.types?.kitServer) ? error.types.kitServer : []
	return [error.type !== "kitServer" ? error.message : undefined, ...server].filter(Boolean).join(", ")
}
