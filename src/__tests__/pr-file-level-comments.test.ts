// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Hono } from 'hono'
import type { CommentStore } from '../lib/comments.js'
import { InMemoryPrSessionStore } from '../lib/pr-session.js'
import type {
  PrSession,
  PrExistingComment,
  PrExistingReply,
} from '../lib/pr-session.js'
import type { PlanStore } from '../lib/plans.js'

// ---------------------------------------------------------------------------
// Mock everything the server imports (same pattern as gh-pr.test.ts)
// ---------------------------------------------------------------------------
const githubMocks = vi.hoisted(() => ({
  submitReview: vi.fn(),
  fetchExistingComments: vi.fn(),
  fetchExistingReviews: vi.fn(),
  updateComment: vi.fn(),
  deleteComment: vi.fn(),
  setThreadResolved: vi.fn(),
  fetchPrFileContent: vi.fn(),
  replyToPrComment: vi.fn(),
}))

vi.mock('../lib/github.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/github.js')>()
  return {
    ...actual,
    submitReview: githubMocks.submitReview,
    fetchExistingCommentsViaGh: githubMocks.fetchExistingComments,
    fetchExistingReviewsViaGh: githubMocks.fetchExistingReviews,
    updatePrReviewComment: githubMocks.updateComment,
    deletePrReviewComment: githubMocks.deleteComment,
    setPrReviewThreadResolved: githubMocks.setThreadResolved,
    fetchPrFileContentViaGh: githubMocks.fetchPrFileContent,
    replyToPrComment: githubMocks.replyToPrComment,
  }
})

vi.mock('../lib/git.js', () => ({
  getGitDiff: vi.fn(() => ''),
  getCustomGitDiff: vi.fn(() => ''),
  getRepoName: vi.fn(() => 'test-repo'),
  getBranchName: vi.fn(() => 'main'),
  getFileContent: vi.fn(() => ''),
  getTabSizeForFiles: vi.fn(() => ({})),
  getUntrackedFilePaths: vi.fn(() => []),
  getGitDiffAsync: vi.fn(async () => ''),
  getCustomGitDiffAsync: vi.fn(async () => ''),
  getRepoRootAsync: vi.fn(async () => '/tmp/test-repo'),
  getBranchNameAsync: vi.fn(async () => 'main'),
  getUntrackedFilePathsAsync: vi.fn(async () => []),
  getRepoRoot: vi.fn(() => '/tmp/test-repo'),
  getProjectStorageDir: vi.fn(() => '/tmp/test-project-storage'),
  getShowDiff: vi.fn(() => ''),
}))

vi.mock('../lib/settings.js', () => ({
  loadSettings: vi.fn(() => ({})),
  saveSettings: vi.fn((s: any) => s),
}))

vi.mock('../lib/path.js', () => ({ isSafePath: vi.fn(() => true) }))

// ---------------------------------------------------------------------------
// Mock stores (same as gh-pr.test.ts)
// ---------------------------------------------------------------------------
class MockCommentStore implements CommentStore {
  async getAll() {
    return []
  }
  async add(c: any) {
    return c
  }
  async update() {
    return null
  }
  async remove() {
    return false
  }
  async addReply() {
    return null
  }
  async removeReply() {
    return null
  }
  async updateReply() {
    return null
  }
  async resolveAllOpen() {
    return 0
  }
}

class MockPlanStore implements PlanStore {
  async getAll() {
    return []
  }
  async get() {
    return null
  }
  async upsert(input: { id?: string; title: string; body: string; source?: string; model?: string }) {
    return {
      id: input.id || 'p1',
      title: input.title,
      body: input.body,
      source: input.source,
      model: input.model,
      createdAt: 0,
      updatedAt: 0,
      version: 1,
      decision: 'pending' as const,
      comments: [],
      versions: [{ version: 1, body: input.body, title: input.title, createdAt: 0 }],
    }
  }
  async update() {
    return null
  }
  async remove() {
    return false
  }
  async setDecision() {
    return null
  }
  async addComment() {
    return null
  }
  async updateComment() {
    return null
  }
  async removeComment() {
    return null
  }
  async addReply() {
    return null
  }
  async removeReply() {
    return null
  }
  async updateReply() {
    return null
  }
  async getVersion() {
    return null
  }
}

