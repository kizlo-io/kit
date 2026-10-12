import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, it } from "vitest"

const packagePath = fileURLToPath(new URL("../", import.meta.url))
function compilerOptions() {
	const configPath = path.join(packagePath, "tsconfig.json")
	const config = ts.readConfigFile(configPath, ts.sys.readFile)
	return {
		...ts.parseJsonConfigFileContent(config.config, ts.sys, packagePath, undefined, configPath).options,
		incremental: false,
		tsBuildInfoFile: undefined,
		noEmit: true,
	}
}
function errors(program: ts.Program) {
	return ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))
}
it("preserves custom registered product fields through collection inference", () => {
	const program = ts.createProgram([path.join(packagePath, "test-fixtures/collection-consumer.ts")], compilerOptions())
	expect(errors(program)).toEqual([])
}, 10_000)
describe("collection optional peers", () => {
	it.each([
		["core", "@kizlo/woocommerce-kit", "export type { CollectionModel }", ["nuqs", "@tanstack/react-query"]],
		["server navigation", "@kizlo/woocommerce-kit/react/server", "export { ProductCollection }", ["@tanstack/react-query"]],
		["visibility hook", "@kizlo/woocommerce-kit/react/in-view", "export { useInView }", ["nuqs", "@tanstack/react-query"]],
	] as const)("%s requires only its own peers", (_name, entry, prefix, unavailable) => {
		const options = compilerOptions()
		const file = path.join(packagePath, "test-fixtures/optional-collection-consumer.ts")
		const host = ts.createCompilerHost(options)
		const getSourceFile = host.getSourceFile.bind(host)
		host.getSourceFile = (name, ...args) =>
			name === file ? ts.createSourceFile(name, `${prefix} from "${entry}"`, args[0]) : getSourceFile(name, ...args)
		const blocked: string[] = []
		host.resolveModuleNames = (names, containingFile) =>
			names.map((name) => {
				if (unavailable.some((peer) => name === peer || name.startsWith(`${peer}/`))) {
					blocked.push(name)
					return undefined
				}
				return ts.resolveModuleName(name, containingFile, options, host).resolvedModule
			})
		const program = ts.createProgram([file, path.join(packagePath, "types/registry.ts")], options, host)
		expect(blocked).toEqual([])
		expect(errors(program)).toEqual([])
	})
})
