import type { Storefront, StorefrontField } from "./types"

export function readPath(value: unknown, path: readonly string[]): unknown {
	for (const key of path) {
		if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined
		value = (value as Record<string, unknown>)[key]
	}
	return value
}

export function safeFieldPath(path: unknown): path is string[] {
	return (
		Array.isArray(path) &&
		path.length > 0 &&
		path.every((key) => typeof key === "string" && key.length > 0 && !["__proto__", "prototype", "constructor"].includes(key))
	)
}

export function fieldMetadata(
	definition: StorefrontField,
	group: "billing" | "shipping" | "other",
	values: unknown,
	countries: readonly Storefront["address"]["countries"][number][],
) {
	const country = countries.find((country) => country.code === readPath(values, ["country"]))
	const field = { ...definition, ...(definition.location === "address" ? country?.locale[definition.id] : {}) }
	let type = field.type ?? "text"
	let options = field.options ?? []
	if (field.id === "country" && field.location === "address") {
		type = "select"
		options = countries
			.filter((country) => (group === "billing" ? country.allowBilling : country.allowShipping))
			.map((country) => ({ value: country.code, label: country.name }))
	} else if (field.id === "state" && field.location === "address" && country) {
		type = country.states.length ? "select" : "text"
		options = country.states.map((state) => ({ value: state.code, label: state.name }))
	}
	return { ...field, type, options }
}