// ---------------------------------------------------------------------------
// File-level session helpers
// ---------------------------------------------------------------------------
const makeReplies = (): PrExistingReply[] => [
  {
    id: 5001,
    author: { login: 'reviewer' },
    body: 'first reply',
    createdAt: '2026-01-02T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
  },
  {
    id: 5002,
    author: { login: 'author' },
    body: 'second reply',
    createdAt: '2026-01-03T00:00:00.000Z',
    updatedAt: '2026-01-03T00:00:00.000Z',
  },
]

const fileLevelLead: PrExistingComment = {
  id: 999,
  author: { login: 'reviewer' },
  body: 'file-level note',
  path: 'src/server.ts',
  line: null,
  side: null,
  startLine: null,
  startSide: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  state: 'COMMENTED',
  replies: makeReplies(),
  isOutdated: false,
  threadId: 'PRRT_t1',
  isResolved: false,
  viewerCanResolve: true,
  viewerCanUnresolve: true,
  viewerDidAuthor: true,
}

const fileLevelSession: PrSession = {
  ref: '1234',
  owner: 'acme',
  repo: 'widget',
  pullNumber: 1234,
  headSha: 'head',
  baseSha: 'base',
  title: 'A test PR',
  url: 'https://github.com/ahmedragab20/diffing/pull/1234',
  author: { login: 'octocat' },
  additions: 10,
  deletions: 5,
  changedFiles: 2,
  diff: 'diff --git a/x b/x\n',
  comments: [],
  existingComments: [fileLevelLead],
  authSource: 'gh',
}

async function makeApp(prStore: InMemoryPrSessionStore): Promise<Hono> {
  const { createApp } = await import('../server.js')
  const { DEFAULTS } = await import('../lib/diff-options.js')
  return createApp('/tmp/test-client', DEFAULTS, new MockCommentStore(), new MockPlanStore(), prStore, true)
}

