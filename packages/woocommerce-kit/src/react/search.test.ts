// @vitest-environment happy-dom

import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useProductSearch } from "./search"

const { useQuery } = vi.hoisted(() => ({
	useQuery: vi.fn((_options: { queryKey: readonly [unknown, unknown, unknown, { query: string }] }) => ({
		data: undefined,
		dataUpdatedAt: 0,
		error: null,
		errorUpdatedAt: 0,
		fetchStatus: "idle",
		isError: false,
		isFetching: false,
		isPending: false,
		isPlaceholderData: false,
		status: "pending",
	})),
}))

vi.mock("@tanstack/react-query", () => ({
	isServer: false,
	keepPreviousData: Symbol("keepPreviousData"),
	skipToken: Symbol("skipToken"),
	useQuery,
}))

vi.mock("kizlo/react", () => ({
	useKizloContext: () => ({
		client: {
			woocommerce: {
				products: { list: { call: vi.fn() } },
			},
		},
	}),
}))

afterEach(() => {
	vi.clearAllMocks()
	vi.useRealTimers()
})

describe("useProductSearch debounce", () => {
	it("settles a burst to one term", () => {
		vi.useFakeTimers()
		const onQueryChange = vi.fn()
		const { result } = renderHook(() => useProductSearch({ collectionPath: "/collections", debounceMs: 100, onQueryChange }))

		act(() => result.current.setQuery("t"))

		expect(onQueryChange).toHaveBeenCalledWith("t")
		expect(result.current.debouncedQuery).toBe("")

		act(() => {
			result.current.setQuery("to")
			result.current.setQuery("tote")
		})

		expect(result.current.query).toBe("tote")
		expect(result.current.debouncedQuery).toBe("")

		act(() => vi.advanceTimersByTime(100))

		expect(result.current.debouncedQuery).toBe("tote")
		expect(useQuery.mock.calls.filter(([options]) => options.queryKey[3].query === "tote")).toHaveLength(1)
	})

	it("clears immediately without a trailing update", () => {
		vi.useFakeTimers()
		const { result } = renderHook(() => useProductSearch({ collectionPath: "/collections", debounceMs: 100 }))

		act(() => {
			result.current.setQuery("tote")
			vi.advanceTimersByTime(100)
		})
		expect(result.current.debouncedQuery).toBe("tote")

		act(() => {
			result.current.setQuery("bag")
			result.current.clear()
		})

		expect(result.current.query).toBe("")
		expect(result.current.debouncedQuery).toBe("")

		act(() => vi.advanceTimersByTime(100))

		expect(result.current.debouncedQuery).toBe("")
	})

	it("does not update after unmounting mid-wait", () => {
		vi.useFakeTimers()
		const { result, unmount } = renderHook(() => useProductSearch({ collectionPath: "/collections", debounceMs: 100 }))

		act(() => result.current.setQuery("tote"))
		const rendersBeforeUnmount = useQuery.mock.calls.length
		unmount()

		act(() => vi.advanceTimersByTime(100))

		expect(useQuery).toHaveBeenCalledTimes(rendersBeforeUnmount)
	})
})
