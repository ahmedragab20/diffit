import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  CircleDot,
  Clock3,
  ExternalLink,
  MinusCircle,
  RefreshCw,
  XCircle,
} from "lucide-react";
import { Popover } from "../primitives/Popover";

export interface PrCheck {
  name: string;
  state:
    | "success"
    | "failure"
    | "pending"
    | "neutral"
    | "error"
    | "skipped"
    | "cancelled"
    | "timed_out"
    | "action_required"
    | "unknown";
  conclusion?: string | null;
  detailsUrl?: string | null;
}

interface ChecksResponse {
  checks: PrCheck[];
  summary: {
    total: number;
    success: number;
    failure: number;
    pending: number;
  } | null;
  headSha?: string;
}

export function checksRefreshInterval(checks: PrCheck[]): number {
  return checks.some((check) => check.state === "pending") ? 8_000 : 30_000;
}

export function checksOverallTone(
  checks: PrCheck[],
): "failure" | "pending" | "success" | "neutral" {
  const success = checks.filter((check) => check.state === "success").length;
  const pending = checks.filter((check) => check.state === "pending").length;
  const failed = checks.filter((check) =>
    ["failure", "error", "timed_out", "action_required"].includes(check.state),
  ).length;
  if (failed > 0) return "failure";
  if (pending > 0) return "pending";
  if (success > 0) return "success";
  return "neutral";
}

function checkTone(state: PrCheck["state"]) {
  if (state === "success")
    return { icon: CheckCircle2, className: "is-success", label: "Succeeded" };
  if (state === "pending")
    return { icon: Clock3, className: "is-pending", label: "In progress" };
  if (
    state === "failure" ||
    state === "error" ||
    state === "timed_out" ||
    state === "action_required"
  ) {
    return {
      icon: XCircle,
      className: "is-failure",
      label: state === "timed_out" ? "Timed out" : "Failed",
    };
  }
  if (state === "skipped" || state === "cancelled" || state === "neutral") {
    return {
      icon: MinusCircle,
      className: "is-neutral",
      label:
        state === "cancelled"
          ? "Cancelled"
          : state === "skipped"
            ? "Skipped"
            : "Neutral",
    };
  }
  return { icon: CircleDot, className: "is-neutral", label: "Unknown" };
}

export function PrChecksPopover({ headSha }: { headSha: string }) {
  const query = useQuery<ChecksResponse>({
    queryKey: ["pr-checks", headSha],
    queryFn: async () => {
      const response = await fetch("/api/gh/checks");
      const data = (await response
        .json()
        .catch(() => ({}))) as ChecksResponse & { error?: string };
      if (!response.ok)
        throw new Error(data.error || `HTTP ${response.status}`);
      return data;
    },
    refetchInterval: (state) => {
      const checks = state.state.data?.checks ?? [];
      return checksRefreshInterval(checks);
    },
    refetchOnWindowFocus: true,
    staleTime: 5_000,
  });

  const checks = query.data?.checks ?? [];
  const success = checks.filter((check) => check.state === "success").length;
  const pending = checks.filter((check) => check.state === "pending").length;
  const failed = checks.filter((check) =>
    ["failure", "error", "timed_out", "action_required"].includes(check.state),
  ).length;
  const neutral = Math.max(0, checks.length - success - pending - failed);
  const overall = checksOverallTone(checks);
  const OverallIcon =
    overall === "failure"
      ? XCircle
      : overall === "pending"
        ? Clock3
        : overall === "success"
          ? CheckCircle2
          : CircleDot;

  return (
    <Popover
      ariaLabel="GitHub checks"
      className="pr-checks-popover"
      trigger={
        <button
          className={`toolbar-chip pr-checks-trigger is-${overall}`}
          title="Live GitHub checks and actions status"
          type="button"
        >
          <OverallIcon size={12} />
          <span>
            {query.isLoading
              ? "Loading checks…"
              : checks.length === 0
                ? "No checks"
                : failed > 0
                  ? `${failed} failing`
                  : pending > 0
                    ? `${pending} running`
                    : `${success}/${checks.length} passed`}
          </span>
        </button>
      }
    >
      <div className="pr-checks-panel">
        <div className="pr-checks-head">
          <div>
            <strong>Checks and actions</strong>
            <span>Live status for {headSha.slice(0, 7)}</span>
          </div>
          <button
            className="file-diff-icon-btn"
            onClick={() => query.refetch()}
            disabled={query.isFetching}
            aria-label="Refresh checks"
          >
            <RefreshCw
              size={13}
              className={query.isFetching ? "spinning" : ""}
            />
          </button>
        </div>

        {checks.length > 0 && (
          <div className="pr-checks-summary" aria-label="Checks summary">
            <span className="is-success">
              <CheckCircle2 size={12} /> {success} passed
            </span>
            <span className="is-failure">
              <XCircle size={12} /> {failed} failed
            </span>
            <span className="is-pending">
              <Clock3 size={12} /> {pending} running
            </span>
            {neutral > 0 && (
              <span className="is-neutral">
                <MinusCircle size={12} /> {neutral} other
              </span>
            )}
          </div>
        )}

        {query.isError ? (
          <div className="pr-checks-empty is-error">
            <AlertCircle size={15} /> {query.error.message}
          </div>
        ) : query.isLoading ? (
          <div className="pr-checks-empty">
            Loading the latest GitHub status…
          </div>
        ) : checks.length === 0 ? (
          <div className="pr-checks-empty">
            No checks are reported for this commit.
          </div>
        ) : (
          <ul className="pr-checks-list">
            {checks.map((check, index) => {
              const tone = checkTone(check.state);
              const Icon = tone.icon;
              return (
                <li key={`${check.name}-${index}`} className={tone.className}>
                  <Icon size={14} />
                  <span className="pr-checks-name">{check.name}</span>
                  <span className="pr-checks-state">{tone.label}</span>
                  {check.detailsUrl && (
                    <a
                      href={check.detailsUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open ${check.name} on GitHub`}
                    >
                      <ExternalLink size={12} />
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="pr-checks-foot">
          Updates every 8 seconds while work is running.
        </div>
      </div>
    </Popover>
  );
}
