// biome-ignore lint/correctness/noUnresolvedImports: Biome's resolver does not recognize Bun built-in modules.
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateWorkspace } from "../../src/workspace/policy.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("TypeScript source dependency fitness", () => {
  it("rejects a local SCC formed only by type-only declarations", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "packages/example/src/index.ts"),
      'import type { Other } from "./other.ts";\nexport type Value = Other;\n',
    );
    await writeFile(
      join(root, "packages/example/src/other.ts"),
      'export type { Value as Other } from "./index.ts";\n',
    );

    expect(await validateWorkspace(root)).toContainEqual({
      code: "source-module-cycle",
      path: "packages/example/src/index.ts",
      message: "source dependency SCC: src/index.ts <-> src/other.ts",
    });
  });

  it("enforces undeclared and private package type-only edges", async () => {
    const root = await fixture();
    await addPackage(root, "two", "@skizzles/two");
    const manifest = packageManifest("@skizzles/example");
    manifest.dependencies["@skizzles/two"] = "workspace:*";
    await writeManifest(root, "example", manifest);
    await writeFile(
      join(root, "packages/example/src/index.ts"),
      [
        'import { type Missing } from "unlisted-types";',
        'export type { Private } from "@skizzles/tw\\u006f/internal";',
        "export type Value = Missing;",
        "",
      ].join("\n"),
    );

    const codes = (await validateWorkspace(root)).map(({ code }) => code);
    expect(codes).toContain("undeclared-dependency");
    expect(codes).toContain("private-package-import");
  });

  it("preserves same-line declarations after every supported division context", async () => {
    const root = await fixture();
    await addPackage(root, "two", "@skizzles/two");
    const manifest = packageManifest("@skizzles/example");
    manifest.dependencies["@skizzles/two"] = "workspace:*";
    await writeManifest(root, "example", manifest);
    const divisionContexts = [
      "0 / 2;",
      ".5 / 2;",
      "1_000 / 2;",
      "0xff / 2;",
      "1e3 / 2;",
      "value! / 2;",
      "value as Box<number> / 2;",
      "value satisfies Box<number> / 2;",
      "fn<number> / 2;",
      "nested as Box<Map<string, number>> / 2;",
      "value++ / 2;",
      "value-- / 2;",
      "++value / 2;",
      "--value / 2;",
      "value++\n/ 2;",
      "value?.prop / 2;",
      "value?.[0] / 2;",
      "value?.() / 2;",
      "value?.prop! / 2;",
      "`value ${1 / 2}`;",
      "`value ${1\t/\t2}`;",
      "`value ${1 /* before */ / /* after */ 2}`;",
      "`value ${1\n/ 2}`;",
      "fn() / 2;",
      "(value) / 2;",
      "({ n: 4 }) / 2;",
      "(class {}) / 2;",
      "(function () {}) / 2;",
      "value\n/ 2;",
    ];
    const source = divisionContexts.map(
      (context, index) =>
        `${context} import type { Missing as Missing${index} } from "real-division-${index}";`,
    );
    source.push(
      'import type { Other } from "./other.ts";',
      'export type { Private } from "@skizzles/two/internal";',
      "export type Value = Other;",
      "",
    );
    await writeFile(
      join(root, "packages/example/src/index.ts"),
      source.join("\n"),
    );
    await writeFile(
      join(root, "packages/example/src/other.ts"),
      'export type { Value as Other } from "./index.ts";\n',
    );

    const findings = await validateWorkspace(root);
    expect(
      findings
        .filter(({ code }) => code === "undeclared-dependency")
        .map(({ message }) => message.split(" ")[0]),
    ).toEqual(
      divisionContexts
        .map((_, index) => `real-division-${index}`)
        .toSorted((left, right) => left.localeCompare(right)),
    );
    expect(findings).toContainEqual({
      code: "private-package-import",
      path: "packages/example/src/index.ts",
      message:
        "@skizzles/two/internal is not an exported surface of @skizzles/two",
    });
    expect(findings).toContainEqual({
      code: "source-module-cycle",
      path: "packages/example/src/index.ts",
      message: "source dependency SCC: src/index.ts <-> src/other.ts",
    });
  });

  it("keeps every supported regex context inert before a same-line declaration", async () => {
    const root = await fixture();
    const fakeRegex = (name: string): string =>
      `/import type \\{ Fake \\} from "${name}"/u`;
    const regexContexts = [
      `!${fakeRegex("fake-prefix")};`,
      `value > ${fakeRegex("fake-comparison")};`,
      `value + +${fakeRegex("fake-unary-plus")};`,
      `value - -${fakeRegex("fake-unary-minus")};`,
      `function sameLineReturn() { return ${fakeRegex("fake-return")}; }`,
      `function newlineReturn() { return\n${fakeRegex("fake-return-newline")}; }`,
      `const arrow = () => ${fakeRegex("fake-arrow")};`,
      `if (ok) ${fakeRegex("fake-if")};`,
      `while (ok) ${fakeRegex("fake-while")};`,
      `for (;;) ${fakeRegex("fake-for")};`,
      `if (ok) {} ${fakeRegex("fake-block")};`,
      `class RegexClass {} ${fakeRegex("fake-class")};`,
      `const frozen = { value: 1 } as const; ${fakeRegex("fake-as-const")};`,
      `interface RegexInterface { value: string } ${fakeRegex("fake-interface")};`,
      `@decorator class Decorated {} ${fakeRegex("fake-decorator")};`,
      `while (ok) { break\n${fakeRegex("fake-break")}; }`,
      `while (ok) { continue\n${fakeRegex("fake-continue")}; }`,
      'const complex = /[a/\\]]+\\/import type \\{ Fake \\} from "fake-complex"/giu;',
    ];
    await writeFile(
      join(root, "packages/example/src/index.ts"),
      [
        ...regexContexts.map(
          (context, index) =>
            `${context} import type { Missing as RegexMissing${index} } from "real-regex-${index}";`,
        ),
        "export type Value = Missing;",
        "",
      ].join("\n"),
    );

    const findings = await validateWorkspace(root);
    expect(undeclaredDependencies(findings)).toEqual(
      regexContexts
        .map((_, index) => `real-regex-${index}`)
        .toSorted((left, right) => left.localeCompare(right)),
    );
    expect(
      findings.filter(({ code }) => code === "source-parse-error"),
    ).toEqual([]);
  });

  it("uses token history for control words and keyword-named members", async () => {
    const root = await fixture();
    const fakeRegex = '/import type \\{ Fake \\} from "fake-control"/u;';
    const contexts = [
      `if (ok) ${fakeRegex}`,
      "obj.if() / 2;",
      "obj.catch() / 2;",
      "obj.return / 2;",
      "obj?.return / 2;",
      "obj.new / 2;",
      'obj["return"] / 2;',
      "obj[Symbol.return] / 2;",
      "class PrivateMembers { #if() {} m() { this.#if() / 2; } }",
    ];
    await writeFile(
      join(root, "packages/example/src/index.ts"),
      [
        "declare const obj: any;",
        ...contexts.map(
          (context, index) =>
            `${context} import type { Missing as MemberMissing${index} } from "real-member-${index}";`,
        ),
        "export type Value = MemberMissing0;",
        "",
      ].join("\n"),
    );

    const findings = await validateWorkspace(root);
    expect(undeclaredDependencies(findings)).toEqual(
      contexts.map((_, index) => `real-member-${index}`),
    );
    expect(
      findings.filter(({ code }) => code === "source-parse-error"),
    ).toEqual([]);
  });

  it("binds nested class headers to their matching same-depth bodies", async () => {
    const root = await fixture();
    const declarations = [
      "class Class0 {}",
      "class Class1 extends Base {}",
      "class Class2 extends factory() {}",
      "class Class3 extends factory({}) {}",
      "class Class4 extends factory({ x: {} }) {}",
      "class Class5 extends factory(function () {}) {}",
      "class Class6 extends factory(() => {}) {}",
      "class Class7 extends (class {}) {}",
      "class Class8 extends class {} {}",
      "class Class9 extends factory<{ x: string }>({}) {}",
      "class Class10<T extends {}> {}",
      "class Class11 extends Mixin(Base) {}",
      ["class Class12 extends Mixin(", "factory({})) {}"].join(""),
    ];
    const classLines = declarations.map((declaration, index) => {
      const fake = `/import type \\{ Fake \\} from "fake-class-${index}"/u;`;
      return `${declaration} ${fake} import type { Missing as ClassMissing${index} } from "real-class-${index}";`;
    });
    const expressionLines = [
      'const ClassExpression = class extends factory({}) {} / 2; import type { Missing as ExpressionMissing } from "real-class-expression";',
      'const ClassExpressionRegex = class extends factory({}) {}; /import type \\{ Fake \\} from "fake-class-expression"/u; import type { Missing as ExpressionRegexMissing } from "real-class-expression-regex";',
    ];
    await writeFile(
      join(root, "packages/example/src/index.ts"),
      [
        "declare const Base: any;",
        "declare const factory: any;",
        "declare const Mixin: any;",
        ...classLines,
        ...expressionLines,
        "export type Value = ClassMissing0;",
        "",
      ].join("\n"),
    );

    const findings = await validateWorkspace(root);
    expect(undeclaredDependencies(findings)).toEqual(
      [
        ...declarations.map((_, index) => `real-class-${index}`),
        "real-class-expression",
        "real-class-expression-regex",
      ].toSorted((left, right) => left.localeCompare(right)),
    );
    expect(
      findings.filter(({ code }) => code === "source-parse-error"),
    ).toEqual([]);
  });

  it("accepts adjacent type declarations without scanning inert text", async () => {
    const root = await fixture();
    await addPackage(root, "two", "@skizzles/two");
    const manifest = packageManifest("@skizzles/example");
    manifest.dependencies["@skizzles/two"] = "workspace:*";
    await writeManifest(root, "example", manifest);
    await writeFile(
      join(root, "packages/example/src/types.ts"),
      "export type Local = string;\n",
    );
    await writeFile(
      join(root, "packages/example/src/index.ts"),
      [
        '// import type { Fake } from "comment-only";',
        '/* export type { Fake } from "block-comment-only"; */',
        '/** @type {import("jsdoc-only").Fake} */',
        "const text = 'export type { Fake } from \"string-only\";';",
        "const template = `outer $" +
          '{`import type { Fake } from "nested-template-only";`} export type { Fake } from "template-only";`;',
        'const pattern = /export type \\{ Fake \\} from "regex-only"/u;',
        'import type { Value } from "@skizzles/two";',
        'export type { Local } from "./types.ts";',
        "export type Public = Value;",
        "void text;",
        "void template;",
        "void pattern;",
        "",
      ].join("\n"),
    );

    const codes = (await validateWorkspace(root)).map(({ code }) => code);
    expect(codes).not.toContain("undeclared-dependency");
    expect(codes).not.toContain("private-package-import");
    expect(codes).not.toContain("source-module-cycle");
  });

  it("allows declared self-references and preserves dynamic import checks", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "packages/example/src/index.ts"),
      [
        'import type { Value as SelfValue } from "@skizzles/example";',
        'void import("unlisted-runtime");',
        'type Deferred = import("unlisted-type-query").Value;',
        'export type { Value as Hidden } from "@skizzles/example/internal";',
        "export type Value = SelfValue;",
        "export type DeferredValue = Deferred;",
        "",
      ].join("\n"),
    );

    const findings = await validateWorkspace(root);
    expect(
      findings.filter(
        ({ code, message }) =>
          code === "undeclared-dependency" &&
          message.startsWith("@skizzles/example "),
      ),
    ).toHaveLength(0);
    expect(findings).toContainEqual({
      code: "undeclared-dependency",
      path: "packages/example/src/index.ts",
      message:
        "unlisted-runtime is not a direct runtime, optional, or peer dependency",
    });
    expect(findings).toContainEqual({
      code: "undeclared-dependency",
      path: "packages/example/src/index.ts",
      message:
        "unlisted-type-query is not a direct runtime, optional, or peer dependency",
    });
    expect(findings).toContainEqual({
      code: "private-package-import",
      path: "packages/example/src/index.ts",
      message:
        "@skizzles/example/internal is not an exported surface of @skizzles/example",
    });
  });

  it("extracts every static form across TSX, MTS, and CTS deterministically", async () => {
    const root = await fixture();
    const manifest = packageManifest("@skizzles/example");
    manifest.dependencies["react"] = "^19.0.0";
    await writeManifest(root, "example", manifest);
    await writeFile(
      join(root, "packages/example/src/index.tsx"),
      [
        'import { type One, Two } from "static-import";',
        'import type { Three } from "static-import";',
        'export type { Four } from "static-export";',
        'export { type Seven } from "inline-type-export";',
        'type Five = import("type-query").Five;',
        'import Six = require("import-equals");',
        'void import("dynamic-import");',
        'const view = <section>{"import type { Fake } from \\"tsx-text\\""}</section>;',
        "export type Value = One | Three | Four | Five | Six;",
        "void Two;",
        "void view;",
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "packages/example/src/module.mts"),
      'export type { Value } from "mts-edge";\n',
    );
    await writeFile(
      join(root, "packages/example/src/common.cts"),
      'import Common = require("cts-edge");\nexport type Value = Common;\n',
    );

    expect(undeclaredDependencies(await validateWorkspace(root))).toEqual([
      "cts-edge",
      "dynamic-import",
      "import-equals",
      "inline-type-export",
      "static-export",
      "static-import",
      "type-query",
      "mts-edge",
    ]);
  });

  it("reports TypeScript syntax diagnostics as source parse errors", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "packages/example/src/index.ts"),
      'import type { Missing } from "must-not-be-accepted";\nconst value = ;\n',
    );

    const findings = await validateWorkspace(root);
    expect(
      findings.some(
        ({ code, message }) =>
          code === "source-parse-error" && message.includes("TypeScript TS"),
      ),
    ).toBe(true);
    expect(undeclaredDependencies(findings)).toEqual([]);
  });
});

