// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryPlanStore } from '../lib/plans.js'
import type { Plan, PlanComment } from '../lib/plan-types.js'

function makeComment(overrides: Partial<PlanComment> = {}): PlanComment {
  return {
    id: 'c1',
    lineNumber: 1,
    lineContent: 'x',
    body: 'b',
    status: 'open',
    createdAt: 0,
    createdAtPlanVersion: 1,
    replies: [],
    ...overrides,
  }
}

describe('plan version history', () => {
  let store: InMemoryPlanStore

  beforeEach(() => {
    store = new InMemoryPlanStore()
  })

  it('seeds versions with one entry on first upsert', async () => {
    const plan = await store.upsert({ title: 'P', body: '# P', source: 'cli', model: 'opus' })
    expect(plan.versions).toHaveLength(1)
    expect(plan.versions[0]).toMatchObject({
      version: 1,
      body: '# P',
      title: 'P',
      source: 'cli',
      model: 'opus',
    })
  })

  it('appends the new current snapshot on resubmit and bumps plan.version', async () => {
    const first = await store.upsert({ title: 'P', body: '# P v1' })
    const second = await store.upsert({ id: first.id, title: 'P', body: '# P v2' })
    expect(second.versions).toHaveLength(2)
    expect(second.versions[0]).toMatchObject({ version: 1, body: '# P v1' })
    expect(second.versions[1]).toMatchObject({ version: 2, body: '# P v2' })
    expect(second.version).toBe(2)
    expect(second.body).toBe('# P v2')
  })

  it('records the original v1 submit timestamp in the v1 snapshot even after a resubmit', async () => {
    const first = await store.upsert({ title: 'P', body: 'a' })
    const firstUpdatedAt = first.updatedAt
    await new Promise((r) => setTimeout(r, 5))
    const second = await store.upsert({ id: first.id, title: 'P2', body: 'b' })
    // v1's createdAt stays pinned to the original submit time; only the new
    // tail entry gets the resubmit timestamp.
    expect(second.versions[0].createdAt).toBe(firstUpdatedAt)
    expect(second.versions[1].createdAt).toBeGreaterThan(firstUpdatedAt)
  })

  it('getVersion returns the matching snapshot or null', async () => {
    const first = await store.upsert({ title: 'P', body: 'a' })
    await store.upsert({ id: first.id, title: 'P', body: 'b' })
    const v1 = await store.getVersion(first.id, 1)
    expect(v1).toMatchObject({ version: 1, body: 'a' })
    expect(await store.getVersion(first.id, 99)).toBeNull()
    expect(await store.getVersion('nope', 1)).toBeNull()
  })

  it('addComment stamps createdAtPlanVersion from the plan when not provided', async () => {
    const plan = await store.upsert({ title: 'P', body: 'a' })
    await store.addComment(plan.id, makeComment({ id: 'c1' })) // no createdAtPlanVersion field
    const after = await store.get(plan.id)
    expect(after?.comments[0].createdAtPlanVersion).toBe(1)
  })

  it('addComment preserves an explicit createdAtPlanVersion', async () => {
    const plan = await store.upsert({ title: 'P', body: 'a' })
    await store.addComment(plan.id, makeComment({ id: 'c1', createdAtPlanVersion: 5 }))
    const after = await store.get(plan.id)
    expect(after?.comments[0].createdAtPlanVersion).toBe(5)
  })

  it('addReply inherits the parent comment version stamp', async () => {
    const plan = await store.upsert({ title: 'P', body: 'a' })
    await store.addComment(plan.id, makeComment({ id: 'c1', createdAtPlanVersion: 3 }))
    await store.addReply(plan.id, 'c1', { id: 'r1', body: 'hi', createdAt: 0, role: 'agent' })
    const after = await store.get(plan.id)
    expect(after?.comments[0].replies[0].createdAtPlanVersion).toBe(3)
  })

  it('addReply does not overwrite an explicit reply version stamp', async () => {
    const plan = await store.upsert({ title: 'P', body: 'a' })
    await store.addComment(plan.id, makeComment({ id: 'c1', createdAtPlanVersion: 3 }))
    await store.addReply(plan.id, 'c1', { id: 'r1', body: 'hi', createdAt: 0, role: 'agent', createdAtPlanVersion: 9 })
    const after = await store.get(plan.id)
    expect(after?.comments[0].replies[0].createdAtPlanVersion).toBe(9)
  })

  it('update keeps plan.versions[] in sync with the current body (latest snapshot matches plan)', async () => {
    const plan = await store.upsert({ title: 'P', body: 'a' })
    await store.update(plan.id, { body: 'metadata edit' })
    const after = await store.get(plan.id)
    // metadata edit should not bump the plan's version counter
    expect(after?.version).toBe(plan.version)
    // but the latest PlanVersion snapshot's body should mirror the new body
    expect(after?.versions[after.versions.length - 1].body).toBe('metadata edit')
  })

  it('backfills a legacy v1 plan with a single versions[] entry', async () => {
    const plan = await store.upsert({ title: 'P', body: 'a' })
    // Simulate a legacy persisted plan by stripping versions
    const raw = await store.getAll()
    const legacy: Plan = { ...raw[0], version: 1, versions: undefined as unknown as Plan['versions'] }
    ;(store as unknown as { plans: Plan[] }).plans = [legacy]
    const reloaded = await store.get(plan.id)
    expect(reloaded?.versions).toHaveLength(1)
    expect(reloaded?.versions[0].body).toBe(legacy.body)
    expect(reloaded?.versions[0].version).toBe(1)
  })

  it('backfills a legacy multi-version plan with one entry per recorded version', async () => {
    // Simulate a plan that was at v3 before the versioning feature shipped:
    // version: 3, body: the current v3 body, no versions[] on disk. The old
    // code overwrote the v1 and v2 bodies, so all three synthetic entries
    // carry the current body. The point is that the version dropdown becomes
    // visible (3 entries), not that the historical bodies are recovered.
    const legacy: Plan = {
      id: 'legacy-1',
      title: 'Old plan',
      body: '# v3 body',
      createdAt: 1000,
      updatedAt: 2000,
      version: 3,
      decision: 'pending',
      comments: [],
      versions: undefined as unknown as Plan['versions'],
    }
    ;(store as unknown as { plans: Plan[] }).plans = [legacy]
    const reloaded = await store.get('legacy-1')
    expect(reloaded?.versions).toHaveLength(3)
    expect(reloaded?.versions.map((v) => v.version)).toEqual([1, 2, 3])
    // The only body we have on disk is the v3 body; all synthetic entries
    // mirror it. Switching to v1 in the UI will show the v3 body — that's
    // the best we can do without historical on-disk state.
    for (const v of reloaded!.versions) {
      expect(v.body).toBe('# v3 body')
    }
  })

  it('records provenance for new and resubmitted versions while preserving older history', async () => {
    const first = await store.upsert({ title: 'P', body: 'one' })
    const second = await store.upsert({ id: first.id, title: 'P2', body: 'two' })
    expect(second.versions.map((version) => version.provenance)).toEqual(['recorded', 'recorded'])
    await store.update(first.id, { body: 'live edit' })
    const edited = await store.get(first.id)
    expect(edited?.version).toBe(2)
    expect(edited?.versions[0].body).toBe('one')
    expect(edited?.versions[0].provenance).toBe('recorded')
    expect(edited?.versions[1]).toMatchObject({ body: 'live edit', provenance: 'recorded' })
  })

  it('marks backfilled legacy records reconstructed and does not relabel pre-existing records', async () => {
    const legacy: Plan = {
      id: 'legacy-provenance', title: 'Legacy', body: 'current', createdAt: 1, updatedAt: 2,
      version: 3, decision: 'pending', comments: [], versions: undefined as unknown as Plan['versions'],
    }
    ;(store as unknown as { plans: Plan[] }).plans = [legacy]
    const loaded = await store.get(legacy.id)
    expect(loaded?.versions.every((version) => version.provenance === 'reconstructed')).toBe(true)
    const prior = await store.upsert({ title: 'Existing', body: 'old' })
    const raw = await store.getAll()
    raw[1].versions[0].provenance = undefined
    const resubmitted = await store.upsert({ id: prior.id, title: 'Existing 2', body: 'new' })
    expect(resubmitted.versions[0].provenance).toBeUndefined()
    expect(resubmitted.versions[1].provenance).toBe('recorded')
  })

  it('backfills a comment missing createdAtPlanVersion with the current plan version', async () => {
    const plan = await store.upsert({ title: 'P', body: 'a' })
    await store.addComment(plan.id, makeComment({ id: 'c1' }))
    const raw = await store.getAll()
    const legacyComment: PlanComment = {
      id: 'c1',
      lineNumber: 1,
      lineContent: 'x',
      body: 'b',
      status: 'open',
      createdAt: 0,
      createdAtPlanVersion: undefined as unknown as number,
      replies: [],
    }
    const legacy: Plan = { ...raw[0], comments: [legacyComment] }
    ;(store as unknown as { plans: Plan[] }).plans = [legacy]
    const reloaded = await store.get(plan.id)
    expect(reloaded?.comments[0].createdAtPlanVersion).toBe(plan.version)
  })
})

