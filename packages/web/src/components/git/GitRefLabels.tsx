import type { GitRef } from "@ark/shared";
import { Archive, Check, Cloud, Tag } from "lucide-react";
import { cn } from "@/lib/utils";

const KIND_ORDER: Record<GitRef["kind"], number> = {
  head: 0,
  branch: 1,
  remote: 2,
  tag: 3,
  stash: 4,
};

/** いまのブランチ → ローカル → リモート → タグ → スタッシュ の順に並べる */
export function sortRefs(refs: readonly GitRef[]): GitRef[] {
  return [...refs].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

const BASE =
  "inline-flex h-[18px] max-w-[160px] shrink-0 items-center gap-1 rounded-[4px] border px-1.5 text-[11px] leading-none";

interface GitRefLabelProps {
  gitRef: GitRef;
  /** ローカルブランチの札の色 (そのコミットのレーンの色) */
  color?: string;
}

/** ref の札 1 枚。種類を色と印で分ける */
export function GitRefLabel({ gitRef, color }: GitRefLabelProps) {
  const { kind, name } = gitRef;
  const text = <span className="truncate">{name}</span>;
  if (kind === "head") {
    return (
      <span
        data-ref-kind={kind}
        title={`${name} (いまのブランチ)`}
        className={cn(
          BASE,
          "border-primary bg-primary font-semibold text-primary-foreground"
        )}
      >
        <Check className="size-3 shrink-0" strokeWidth={3} aria-hidden="true" />
        {text}
      </span>
    );
  }
  if (kind === "branch") {
    const lane = color ?? "var(--git-lane-0)";
    return (
      <span
        data-ref-kind={kind}
        title={name}
        className={cn(BASE, "font-medium")}
        style={{
          borderColor: lane,
          color: lane,
          backgroundColor: `color-mix(in oklch, ${lane} 10%, transparent)`,
        }}
      >
        {text}
      </span>
    );
  }
  if (kind === "remote") {
    return (
      <span
        data-ref-kind={kind}
        title={name}
        className={cn(BASE, "border-border bg-muted text-muted-foreground")}
      >
        <Cloud className="size-3 shrink-0" aria-hidden="true" />
        {text}
      </span>
    );
  }
  if (kind === "tag") {
    return (
      <span
        data-ref-kind={kind}
        title={name}
        className={cn(
          BASE,
          "border-amber-500/50 bg-amber-500/15 text-amber-700 dark:text-amber-300"
        )}
      >
        <Tag className="size-3 shrink-0" aria-hidden="true" />
        {text}
      </span>
    );
  }
  return (
    <span
      data-ref-kind={kind}
      title={name}
      className={cn(
        BASE,
        "border-border border-dashed bg-transparent text-muted-foreground"
      )}
    >
      <Archive className="size-3 shrink-0" aria-hidden="true" />
      {text}
    </span>
  );
}

interface GitRefLabelsProps {
  refs: readonly GitRef[];
  color?: string;
  /** これを超えたら、先頭の (max - 1) 枚と「+n」にまとめる。未指定は全部出す */
  max?: number;
}

/** ref の札の並び。多すぎるときは「+n」にまとめ、title に全部を出す */
export function GitRefLabels({ refs, color, max }: GitRefLabelsProps) {
  if (refs.length === 0) return null;
  const sorted = sortRefs(refs);
  const overflow = max !== undefined && sorted.length > max;
  const shown = overflow ? sorted.slice(0, max - 1) : sorted;
  return (
    <>
      {shown.map(r => (
        <GitRefLabel key={`${r.kind}:${r.name}`} gitRef={r} color={color} />
      ))}
      {overflow && (
        <span
          data-ref-kind="more"
          title={sorted.map(r => r.name).join("\n")}
          className={cn(BASE, "border-border bg-muted text-muted-foreground")}
        >
          +{sorted.length - shown.length}
        </span>
      )}
    </>
  );
}
