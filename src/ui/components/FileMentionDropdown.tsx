import { useRef, useEffect } from "react";
import { FileText } from "lucide-react";
import type { FileHit } from "../lib/searchTypes";
import type { MatchRange } from "../lib/searchTypes";

function subsequenceRanges(text: string, query: string): MatchRange[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const t = text.toLowerCase();
  const ranges: MatchRange[] = [];
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      const last = ranges[ranges.length - 1];
      if (last && last[1] === ti) last[1] = ti + 1;
      else ranges.push([ti, ti + 1]);
      qi++;
    }
  }
  return qi === q.length ? ranges : [];
}

function Highlight({ text, ranges }: { text: string; ranges: MatchRange[] }) {
  if (!ranges.length) return <>{text}</>;
  const out: React.ReactNode[] = [];
  let last = 0;
  ranges.forEach(([s, e], i) => {
    if (s > last) out.push(text.slice(last, s));
    out.push(
      <mark key={i} className="mention-highlight">
        {text.slice(s, e)}
      </mark>,
    );
    last = e;
  });
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}

const dir = (path: string) => {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i + 1);
};

const fileName = (path: string) => {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
};

interface FileMentionDropdownProps {
  results: FileHit[];
  focusedIndex: number;
  query: string;
  cursorTop: number;
  onSelect: (path: string) => void;
  onHover: (index: number) => void;
}

export function FileMentionDropdown({
  results,
  focusedIndex,
  query,
  cursorTop,
  onSelect,
  onHover,
}: FileMentionDropdownProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>('[data-focused="true"]');
    if (!list || !el) return;
    const item = el.getBoundingClientRect();
    const viewport = list.getBoundingClientRect();
    if (item.top < viewport.top) list.scrollTop += item.top - viewport.top;
    else if (item.bottom > viewport.bottom)
      list.scrollTop += item.bottom - viewport.bottom;
  }, [focusedIndex, results]);

  if (results.length === 0) return null;

  return (
    <div
      className="mention-dropdown"
      ref={listRef}
      role="listbox"
      aria-label="File suggestions"
      style={{ top: cursorTop }}
    >
      {results.map((hit, i) => {
        const name = fileName(hit.path);
        const ranges = subsequenceRanges(name, query);
        const focused = i === focusedIndex;
        return (
          <div
            key={hit.path}
            role="option"
            aria-selected={focused}
            data-focused={focused}
            className={`mention-item ${focused ? "mention-item-focused" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              onSelect(hit.path);
            }}
            onMouseEnter={() => onHover(i)}
          >
            <span className="mention-icon">
              <FileText size={13} />
            </span>
            <div className="mention-info">
              <span className="mention-name">
                <Highlight text={name} ranges={ranges} />
              </span>
              <span className="mention-dir">{dir(hit.path) || "./"}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
