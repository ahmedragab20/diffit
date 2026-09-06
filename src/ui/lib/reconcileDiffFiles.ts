import type { FileDiffMetadata } from '@pierre/diffs'

let revision = 0

function contentKey(file: FileDiffMetadata): string {
  const { cacheKey: _cacheKey, ...content } = file
  return JSON.stringify(content)
}

/** Reuse only identical render inputs, never just matching hunk geometry. */
export function reconcileDiffFiles(
  previous: FileDiffMetadata[],
  incoming: FileDiffMetadata[],
): FileDiffMetadata[] {
  const byName = new Map(previous.map((file) => [file.name, file]))
  return incoming.map((file) => {
    const prior = byName.get(file.name)
    if (prior && contentKey(prior) === contentKey(file)) return prior
    file.cacheKey = `review-diff:${++revision}`
    return file
  })
}
