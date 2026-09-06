import type { ReviewComment } from '../../lib/types'

export async function readCommentResponse(res: Response): Promise<ReviewComment> {
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error || `Could not save comment (HTTP ${res.status})`)
  if (
    !data ||
    typeof data.id !== 'string' ||
    typeof data.body !== 'string' ||
    typeof data.filePath !== 'string'
  ) {
    throw new Error('Invalid comment response')
  }
  return data as ReviewComment
}
