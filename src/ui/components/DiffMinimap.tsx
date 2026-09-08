import { useMemo, useCallback, memo, useState } from "react";
import { scrollBehavior } from "../lib/motion.js";
import type { FileDiffMetadata } from "@pierre/diffs";
import { Map as MapIcon } from "lucide-react";
import { Tooltip } from "../primitives/Tooltip";

export interface MinimapSegment {
  /** 0–1 start of this block within the map height */
  start: number;
  /** 0–1 height of this block */
  height: number;
  kind: "add" | "del" | "change";
  /** Approximate line number to scroll to (new side preferred) */
  line: number;
  /** 1-based hunk index for labels */
  index: number;
  additions: number;
  deletions: number;
  /** Human-readable line range label, e.g. L12–18 */
  rangeLabel: string;
}

/**
 * Build density segments from a file's hunks for a clickable minimap.
 * Pure + exported for unit tests.
 */
export function buildMinimapSegments(
  fileDiff: FileDiffMetadata,
): MinimapSegment[] {
  const hunks = fileDiff.hunks ?? [];
  if (hunks.length === 0) return [];

  const weights = hunks.map((h) => {
    const adds = h.additionCount ?? h.additionLines ?? 0;
    const dels = h.deletionCount ?? h.deletionLines ?? 0;
    return Math.max(1, adds + dels);
  });
  const total = weights.reduce((a, b) => a + b, 0) || 1;

  let cursor = 0;
  return hunks.map((h, i) => {
    const adds = h.additionLines ?? h.additionCount ?? 0;
    const dels = h.deletionLines ?? h.deletionCount ?? 0;
    const newLineCount = h.additionCount ?? adds;
    const oldLineCount = h.deletionCount ?? dels;
    const height = weights[i] / total;
    const start = cursor;
    cursor += height;
    let kind: MinimapSegment["kind"] = "change";
    if (adds > 0 && dels === 0) kind = "add";
    else if (dels > 0 && adds === 0) kind = "del";

    const addStart = h.additionStart || 0;
    const delStart = h.deletionStart || 0;
    const line = addStart || delStart || 1;
    const rangeEnd =
      addStart && newLineCount > 0
        ? addStart + Math.max(0, newLineCount - 1)
        : delStart && oldLineCount > 0
          ? delStart + Math.max(0, oldLineCount - 1)
          : line;
    const rangeLabel = rangeEnd === line ? `L${line}` : `L${line}–${rangeEnd}`;

    return {
      start,
      height,
      kind,
      line,
      index: i + 1,
      additions: adds,
      deletions: dels,
      rangeLabel,
    };
  });
}

function kindLabel(kind: MinimapSegment["kind"]): string {
  if (kind === "add") return "Added";
  if (kind === "del") return "Removed";
  return "Modified";
}

function statsLabel(seg: MinimapSegment): string {
  const parts: string[] = [];
  if (seg.additions > 0) parts.push(`+${seg.additions}`);
  if (seg.deletions > 0) parts.push(`−${seg.deletions}`);
  return parts.join(" ") || "empty";
}

function tooltipContent(seg: MinimapSegment): string {
  return [
    `Hunk ${seg.index}`,
    kindLabel(seg.kind),
    statsLabel(seg),
    seg.rangeLabel,
    "Click to jump",
  ].join(" · ");
}

interface DiffMinimapProps {
  fileDiff: FileDiffMetadata;
  filePath: string;
  /** Called when the user clicks a segment (scroll target). */
  onJump?: (filePath: string, line: number) => void;
}

/**
 * Hybrid change map:
 * - Horizontal header: title, totals, legend, live hover detail (clear copy)
 * - Vertical density bar: colored hunk blocks with tooltips (click to jump)
 */
