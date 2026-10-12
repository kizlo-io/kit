"use client"

import { useCallback, useEffect, useInsertionEffect, useRef, useState } from "react"

export type IntersectionOptions = IntersectionObserverInit & {
	scrollMargin?: string
	trackVisibility?: boolean
	delay?: number
	triggerOnce?: boolean
	skip?: boolean
	initialInView?: boolean
	fallbackInView?: boolean
	onChange?: (inView: boolean, entry: IntersectionObserverEntry) => void
}
export type InViewHookResponse = [(node?: Element | null) => void, boolean, IntersectionObserverEntry | undefined] & {
	ref: (node?: Element | null) => void
	inView: boolean
	entry?: IntersectionObserverEntry
}

/** Browser visibility without query or URL-state dependencies. */
export function useInView({
	root,
	rootMargin,
	scrollMargin,
	threshold,
	trackVisibility,
	delay,
	triggerOnce,
	skip,
	initialInView,
	fallbackInView,
	onChange,
}: IntersectionOptions = {}): InViewHookResponse {
	const [element, setElement] = useState<Element | null>(null)
	const [state, setState] = useState<{ inView: boolean; entry?: IntersectionObserverEntry }>({ inView: !!initialInView })
	const callback = useRef(onChange)
	useInsertionEffect(() => {
		callback.current = onChange
	}, [onChange])
	const previous = useRef(initialInView)
	const ref = useCallback(
		(node?: Element | null) => {
			setElement(node ?? null)
			if (!node && !triggerOnce && !skip) {
				previous.current = initialInView
				setState({ inView: !!initialInView })
			}
		},
		[initialInView, triggerOnce, skip],
	)
	const fallbackRatio = Array.isArray(threshold) ? 0 : (threshold ?? 0)
	const thresholds = Array.isArray(threshold) ? threshold.join(",") : String(threshold ?? 0)

	useEffect(() => {
		if (!element || skip) return
		let active = true
		let observer: IntersectionObserver | undefined
		function change(inView: boolean, entry: IntersectionObserverEntry) {
			if (!active) return
			const before = previous.current
			previous.current = inView
			if (before === undefined && !inView) return
			if (trackVisibility && !("isVisible" in entry)) Object.assign(entry, { isVisible: inView })
			if (inView && triggerOnce) {
				observer?.disconnect()
				active = false
			}
			setState({ inView, entry })
			callback.current?.(inView, entry)
		}
		if (typeof IntersectionObserver === "undefined") {
			if (fallbackInView === undefined) throw new Error("IntersectionObserver is unavailable; supply fallbackInView or a polyfill.")
			const bounds = element.getBoundingClientRect()
			change(fallbackInView, {
				target: element,
				isIntersecting: fallbackInView,
				intersectionRatio: fallbackRatio,
				boundingClientRect: bounds,
				intersectionRect: bounds,
				rootBounds: bounds,
				time: 0,
			})
		} else {
			const values = thresholds.split(",").map(Number)
			observer = new IntersectionObserver(
				(entries) => {
					for (const entry of entries) {
						if (entry.target === element) change(entry.isIntersecting && values.some((value) => entry.intersectionRatio >= value), entry)
					}
				},
				{ root, rootMargin, scrollMargin, threshold: values, trackVisibility, delay } as IntersectionObserverInit,
			)
			observer.observe(element)
		}
		return () => {
			active = false
			observer?.disconnect()
		}
	}, [element, skip, triggerOnce, root, rootMargin, scrollMargin, thresholds, trackVisibility, delay, fallbackInView, fallbackRatio])
	return Object.assign([ref, state.inView, state.entry] as InViewHookResponse, { ref, ...state })
}
