// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react"
import { createElement } from "react"
import { renderToString } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type IntersectionOptions, useInView } from "./in-view"

const observers: {
	notify: (entries: IntersectionObserverEntry[]) => void
	observe: ReturnType<typeof vi.fn>
	disconnect: ReturnType<typeof vi.fn>
	options: IntersectionObserverInit
}[] = []
function entry(target: Element, visible = true, ratio = visible ? 1 : 0): IntersectionObserverEntry {
	return { target, isIntersecting: visible, intersectionRatio: ratio } as IntersectionObserverEntry
}
beforeEach(() => {
	observers.length = 0
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe = vi.fn()
			disconnect = vi.fn()
			notify: (entries: IntersectionObserverEntry[]) => void
			options: IntersectionObserverInit
			constructor(notify: (entries: IntersectionObserverEntry[]) => void, options: IntersectionObserverInit) {
				this.notify = notify
				this.options = options
				observers.push(this)
			}
		},
	)
})
afterEach(() => {
	cleanup()
	vi.unstubAllGlobals()
})

function mount(options: IntersectionOptions = {}) {
	const target = document.createElement("div")
	const hook = renderHook((props: IntersectionOptions) => useInView(props), { initialProps: options })
	act(() => hook.result.current.ref(target))
	return { ...hook, target, fire: (visible = true, ratio?: number) => act(() => observers.at(-1)?.notify([entry(target, visible, ratio)])) }
}
describe("useInView", () => {
	it("supports tuple/object forms, ignores the initial false notification, and applies thresholds", () => {
		const onChange = vi.fn()
		const hook = mount({ threshold: [0.5, 0.8], onChange })
		expect(hook.result.current[0]).toBe(hook.result.current.ref)
		hook.fire(false)
		expect(onChange).not.toHaveBeenCalled()
		hook.fire(true, 0.3)
		expect(hook.result.current.inView).toBe(false)
		hook.fire(true, 0.7)
		expect(hook.result.current[1]).toBe(true)
		expect(hook.result.current[2]).toBe(hook.result.current.entry)
		expect(onChange).toHaveBeenLastCalledWith(true, expect.objectContaining({ target: hook.target }))
		hook.fire(false)
		expect(hook.result.current.inView).toBe(false)
	})
	it("uses current callbacks without restarting an unchanged observer", () => {
		const first = vi.fn(),
			second = vi.fn()
		const hook = mount({ onChange: first })
		hook.rerender({ onChange: second })
		hook.fire()
		expect(first).not.toHaveBeenCalled()
		expect(second).toHaveBeenCalledTimes(1)
		expect(observers).toHaveLength(1)
	})
	it("forwards options, cleans up option/ref changes, skips and resumes", () => {
		const root = document.createElement("div")
		const hook = mount({ root, rootMargin: "200px", scrollMargin: "10px", threshold: [0, 0.5], delay: 100, trackVisibility: true })
		expect(observers[0]?.options).toMatchObject({
			root,
			rootMargin: "200px",
			scrollMargin: "10px",
			threshold: [0, 0.5],
			delay: 100,
			trackVisibility: true,
		})
		hook.fire()
		expect(hook.result.current.entry).toHaveProperty("isVisible", true)
		hook.rerender({ rootMargin: "20px" })
		expect(observers[0]?.disconnect).toHaveBeenCalledTimes(1)
		const replacement = document.createElement("span")
		act(() => hook.result.current.ref(replacement))
		expect(observers[1]?.disconnect).toHaveBeenCalledTimes(1)
		expect(observers[2]?.observe).toHaveBeenCalledWith(replacement)
		hook.rerender({ skip: true })
		expect(observers[2]?.disconnect).toHaveBeenCalledTimes(1)
		hook.rerender({ skip: false })
		expect(observers).toHaveLength(4)
		hook.unmount()
		expect(observers[3]?.disconnect).toHaveBeenCalledTimes(1)
		act(() => observers[3]?.notify([entry(replacement)]))
	})
	it("honors explicit initial state, triggerOnce and detach resets", () => {
		const onChange = vi.fn()
		const hook = mount({ initialInView: false, triggerOnce: true, onChange })
		hook.fire(false)
		expect(onChange).toHaveBeenCalledWith(false, expect.anything())
		hook.fire()
		hook.fire(false)
		expect(hook.result.current.inView).toBe(true)
		expect(onChange).toHaveBeenCalledTimes(2)
		expect(observers[0]?.disconnect).toHaveBeenCalledTimes(1)
		const reset = mount()
		reset.fire()
		act(() => reset.result.current.ref(null))
		expect(reset.result.current.inView).toBe(false)
		expect(reset.result.current.entry).toBeUndefined()
	})
	it("observes a replacement element after triggerOnce fires", () => {
		const hook = mount({ triggerOnce: true })
		hook.fire()
		act(() => hook.result.current.ref(null))
		expect(hook.result.current.inView).toBe(true)
		const replacement = document.createElement("span")
		act(() => hook.result.current.ref(replacement))
		expect(observers[1]?.observe).toHaveBeenCalledWith(replacement)
		act(() => observers[1]?.notify([entry(replacement, false)]))
		expect(hook.result.current.inView).toBe(false)
	})
	it("restarts observation when options change after triggerOnce fires", () => {
		const hook = mount({ triggerOnce: true })
		hook.fire()
		hook.rerender({ triggerOnce: true, rootMargin: "20px" })
		expect(observers[1]?.observe).toHaveBeenCalledWith(hook.target)
		hook.fire(false)
		expect(hook.result.current.inView).toBe(false)
	})
	it.each([
		{ triggerOnce: false, skip: false },
		{ triggerOnce: true, skip: false },
		{ triggerOnce: false, skip: true },
	])("uses current triggerOnce/skip options when detaching (%j)", (options) => {
		const hook = mount({ triggerOnce: true })
		hook.fire()
		hook.rerender(options)
		act(() => hook.result.current.ref(null))
		expect(hook.result.current.inView).toBe(options.triggerOnce || options.skip)
		if (!options.triggerOnce && !options.skip) expect(hook.result.current.entry).toBeUndefined()
		else expect(hook.result.current.entry?.target).toBe(hook.target)
	})
	it("supports fallback behavior without an observer and keeps SSR inert", () => {
		vi.stubGlobal("IntersectionObserver", undefined)
		const hook = mount({ fallbackInView: true, threshold: 0.5 })
		expect(hook.result.current.inView).toBe(true)
		expect(hook.result.current.entry).toMatchObject({ target: hook.target, intersectionRatio: 0.5 })
		function Server() {
			const { inView } = useInView({ initialInView: true })
			return createElement("output", null, String(inView))
		}
		expect(renderToString(createElement(Server))).toContain("true")
		expect(observers).toHaveLength(0)
	})
})