// ---------------------------------------------------------------------------
// A. Integration tests – file-level comment flows through real Hono app
// ---------------------------------------------------------------------------
describe('file-level comments integration', () => {
  let app: Hono
  let prStore: InMemoryPrSessionStore

  beforeEach(async () => {
    vi.clearAllMocks()
    // Default mocks for every test
    githubMocks.submitReview.mockResolvedValue({
      ok: true,
      reviewId: 55,
      reviewUrl: 'https://github.test/review/55',
      authSource: 'gh',
    })
    githubMocks.fetchExistingComments.mockResolvedValue([])
    githubMocks.fetchExistingReviews.mockResolvedValue([])
    githubMocks.updateComment.mockResolvedValue({ ok: true })
    githubMocks.deleteComment.mockResolvedValue({ ok: true })
    githubMocks.setThreadResolved.mockResolvedValue({ ok: true })
    githubMocks.fetchPrFileContent.mockResolvedValue(null)
    githubMocks.replyToPrComment.mockResolvedValue({
      ok: true,
      id: 5003,
      reply: {
        id: 5003,
        author: { login: 'me', avatarUrl: 'https://avatars.githubusercontent.com/u/1' },
        body: 'thanks',
        createdAt: '2026-07-21T12:00:00.000Z',
        updatedAt: '2026-07-21T12:00:00.000Z',
      },
    })
    prStore = new InMemoryPrSessionStore()
    app = await makeApp(prStore)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  // ── Test 1 ──────────────────────────────────────────────────────────────
  it('1: file-level: replying optimistically merges the new reply and preserves existing replies + path/threadId', async () => {
    await prStore.set(fileLevelSession)

    const res = await app.fetch(
      new Request('http://localhost/api/gh/existing-comments/999/replies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'thanks' }),
      }),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.id).toBe(5003)
    expect(body.reply.id).toBe(5003)
    expect(body.reply.body).toBe('thanks')

    // The optimistic merge: reply is appended to the thread in the session
    const after = await prStore.get()
    expect(after?.existingComments).toHaveLength(1)
    expect(after?.existingComments[0].id).toBe(999)
    expect(after?.existingComments[0].path).toBe('src/server.ts')
    expect(after?.existingComments[0].line).toBeNull()
    expect(after?.existingComments[0].side).toBeNull()
    expect(after?.existingComments[0].threadId).toBe('PRRT_t1')
    expect(after?.existingComments[0].isResolved).toBe(false)
    expect(after?.existingComments[0].replies).toHaveLength(3)
    expect(after?.existingComments[0].replies[2].id).toBe(5003)
    expect(after?.existingComments[0].replies[2].body).toBe('thanks')

    // GitHub API was called with the lead id as inReplyTo
    expect(githubMocks.replyToPrComment).toHaveBeenCalledWith(
      expect.objectContaining({ inReplyTo: 999, body: 'thanks' }),
    )
  })

  // ── Test 2 ──────────────────────────────────────────────────────────────
  it('2: file-level: reply endpoint matches thread owning the reply id, not just the lead id', async () => {
    await prStore.set(fileLevelSession)

    // POST using a REPLY's id (5001) instead of the lead's id (999)
    const res = await app.fetch(
      new Request('http://localhost/api/gh/existing-comments/5001/replies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'reply to reply' }),
      }),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.reply.id).toBe(5003)

    // Even when the URL `:id` is a reply's id (5001), the optimistic merge
    // targets the owning thread (via the lead OR any reply id match) rather
    // than silently no-op'ing. The merge condition is now:
    //   comment.id === id || comment.replies.some((r) => r.id === id)
    // Since reply id 5001 belongs to the thread whose lead is 999, the merge
    // appends the new reply (5003) to that thread.
    const after = await prStore.get()
    expect(after?.existingComments[0].replies).toHaveLength(3) // merge succeeded
    expect(after?.existingComments[0].replies[2].id).toBe(5003)
    expect(after?.existingComments[0].replies[2].body).toBe('thanks')
    // The new reply is tracked to survive a sync race
    expect(after?.pendingOptimisticReplyIds).toContain(5003)

    // Confirm GitHub was called with inReplyTo=5001 (a reply id)
    expect(githubMocks.replyToPrComment).toHaveBeenCalledWith(
      expect.objectContaining({ inReplyTo: 5001, body: 'reply to reply' }),
    )
  })

  // ── Test 3 ──────────────────────────────────────────────────────────────
  it('3: file-level: PATCH edit on a reply preserves sibling replies and the lead', async () => {
    await prStore.set(fileLevelSession)

    // Mock the PATCH → syncExistingPrReviewData → fetchExistingComments
    // to return the thread with edit applied
    githubMocks.fetchExistingComments.mockResolvedValue([
      {
        ...fileLevelLead,
        replies: fileLevelLead.replies.map((r) =>
          r.id === 5002 ? { ...r, body: 'edited' } : r,
        ),
      },
    ])

    const res = await app.fetch(
      new Request('http://localhost/api/gh/existing-comments/5002', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'edited' }),
      }),
    )

    expect(res.status).toBe(200)
    const after = await prStore.get()
    expect(after?.existingComments).toHaveLength(1)
    expect(after?.existingComments[0].id).toBe(999)
    expect(after?.existingComments[0].replies).toHaveLength(2)
    expect(after?.existingComments[0].replies[1].body).toBe('edited')
    // Lead unchanged
    expect(after?.existingComments[0].author?.login).toBe('reviewer')
    expect(after?.existingComments[0].line).toBeNull()
    expect(after?.existingComments[0].path).toBe('src/server.ts')

    expect(githubMocks.updateComment).toHaveBeenCalledWith(
      expect.objectContaining({ commentId: 5002, body: 'edited' }),
    )
  })

  // ── Test 4 ──────────────────────────────────────────────────────────────
  it('4: file-level: DELETE a reply preserves the lead and remaining replies', async () => {
    await prStore.set(fileLevelSession)

    githubMocks.fetchExistingComments.mockResolvedValue([
      {
        ...fileLevelLead,
        replies: fileLevelLead.replies.filter((r) => r.id !== 5001),
      },
    ])

    const res = await app.fetch(
      new Request('http://localhost/api/gh/existing-comments/5001', {
        method: 'DELETE',
      }),
    )

    expect(res.status).toBe(200)
    const after = await prStore.get()
    expect(after?.existingComments).toHaveLength(1)
    expect(after?.existingComments[0].replies).toHaveLength(1)
    expect(after?.existingComments[0].replies[0].id).toBe(5002)

    expect(githubMocks.deleteComment).toHaveBeenCalledWith(
      expect.objectContaining({ commentId: 5001 }),
    )
  })

  // ── Test 5 ──────────────────────────────────────────────────────────────
  it('5: file-level: resolve thread does not drop lead', async () => {
    await prStore.set(fileLevelSession)

    githubMocks.fetchExistingComments.mockResolvedValue([
      {
        ...fileLevelLead,
        isResolved: true,
      },
    ])

    const res = await app.fetch(
      new Request('http://localhost/api/gh/review-threads/PRRT_t1', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolved: true }),
      }),
    )

    expect(res.status).toBe(200)
    const after = await prStore.get()
    expect(after?.existingComments).toHaveLength(1)
    expect(after?.existingComments[0].id).toBe(999)
    expect(after?.existingComments[0].isResolved).toBe(true)
    expect(after?.existingComments[0].replies).toHaveLength(2)

    expect(githubMocks.setThreadResolved).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'PRRT_t1', resolved: true }),
    )
  })

  // ── Test 6 ──────────────────────────────────────────────────────────────
  it('6: file-level: sync after reply preserves the optimistic new reply across GitHub propagation delay', async () => {
    await prStore.set(fileLevelSession)

    // Step 1 — POST a reply; optimistic merge adds it
    const replyRes = await app.fetch(
      new Request('http://localhost/api/gh/existing-comments/999/replies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'thanks' }),
      }),
    )
    expect(replyRes.status).toBe(200)
    expect(githubMocks.replyToPrComment).toHaveBeenCalled()

    // Verify optimistic merge: thread now has 3 replies + pending tracking
    let after = await prStore.get()
    expect(after?.existingComments[0].replies).toHaveLength(3)
    expect(after?.pendingOptimisticReplyIds).toContain(5003)

    // Step 2 — POST /api/gh/comments/sync (simulating the periodic 30s sync
    // or focus-triggered sync from usePrCommentSync). The mock returns STALE
    // GitHub data (without the new reply) — replicating GitHub propagation delay.
    const staleReplies: PrExistingReply[] = [
      {
        id: 5001,
        author: { login: 'reviewer' },
        body: 'first reply',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 5002,
        author: { login: 'author' },
        body: 'second reply',
        createdAt: '2026-01-03T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
      },
    ]
    githubMocks.fetchExistingComments.mockResolvedValue([
      { ...fileLevelLead, replies: staleReplies },
    ])

    const syncRes = await app.fetch(
      new Request('http://localhost/api/gh/comments/sync', { method: 'POST' }),
    )
    expect(syncRes.status).toBe(200)

    // Step 3 — syncExistingPrReviewData now re-reads the session before
    // writing and uses mergeFreshWithLocalOptimistic to preserve any reply
    // whose id is in pendingOptimisticReplyIds. The optimistic reply (5003)
    // is preserved across the stale GitHub fetch.
    after = await prStore.get()
    expect(after?.existingComments[0].replies).toHaveLength(3)
    expect(after?.existingComments[0].replies[2].id).toBe(5003)
    expect(after?.existingComments[0].replies[2].body).toBe('thanks')
    // The optimistic id is still tracked pending GitHub confirmation
    expect(after?.pendingOptimisticReplyIds).toContain(5003)
  })

  // ── Test 6b ─────────────────────────────────────────────────────────────
  it('6b: file-level: sync clears pendingOptimisticReplyIds when GitHub confirms the optimistic reply', async () => {
    await prStore.set(fileLevelSession)

    // Step 1 — POST a reply (optimistic)
    const replyRes = await app.fetch(
      new Request('http://localhost/api/gh/existing-comments/999/replies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'thanks' }),
      }),
    )
    expect(replyRes.status).toBe(200)
    let after = await prStore.get()
    expect(after?.pendingOptimisticReplyIds).toContain(5003)

    // Step 2 — sync with fresh GitHub data that NOW includes reply 5003
    const freshReplies: PrExistingReply[] = [
      {
        id: 5001,
        author: { login: 'reviewer' },
        body: 'first reply',
        createdAt: '2026-01-02T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 5002,
        author: { login: 'author' },
        body: 'second reply',
        createdAt: '2026-01-03T00:00:00.000Z',
        updatedAt: '2026-01-03T00:00:00.000Z',
      },
      {
        id: 5003,
        author: { login: 'me' },
        body: 'thanks',
        createdAt: '2026-07-21T12:00:00.000Z',
        updatedAt: '2026-07-21T12:00:00.000Z',
      },
    ]
    githubMocks.fetchExistingComments.mockResolvedValue([
      { ...fileLevelLead, replies: freshReplies },
    ])

    const syncRes = await app.fetch(
      new Request('http://localhost/api/gh/comments/sync', { method: 'POST' }),
    )
    expect(syncRes.status).toBe(200)

    // Step 3 — fresh GitHub data includes reply 5003 → it is confirmed and
    // the pending list is cleared. No duplication occurs.
    after = await prStore.get()
    expect(after?.existingComments[0].replies).toHaveLength(3)
    expect(after?.existingComments[0].replies[2].id).toBe(5003)
    expect(after?.existingComments[0].replies[2].body).toBe('thanks')
    // The optimistic id is no longer pending because GitHub confirmed it
    expect(after?.pendingOptimisticReplyIds).toBeUndefined()
  })

  // ── Test 7 ──────────────────────────────────────────────────────────────
  it('7: file-level: optimistic merge preserves unrelated session.comments drafts', async () => {
    const sessionWithDraft: PrSession = {
      ...fileLevelSession,
      comments: [
        {
          id: 'draft1',
          filePath: 'src/x.ts',
          side: 'additions',
          lineNumber: 1,
          lineContent: '+x',
          body: 'draft comment',
          status: 'open',
          createdAt: 1000,
          replies: [],
        },
      ],
    }
    await prStore.set(sessionWithDraft)

    const res = await app.fetch(
      new Request('http://localhost/api/gh/existing-comments/999/replies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: 'thanks' }),
      }),
    )
    expect(res.status).toBe(200)

    const after = await prStore.get()
    // Draft comments array is preserved
    expect(after?.comments).toHaveLength(1)
    expect(after?.comments[0].id).toBe('draft1')
    expect(after?.comments[0].body).toBe('draft comment')
    // existingComments still has the file-level thread with the new reply merged
    expect(after?.existingComments[0].replies).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// B. Unit tests for fetchExistingCommentsViaGh (real function, fake gh binary)
// ---------------------------------------------------------------------------
describe('fetchExistingCommentsViaGh unit tests', () => {
  // Helper to create a fake gh binary script
  // restResponse: JSON array returned for the REST comments endpoint
  // threadResponse: object for the GraphQL ReviewThreads response
  function makeGhScript(restResponse: unknown, threadResponse: unknown): string {
    const restJson = JSON.stringify(restResponse)
    const threadJson = JSON.stringify(threadResponse)
    return [
      '#!/usr/bin/env node',
      "const args = process.argv.slice(2).join(' ')",
      // REST comments endpoint (gh api repos/.../comments?per_page=100)
      "if (args.includes('?per_page=100')) {",
      `  process.stdout.write(JSON.stringify(${restJson}), () => process.exit(0));`,
      '}',
      // GraphQL endpoint (gh api graphql ...)
      "let body = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', chunk => { body += chunk });",
      "process.stdin.on('end', () => {",
      '  try {',
      '    const req = JSON.parse(body);',
      "    if (req.query && req.query.includes('query ReviewThreads')) {",
      `      process.stdout.write(JSON.stringify(${threadJson}), () => process.exit(0));`,
      '    } else {',
      "      process.stderr.write('Unexpected GraphQL query');",
      '      process.exit(1);',
      '    }',
      '  } catch (e) {',
      '    process.stderr.write(e.message);',
      '    process.exit(1);',
      '  }',
      '});',
    ].join('\n')
  }

  const resolved = { owner: 'acme', repo: 'widget', pullNumber: 42, ref: '42' }

  // ── Test 8 ──────────────────────────────────────────────────────────────
  it('8: file-level thread lead + 2 replies groups correctly', async () => {
    const lead = {
      id: 999,
      path: 'src/a.ts',
      line: null,
      side: null,
      body: 'file note',
      user: { login: 'reviewer' },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      pull_request_review_id: 55,
      position: null,
      original_position: null,
    }
    const reply1 = {
      id: 5001,
      in_reply_to_id: 999,
      path: 'src/a.ts',
      line: null,
      side: null,
      body: 'reply1',
      user: { login: 'reviewer' },
      created_at: '2026-01-02T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      position: null,
      original_position: null,
    }
    const reply2 = {
      id: 5002,
      in_reply_to_id: 999,
      path: 'src/a.ts',
      line: null,
      side: null,
      body: 'reply2',
      user: { login: 'author' },
      created_at: '2026-01-03T00:00:00.000Z',
      updated_at: '2026-01-03T00:00:00.000Z',
      position: null,
      original_position: null,
    }

    const threadResponse = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: 'PRRT_x',
                  isResolved: false,
                  viewerCanResolve: true,
                  viewerCanUnresolve: true,
                  comments: {
                    nodes: [
                      { databaseId: 999, viewerDidAuthor: false },
                      { databaseId: 5001, viewerDidAuthor: false },
                      { databaseId: 5002, viewerDidAuthor: false },
                    ],
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    }

    const script = makeGhScript([lead, reply1, reply2], threadResponse)
    const binDir = await mkdtemp(join(tmpdir(), 'diffing-test-gh-'))
    const originalPath = process.env.PATH ?? ''
    try {
      const ghPath = join(binDir, 'gh')
      await writeFile(ghPath, script, 'utf8')
      await chmod(ghPath, 0o755)
      process.env.PATH = `${binDir}:${originalPath}`

      const { fetchExistingCommentsViaGh } = await vi.importActual<
        typeof import('../lib/github.js')
      >('../lib/github.js')
      const result = await fetchExistingCommentsViaGh(resolved, [])

      expect(result).toHaveLength(1)
      expect(result[0].id).toBe(999)
      expect(result[0].line).toBeNull()
      expect(result[0].side).toBeNull()
      expect(result[0].threadId).toBe('PRRT_x')
      expect(result[0].isOutdated).toBe(false)
      expect(result[0].isResolved).toBe(false)
      expect(result[0].replies).toHaveLength(2)
      expect(result[0].replies[0].id).toBe(5001)
      expect(result[0].replies[1].id).toBe(5002)
      expect(result[0].replies[0].body).toBe('reply1')
      expect(result[0].replies[1].body).toBe('reply2')
    } finally {
      process.env.PATH = originalPath
      await rm(binDir, { recursive: true, force: true })
    }
  })

  // ── Test 9 ──────────────────────────────────────────────────────────────
  it('9: reply whose in_reply_to_id is NOT in response — orphaned reply silently dropped', async () => {
    // Only the reply is returned; the lead (id 99999) is missing
    const orphanReply = {
      id: 5001,
      in_reply_to_id: 99999,
      path: 'src/a.ts',
      line: null,
      side: null,
      body: 'orphan',
      user: { login: 'reviewer' },
      created_at: '2026-01-02T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      position: null,
      original_position: null,
    }

    const threadResponse = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          },
        },
      },
    }

    const script = makeGhScript([orphanReply], threadResponse)
    const binDir = await mkdtemp(join(tmpdir(), 'diffing-test-gh-'))
    const originalPath = process.env.PATH ?? ''
    try {
      const ghPath = join(binDir, 'gh')
      await writeFile(ghPath, script, 'utf8')
      await chmod(ghPath, 0o755)
      process.env.PATH = `${binDir}:${originalPath}`

      const { fetchExistingCommentsViaGh } = await vi.importActual<
        typeof import('../lib/github.js')
      >('../lib/github.js')

      // Orphaned reply has no parent — it is skipped. Result is empty.
      // Using resolves to verify the function did not throw (e.g. from a
      // truncated / unflushed fake-gh stdout race) — the empty result comes
      // from the grouping logic, not a catch-block fallback.
      await expect(fetchExistingCommentsViaGh(resolved, [])).resolves.toEqual([])
    } finally {
      process.env.PATH = originalPath
      await rm(binDir, { recursive: true, force: true })
    }
  })

  // ── Test 10 ─────────────────────────────────────────────────────────────
  it('10: file-level thread replies with null line are not split into separate tops', async () => {
    const lead = {
      id: 999,
      path: 'src/a.ts',
      line: null,
      side: null,
      body: 'file note',
      user: { login: 'reviewer' },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      pull_request_review_id: 55,
      position: null,
      original_position: null,
    }
    // Replies also have line: null (as GitHub returns them)
    const reply1 = {
      id: 5001,
      in_reply_to_id: 999,
      path: 'src/a.ts',
      line: null,
      side: null,
      body: 'reply1',
      user: { login: 'reviewer' },
      created_at: '2026-01-02T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      position: null,
      original_position: null,
    }
    const reply2 = {
      id: 5002,
      in_reply_to_id: 999,
      path: 'src/a.ts',
      line: null,
      side: null,
      body: 'reply2',
      user: { login: 'author' },
      created_at: '2026-01-03T00:00:00.000Z',
      updated_at: '2026-01-03T00:00:00.000Z',
      position: null,
      original_position: null,
    }

    const threadResponse = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: 'PRRT_x',
                  isResolved: false,
                  viewerCanResolve: true,
                  viewerCanUnresolve: true,
                  comments: {
                    nodes: [
                      { databaseId: 999, viewerDidAuthor: false },
                      { databaseId: 5001, viewerDidAuthor: false },
                      { databaseId: 5002, viewerDidAuthor: false },
                    ],
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    }

    const script = makeGhScript([lead, reply1, reply2], threadResponse)
    const binDir = await mkdtemp(join(tmpdir(), 'diffing-test-gh-'))
    const originalPath = process.env.PATH ?? ''
    try {
      const ghPath = join(binDir, 'gh')
      await writeFile(ghPath, script, 'utf8')
      await chmod(ghPath, 0o755)
      process.env.PATH = `${binDir}:${originalPath}`

      const { fetchExistingCommentsViaGh } = await vi.importActual<
        typeof import('../lib/github.js')
      >('../lib/github.js')
      const result = await fetchExistingCommentsViaGh(resolved, [])

      // Only 1 top-level; replies nested under it via in_reply_to_id
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe(999)
      expect(result[0].line).toBeNull()
      expect(result[0].replies).toHaveLength(2)
      expect(result[0].replies[0].id).toBe(5001)
      expect(result[0].replies[1].id).toBe(5002)
    } finally {
      process.env.PATH = originalPath
      await rm(binDir, { recursive: true, force: true })
    }
  })

  // ── Test 10b (variant) ──────────────────────────────────────────────────
  it('10b: replies with non-null line still group under file-level lead via in_reply_to_id', async () => {
    const lead = {
      id: 999,
      path: 'src/a.ts',
      line: null,
      side: null,
      body: 'file note',
      user: { login: 'reviewer' },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      pull_request_review_id: 55,
      position: null,
      original_position: null,
    }
    // Replies have non-null line/side (common on GitHub — they inherit the
    // thread anchor but some API versions populate it from the thread)
    const reply1 = {
      id: 5001,
      in_reply_to_id: 999,
      path: 'src/a.ts',
      line: 10,
      side: 'RIGHT',
      body: 'reply1',
      user: { login: 'reviewer' },
      created_at: '2026-01-02T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      position: null,
      original_position: null,
    }
    const reply2 = {
      id: 5002,
      in_reply_to_id: 999,
      path: 'src/a.ts',
      line: 10,
      side: 'RIGHT',
      body: 'reply2',
      user: { login: 'author' },
      created_at: '2026-01-03T00:00:00.000Z',
      updated_at: '2026-01-03T00:00:00.000Z',
      position: null,
      original_position: null,
    }

    const threadResponse = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: 'PRRT_x',
                  isResolved: false,
                  viewerCanResolve: true,
                  viewerCanUnresolve: true,
                  comments: {
                    nodes: [
                      { databaseId: 999, viewerDidAuthor: false },
                      { databaseId: 5001, viewerDidAuthor: false },
                      { databaseId: 5002, viewerDidAuthor: false },
                    ],
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    }

    const script = makeGhScript([lead, reply1, reply2], threadResponse)
    const binDir = await mkdtemp(join(tmpdir(), 'diffing-test-gh-'))
    const originalPath = process.env.PATH ?? ''
    try {
      const ghPath = join(binDir, 'gh')
      await writeFile(ghPath, script, 'utf8')
      await chmod(ghPath, 0o755)
      process.env.PATH = `${binDir}:${originalPath}`

      const { fetchExistingCommentsViaGh } = await vi.importActual<
        typeof import('../lib/github.js')
      >('../lib/github.js')
      const result = await fetchExistingCommentsViaGh(resolved, [])

      // Despite replies having non-null line, they group under the lead via
      // in_reply_to_id — they do NOT become separate tops
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe(999)
      expect(result[0].replies).toHaveLength(2)
    } finally {
      process.env.PATH = originalPath
      await rm(binDir, { recursive: true, force: true })
    }
  })

  // ── Test 11 ─────────────────────────────────────────────────────────────
  it('11: pagination across many comments keeps file-level thread intact', async () => {
    // Generate 1000 comments; lead at index 5, replies at indices 200 and 700
    const allComments: any[] = []
    for (let i = 0; i < 1000; i++) {
      allComments.push({
        id: 1000 + i,
        path: `src/file${Math.floor(i / 100)}.ts`,
        line: i % 50 === 0 ? null : (i % 100) + 1,
        side: i % 2 === 0 ? 'RIGHT' : 'LEFT',
        body: `comment ${i}`,
        user: { login: `user${i % 5}` },
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        pull_request_review_id: i < 500 ? 55 : 56,
        position: null,
        original_position: null,
      })
    }
    // Insert the file-level thread at specific positions
    const lead = {
      id: 999,
      path: 'src/a.ts',
      line: null,
      side: null,
      body: 'file note',
      user: { login: 'reviewer' },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      pull_request_review_id: 55,
      position: null,
      original_position: null,
    }
    const reply1 = {
      id: 5001,
      in_reply_to_id: 999,
      path: 'src/a.ts',
      line: null,
      side: null,
      body: 'reply1',
      user: { login: 'reviewer' },
      created_at: '2026-01-02T00:00:00.000Z',
      updated_at: '2026-01-02T00:00:00.000Z',
      position: null,
      original_position: null,
    }
    const reply2 = {
      id: 5002,
      in_reply_to_id: 999,
      path: 'src/a.ts',
      line: null,
      side: null,
      body: 'reply2',
      user: { login: 'author' },
      created_at: '2026-01-03T00:00:00.000Z',
      updated_at: '2026-01-03T00:00:00.000Z',
      position: null,
      original_position: null,
    }
    // Place lead at index 5, reply1 at 200, reply2 at 700
    allComments.splice(5, 0, lead)
    allComments.splice(200, 0, reply1)
    allComments.splice(700, 0, reply2)

    const threadResponse = {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: 'PRRT_x',
                  isResolved: false,
                  viewerCanResolve: true,
                  viewerCanUnresolve: true,
                  comments: {
                    nodes: [
                      { databaseId: 999, viewerDidAuthor: false },
                      { databaseId: 5001, viewerDidAuthor: false },
                      { databaseId: 5002, viewerDidAuthor: false },
                    ],
                  },
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      },
    }

    const script = makeGhScript(allComments, threadResponse)
    const binDir = await mkdtemp(join(tmpdir(), 'diffing-test-gh-'))
    const originalPath = process.env.PATH ?? ''
    try {
      const ghPath = join(binDir, 'gh')
      await writeFile(ghPath, script, 'utf8')
      await chmod(ghPath, 0o755)
      process.env.PATH = `${binDir}:${originalPath}`

      const { fetchExistingCommentsViaGh } = await vi.importActual<
        typeof import('../lib/github.js')
      >('../lib/github.js')
      const result = await fetchExistingCommentsViaGh(resolved, [])

      // The file-level thread with 3 items is intact
      const fileLevelThread = result.find((c) => c.id === 999)
      expect(fileLevelThread).toBeDefined()
      expect(fileLevelThread!.replies).toHaveLength(2)
      expect(fileLevelThread!.replies[0].id).toBe(5001)
      expect(fileLevelThread!.replies[1].id).toBe(5002)

      // Verify total count includes the file-level lead and other tops
      // (all non-file-level items that have no in_reply_to_id)
      const totalTops = allComments.filter((c: any) => !c.in_reply_to_id).length
      expect(result).toHaveLength(totalTops)
    } finally {
      process.env.PATH = originalPath
      await rm(binDir, { recursive: true, force: true })
    }
  })
})
