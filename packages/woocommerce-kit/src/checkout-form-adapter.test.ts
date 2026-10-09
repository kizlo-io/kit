import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, it } from "vitest"

describe("optional checkout adapter dependency boundaries", () => {
	it.each([
		["core", "@kizlo/woocommerce-kit", []],
		["generic fields", "@kizlo/woocommerce-kit/react/checkout-fields", []],
		["TanStack", "@kizlo/woocommerce-kit/react/checkout-fields/tanstack-form", ["@tanstack/react-form"]],
		["React Hook Form", "@kizlo/woocommerce-kit/react/checkout-fields/react-hook-form", ["react-hook-form", "@hookform/resolvers"]],
	] as const)("%s typechecks when unused form libraries cannot resolve", (_name, entry, allowed) => {
		const packagePath = fileURLToPath(new URL("../", import.meta.url))
		const configPath = path.join(packagePath, "tsconfig.json")
		const config = ts.readConfigFile(configPath, ts.sys.readFile)
		const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, packagePath, undefined, configPath)
		const options = { ...parsed.options, incremental: false, tsBuildInfoFile: undefined, noEmit: true }
		const file = path.join(packagePath, "test-fixtures/optional-form-consumer.ts")
		const factory = entry.endsWith("tanstack-form")
			? "tanstackFormAdapter"
			: entry.endsWith("react-hook-form")
				? "reactHookFormAdapter"
				: "useCheckoutFields"
		const content = entry.endsWith("kit")
			? `export type { CheckoutFormValues } from "${entry}"`
			: `import { ${factory} } from "${entry}"; export type Fields = ReturnType<typeof ${factory}>`
		const host = ts.createCompilerHost(options)
		const getSourceFile = host.getSourceFile.bind(host)
		host.getSourceFile = (name, ...args) => (name === file ? ts.createSourceFile(name, content, args[0]) : getSourceFile(name, ...args))
		const blocked: string[] = []
		const optional = ["@tanstack/react-form", "react-hook-form", "@hookform/resolvers"]
		host.resolveModuleNames = (names, containingFile) =>
			names.map((name) => {
				const peer = optional.find((peer) => name === peer || name.startsWith(`${peer}/`))
				if (peer && !(allowed as readonly string[]).includes(peer)) {
					blocked.push(name)
					return undefined
				}
				return ts.resolveModuleName(name, containingFile, options, host).resolvedModule
			})
		const program = ts.createProgram([file, path.join(packagePath, "types/registry.ts")], options, host)
		expect(blocked).toEqual([])
		expect(
			[...parsed.errors, ...ts.getPreEmitDiagnostics(program)].map((diagnostic) =>
				ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
			),
		).toEqual([])
	})
})