export const DiffMinimap = memo(function DiffMinimap({
  fileDiff,
  filePath,
  onJump,
}: DiffMinimapProps) {
  const segments = useMemo(() => buildMinimapSegments(fileDiff), [fileDiff]);
  const [hovered, setHovered] = useState<number | null>(null);
  const [active, setActive] = useState<number | null>(null);

  const totals = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    for (const s of segments) {
      additions += s.additions;
      deletions += s.deletions;
    }
    return { additions, deletions, hunks: segments.length };
  }, [segments]);

  const handleJump = useCallback(
    (seg: MinimapSegment) => {
      setActive(seg.index);
      if (onJump) {
        onJump(filePath, seg.line);
        return;
      }
      const card =
        document.getElementById(`file-${CSS.escape(filePath)}`) ??
        document.querySelector(`[data-file-path="${CSS.escape(filePath)}"]`);
      card?.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
    },
    [filePath, onJump],
  );

  if (segments.length === 0) return null;

  const tipSeg =
    hovered == null ? null : segments.find((s) => s.index === hovered);

  return (
    <>
      {/* Horizontal clarity strip — title, stats, legend, live detail */}
      <div
        className="diff-minimap-header"
        role="region"
        aria-label={`Change map for ${filePath}`}
      >
        <div className="diff-minimap-meta">
          <span className="diff-minimap-title">
            <MapIcon size={12} aria-hidden="true" />
            Change map
          </span>
          <span className="diff-minimap-summary">
            {totals.hunks} hunk{totals.hunks === 1 ? "" : "s"}
            {totals.additions > 0 && (
              <span className="diff-minimap-stat-add">
                {" "}
                +{totals.additions}
              </span>
            )}
            {totals.deletions > 0 && (
              <span className="diff-minimap-stat-del">
                {" "}
                −{totals.deletions}
              </span>
            )}
          </span>
          <span className="diff-minimap-hint">
            Hover the bar on the right · Click to jump
          </span>
        </div>
        <div className="diff-minimap-footer">
          <div className="diff-minimap-legend" aria-hidden="true">
            <span className="diff-minimap-legend-item">
              <i className="diff-minimap-dot diff-minimap-dot-add" /> Added
            </span>
            <span className="diff-minimap-legend-item">
              <i className="diff-minimap-dot diff-minimap-dot-del" /> Removed
            </span>
            <span className="diff-minimap-legend-item">
              <i className="diff-minimap-dot diff-minimap-dot-change" />{" "}
              Modified
            </span>
          </div>
          {tipSeg ? (
            <div className="diff-minimap-live" aria-live="polite">
              <strong>#{tipSeg.index}</strong>
              <span>{kindLabel(tipSeg.kind)}</span>
              <span className="diff-minimap-live-stats">
                {statsLabel(tipSeg)}
              </span>
              <span className="diff-minimap-live-range">
                {tipSeg.rangeLabel}
              </span>
            </div>
          ) : (
            <div className="diff-minimap-live diff-minimap-live-idle">
              Hover a block for details
            </div>
          )}
        </div>
      </div>

      {/* Vertical density bar — the actual interactive map */}
      <div
        className="diff-minimap"
        role="navigation"
        aria-label={`Jump to changes in ${filePath}`}
      >
        <div className="diff-minimap-track" role="list">
          {segments.map((seg) => {
            const isHot = hovered === seg.index || active === seg.index;
            return (
              <Tooltip
                key={seg.index}
                content={tooltipContent(seg)}
                side="left"
              >
                <button
                  type="button"
                  role="listitem"
                  className={[
                    "diff-minimap-seg",
                    `diff-minimap-seg-${seg.kind}`,
                    isHot ? "diff-minimap-seg-hot" : "",
                    active === seg.index ? "diff-minimap-seg-active" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{
                    top: `${seg.start * 100}%`,
                    height: `${Math.max(seg.height * 100, 3)}%`,
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleJump(seg);
                  }}
                  onMouseEnter={() => setHovered(seg.index)}
                  onMouseLeave={() => setHovered(null)}
                  onFocus={() => setHovered(seg.index)}
                  onBlur={() => setHovered(null)}
                  aria-label={tooltipContent(seg)}
                />
              </Tooltip>
            );
          })}
        </div>
      </div>
    </>
  );
});
