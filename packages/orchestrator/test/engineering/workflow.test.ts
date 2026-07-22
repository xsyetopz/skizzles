// biome-ignore lint/correctness/noUnresolvedImports: Bun supplies this built-in module.
import { afterEach, describe, expect, it } from "bun:test";
import { createChangeDeclaration } from "@skizzles/change-assurance";
import { repositoryContext } from "../support.ts";
import { createTestChangeDeclaration } from "./assurance-fixture.ts";
import {
  candidate,
  candidateDigest,
  cleanupFixtures,
  createFixture,
  prepareExample,
} from "./workflow/fixture.ts";

afterEach(cleanupFixtures);

describe("engineering assurance workflow", () => {
  it("describes context, derives a candidate, and keeps publication behind approval", async () => {
    const fixture = createFixture();
    const repository = await repositoryContext(fixture.orchestrator);
    const described = await fixture.workflow.describe({
      ...repository,
      targets: ["src/example.ts"],
      validationProfile: "strict",
    });
    expect(described.status).toBe("described");
    if (described.status !== "described") return;
    expect(described.context.templates[0]?.schemaText).toContain("declaration");
    const prepared = await fixture.workflow.prepare({
      ...repository,
      context: described.context,
      changeDeclaration: createTestChangeDeclaration({
        requestDigest: repository.request.intentDigest,
        repositoryId: repository.repository.repositoryId,
        targets: Object.freeze([
          Object.freeze({ path: "src/example.ts", candidateDigest }),
        ]),
      }),
      targets: [
        {
          path: "src/example.ts",
          operations: [
            {
              kind: "replace",
              selector: {
                declarationKind: "function",
                name: "run",
                expectedNodeDigest: candidateDigest,
              },
              templateId: "function-template",
              nodeSource: "export function run(): boolean { return true; }",
            },
          ],
        },
      ],
      faultDeclarations: { declarations: [], negativeTests: [] },
      validationProfile: "strict",
      integrations: [],
    });
    expect(prepared.status).toBe("awaiting-approval");
    expect(fixture.destination.currentText("src/example.ts")).toBeUndefined();
    expect(fixture.physicalCalls()).toBe(0);
    if (prepared.status !== "awaiting-approval") return;
    expect(prepared.review.preview.candidateDigest).toBe(candidateDigest);
    const promoted = await fixture.workflow.approveAndPromote({
      review: prepared.review,
      token: "approve",
    });
    expect(promoted.status).toBe("completed");
    expect(fixture.destination.currentText("src/example.ts")).toBe(
      new TextDecoder().decode(candidate),
    );
  });

  it("stops rejected assurance before physical integration or Phase 2", async () => {
    const fixture = createFixture();
    const repository = await repositoryContext(fixture.orchestrator);
    const described = await fixture.workflow.describe({
      ...repository,
      targets: ["src/example.ts"],
      validationProfile: "strict",
    });
    expect(described.status).toBe("described");
    if (described.status !== "described") return;
    const declaration = createChangeDeclaration(
      Object.freeze({
        requestDigest: repository.request.intentDigest,
        repositoryId: repository.repository.repositoryId,
        targets: Object.freeze([
          Object.freeze({ path: "src/example.ts", operation: "write" }),
        ]),
        plans: Object.freeze({
          "middleware-security": Object.freeze({}),
          "migration-configuration-secrets": Object.freeze({
            migrations: Object.freeze([]),
          }),
          performance: Object.freeze({ schemaVersion: 1 }),
          "supply-chain": Object.freeze({
            schemaVersion: 1,
            changes: Object.freeze([]),
          }),
        }),
      }),
    );
    expect(declaration.status).toBe("created");
    if (declaration.status !== "created") return;
    const result = await fixture.workflow.prepare({
      ...repository,
      context: described.context,
      changeDeclaration: declaration.declaration,
      targets: [
        {
          path: "src/example.ts",
          operations: [
            {
              kind: "replace",
              selector: {
                declarationKind: "function",
                name: "run",
                expectedNodeDigest: candidateDigest,
              },
              templateId: "function-template",
              nodeSource: "export function run(): boolean { return true; }",
            },
          ],
        },
      ],
      faultDeclarations: { declarations: [], negativeTests: [] },
      validationProfile: "strict",
      integrations: [],
    });
    expect(result).toEqual({
      status: "rejected",
      code: "CHANGE_ASSURANCE_REJECTED",
      cleanup: null,
    });
    expect(fixture.physicalCalls()).toBe(0);
    expect(fixture.destination.currentText("src/example.ts")).toBeUndefined();
  });

  it("never accepts whole candidate bytes or caller commands", async () => {
    const fixture = createFixture();
    const repository = await repositoryContext(fixture.orchestrator);
    await expect(
      fixture.workflow.prepare({
        ...repository,
        context: Object.freeze({}),
        targets: [],
        faultDeclarations: { declarations: [], negativeTests: [] },
        validationProfile: "strict",
        integrations: [],
        candidateBytes: Array.from(candidate),
        commands: ["arbitrary"],
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "INVALID_WORKFLOW_INPUT",
    });
  });

  it("resumes a one-shot paused workflow with its bound target baseline", async () => {
    const fixture = createFixture({ pauseOnce: true });
    const repository = await repositoryContext(fixture.orchestrator);
    const described = await fixture.workflow.describe({
      ...repository,
      targets: ["src/example.ts"],
      validationProfile: "strict",
    });
    if (described.status !== "described") throw new Error("describe rejected");
    const paused = await prepareExample(fixture, repository, described.context);
    expect(paused.status).toBe("paused");
    if (paused.status !== "paused") return;
    const resumed = await fixture.workflow.continue({
      continuation: paused.continuation,
    });
    expect(resumed.status).toBe("awaiting-approval");
    await expect(
      fixture.workflow.continue({ continuation: paused.continuation }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "CONTINUATION_REJECTED",
    });
    if (resumed.status === "awaiting-approval") {
      await fixture.workflow.reject({ review: resumed.review });
    }
  });

  it("atomically cancels an abandoned continuation and releases its target", async () => {
    const fixture = createFixture({ pauseOnce: true });
    const repository = await repositoryContext(fixture.orchestrator);
    const described = await fixture.workflow.describe({
      ...repository,
      targets: ["src/example.ts"],
      validationProfile: "strict",
    });
    if (described.status !== "described") throw new Error("describe rejected");
    const paused = await prepareExample(fixture, repository, described.context);
    if (paused.status !== "paused") throw new Error("workflow did not pause");
    await expect(
      fixture.workflow.cancelContinuation({
        continuation: paused.continuation,
      }),
    ).resolves.toEqual({ status: "cancelled" });
    await expect(
      fixture.workflow.cancelContinuation({
        continuation: paused.continuation,
      }),
    ).resolves.toEqual({
      status: "rejected",
      code: "CONTINUATION_REJECTED",
    });

    const retriedDescription = await fixture.workflow.describe({
      ...repository,
      targets: ["src/example.ts"],
      validationProfile: "strict",
    });
    if (retriedDescription.status !== "described") {
      throw new Error("retry describe rejected");
    }
    const retried = await prepareExample(
      fixture,
      repository,
      retriedDescription.context,
    );
    expect(retried.status).toBe("awaiting-approval");
    if (retried.status === "awaiting-approval") {
      await fixture.workflow.reject({ review: retried.review });
    }
  });

  it("revalidates source evidence immediately before promotion", async () => {
    const fixture = createFixture({ rejectVerification: true });
    const repository = await repositoryContext(fixture.orchestrator);
    const described = await fixture.workflow.describe({
      ...repository,
      targets: ["src/example.ts"],
      validationProfile: "strict",
    });
    if (described.status !== "described") throw new Error("describe rejected");
    const prepared = await prepareExample(
      fixture,
      repository,
      described.context,
    );
    if (prepared.status !== "awaiting-approval") {
      throw new Error("prepare rejected");
    }
    await expect(
      fixture.workflow.approveAndPromote({
        review: prepared.review,
        token: "approve",
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "ENGINEERING_EVIDENCE_REJECTED",
    });
    expect(fixture.destination.currentText("src/example.ts")).toBeUndefined();
  });

  it("routes the trusted validation-profile language to source engineering", async () => {
    const fixture = createFixture({
      language: "javascript",
      targetPath: "src/example.js",
    });
    const repository = await repositoryContext(fixture.orchestrator);
    const described = await fixture.workflow.describe({
      ...repository,
      targets: ["src/example.js"],
      validationProfile: "strict",
    });
    expect(described.status).toBe("described");
  });

  it("rejects a review that omits a configured negative-test profile", async () => {
    const fixture = createFixture({
      negativeEvidence: true,
      omitNegativeProfile: true,
    });
    const repository = await repositoryContext(fixture.orchestrator);
    const described = await fixture.workflow.describe({
      ...repository,
      targets: ["src/example.ts"],
      validationProfile: "strict",
    });
    if (described.status !== "described") throw new Error("describe rejected");
    await expect(
      prepareExample(fixture, repository, described.context),
    ).resolves.toMatchObject({
      status: "rejected",
      code: "ENGINEERING_EVIDENCE_REJECTED",
    });
  });
});
