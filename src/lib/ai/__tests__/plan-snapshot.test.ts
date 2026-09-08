import { describe, expect, it } from "vitest";
import { InMemoryPlanStore } from "../../plans.js";
import { AiSnapshotError } from "../snapshots.js";
import { resolvePlanSnapshot } from "../plan-snapshot.js";
import type { AiPlanContext } from "../types.js";
import type { Plan } from "../../plan-types.js";

function context(overrides: Partial<AiPlanContext> = {}): AiPlanContext {
  return {
    kind: "plan",
    planId: "p",
    title: "client title",
    version: 1,
    body: "client body",
    ...overrides,
  };
}
async function expectCode(
  action: () => Promise<unknown>,
  code: AiSnapshotError["code"],
): Promise<void> {
  try {
    await action();
    throw new Error("expected snapshot error");
  } catch (error) {
    expect(error).toBeInstanceOf(AiSnapshotError);
    expect((error as AiSnapshotError).code).toBe(code);
  }
}

describe("resolvePlanSnapshot", () => {
  it("rejects oversized stored bodies before capture or hashing", async () => {
    const store = new InMemoryPlanStore();
    const plan = await store.upsert({
      title: "P",
      body: "x".repeat(4 * 1024 * 1024 + 1),
    });
    await expectCode(
      () =>
        resolvePlanSnapshot(
          context({ planId: plan.id, body: undefined }),
          store,
        ),
      "limit",
    );
  });
  it("uses stored title/body and captures recorded previous versions", async () => {
    const store = new InMemoryPlanStore();
    const first = await store.upsert({ title: "Stored one", body: "one" });
    await store.upsert({ id: first.id, title: "Stored two", body: "two" });
    const resolved = await resolvePlanSnapshot(
      context({
        planId: first.id,
        version: 2,
        previousVersion: 1,
        title: "forged",
        body: "two",
        previousBody: "one",
      }),
      store,
    );
    expect(resolved.context.title).toBe("Stored two");
    expect(resolved.context.body).toBe("two");
    expect(resolved.context.previousBody).toBe("one");
    expect(
      resolved.snapshot.manifest.sources.map((source) => source.key),
    ).toEqual(["plan", "previous-plan"]);
  });

  it("rejects mismatched client evidence and missing plans/versions", async () => {
    const store = new InMemoryPlanStore();
    const plan = await store.upsert({ title: "P", body: "body" });
    await expectCode(
      () =>
        resolvePlanSnapshot(context({ planId: plan.id, body: "other" }), store),
      "stale",
    );
    await expectCode(
      () =>
        resolvePlanSnapshot(
          context({ planId: plan.id, previousVersion: 9 }),
          store,
        ),
      "missing",
    );
    await expectCode(
      () =>
        resolvePlanSnapshot(
          context({ planId: plan.id, previousBody: "fabricated" }),
          store,
        ),
      "invalid",
    );
    await expectCode(
      () =>
        resolvePlanSnapshot(
          context({ planId: plan.id, body: "body", selectedText: "absent" }),
          store,
        ),
      "stale",
    );
    await expectCode(
      () => resolvePlanSnapshot(context({ planId: "missing" }), store),
      "missing",
    );
  });

  it("keeps drafts explicit and freshness observes body edits without version bumps", async () => {
    const store = new InMemoryPlanStore();
    const plan = await store.upsert({ title: "P", body: "canonical" });
    const resolved = await resolvePlanSnapshot(
      context({ planId: plan.id, body: "canonical", bodyDraft: "draft" }),
      store,
    );
    expect(resolved.context.body).toBe("canonical");
    expect(
      resolved.snapshot.manifest.sources.find(
        (source) => source.key === "body-draft",
      ),
    ).toMatchObject({ provenance: "draft", side: "draft" });
    const capturedRevision = resolved.snapshot.manifest.revision;
    const capturedBodyHash =
      resolved.snapshot.manifest.identity.kind === "plan"
        ? resolved.snapshot.manifest.identity.bodyHash
        : "";
    await store.update(plan.id, { body: "edited live" });
    await expectCode(resolved.assertFresh, "stale");
    const refreshed = await resolvePlanSnapshot(
      context({ planId: plan.id, body: "edited live" }),
      store,
    );
    expect(refreshed.snapshot.manifest.revision).not.toBe(capturedRevision);
    expect(
      refreshed.snapshot.manifest.identity.kind === "plan" &&
        refreshed.snapshot.manifest.identity.bodyHash,
    ).not.toBe(capturedBodyHash);
  });

  it("omits reconstructed history rather than fabricating prior body text", async () => {
    const store = new InMemoryPlanStore();
    const legacy: Plan = {
      id: "legacy",
      title: "Legacy",
      body: "current",
      createdAt: 1,
      updatedAt: 2,
      version: 2,
      decision: "pending",
      comments: [],
      versions: [
        {
          version: 1,
          provenance: "reconstructed",
          title: "Legacy",
          body: "current",
          createdAt: 1,
        },
        {
          version: 2,
          provenance: "recorded",
          title: "Legacy",
          body: "current",
          createdAt: 2,
        },
      ],
    };
    const records = await store.getAll();
    records.push(legacy);
    const resolved = await resolvePlanSnapshot(
      context({
        planId: "legacy",
        version: 2,
        previousVersion: 1,
        body: "current",
      }),
      store,
    );
    expect(resolved.context.previousBody).toBeUndefined();
    expect(resolved.snapshot.manifest.sources[1]).toMatchObject({
      provenance: "reconstructed",
      hash: null,
    });
    await expectCode(async () => {
      resolved.snapshot.read("previous-plan", 1, 1);
    }, "missing");
  });

  it("omits unknown unmarked history and rejects mismatched previous bodies", async () => {
    const store = new InMemoryPlanStore();
    const plan = await store.upsert({ title: "P", body: "v1" });
    await store.upsert({ id: plan.id, title: "P2", body: "v2" });
    const current = await store.get(plan.id);
    if (current) current.versions[0].provenance = undefined;
    await expectCode(
      () =>
        resolvePlanSnapshot(
          context({
            planId: plan.id,
            version: 2,
            previousVersion: 1,
            body: "v2",
            previousBody: "wrong",
          }),
          store,
        ),
      "stale",
    );
    const unknown = await resolvePlanSnapshot(
      context({ planId: plan.id, version: 2, previousVersion: 1, body: "v2" }),
      store,
    );
    expect(unknown.snapshot.manifest.sources[1]).toMatchObject({
      provenance: "unknown",
      hash: null,
    });
  });

  it("allows valid explicit historical selection and detects captured store mutation", async () => {
    const store = new InMemoryPlanStore();
    const plan = await store.upsert({ title: "P", body: "one" });
    await store.upsert({ id: plan.id, title: "P2", body: "two" });
    const historical = await resolvePlanSnapshot(
      context({
        planId: plan.id,
        version: 1,
        title: "ignored",
        body: "one",
        selectedText: "one",
      }),
      store,
    );
    expect(historical.context.body).toBe("one");
    expect(
      historical.snapshot.manifest.identity.kind === "plan" &&
        historical.snapshot.manifest.identity.version,
    ).toBe(1);
    const resolved = await resolvePlanSnapshot(
      context({
        planId: plan.id,
        version: 2,
        body: "two",
        selectedText: "two",
      }),
      store,
    );
    const current = await store.get(plan.id);
    expect(current?.body).toBe("two");
    if (current) current.body = "mutated while attachment awaited";
    await expectCode(resolved.assertFresh, "stale");
  });
});