function undeclaredDependencies(
  findings: Awaited<ReturnType<typeof validateWorkspace>>,
): string[] {
  return findings
    .filter(({ code }) => code === "undeclared-dependency")
    .map(({ message }) => message.split(" ")[0] ?? "");
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skizzles-source-imports-"));
  roots.push(root);
  await writeFile(join(root, "bun.lock"), "");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      ...packageManifest("skizzles"),
      workspaces: ["packages/*"],
    }),
  );
  await addPackage(root, "example", "@skizzles/example");
  return root;
}

async function addPackage(
  root: string,
  directory: string,
  name: string,
): Promise<void> {
  const packageRoot = join(root, "packages", directory);
  await mkdir(join(packageRoot, "src"), { recursive: true });
  await mkdir(join(packageRoot, "test"), { recursive: true });
  await writeManifest(root, directory, packageManifest(name));
  await writeFile(join(packageRoot, "README.md"), `# ${name}\n`);
  await writeFile(join(packageRoot, "tsconfig.json"), "{}\n");
  await writeFile(
    join(packageRoot, "src/index.ts"),
    "export type Value = number;\n",
  );
  await writeFile(
    join(packageRoot, "test/index.test.ts"),
    'import type { Value } from "../src/index.ts";\nexport type TestValue = Value;\n',
  );
}

async function writeManifest(
  root: string,
  directory: string,
  manifest: ReturnType<typeof packageManifest>,
): Promise<void> {
  await writeFile(
    join(root, "packages", directory, "package.json"),
    JSON.stringify(manifest),
  );
}

function packageManifest(name: string) {
  return {
    name,
    version: "0.1.0",
    private: true,
    type: "module",
    exports: { ".": "./src/index.ts" },
    bin: {},
    scripts: {
      build: "bun build ./src/index.ts",
      check:
        "bunx @biomejs/biome@2.5.4 check --config-path ../../biome.jsonc --vcs-root ../.. .",
      test: "bun test ./test",
      typecheck: "tsc --noEmit",
    },
    dependencies: {} as Record<string, string>,
    devDependencies: {
      "@types/bun": "^1.3.14",
      "@types/node": "^26.1.1",
      typescript: "^7.0.2",
    },
  };
}
