import { authorHue, authorInitials } from "@/lib/git-format";
import { cn } from "@/lib/utils";

interface GitAvatarProps {
  name: string;
  email: string;
  /** 一覧は sm (18px)、詳細は md (28px) */
  size?: "sm" | "md";
}

/** 作者の頭文字の丸。色は作者ごとに決まる (明暗どちらでも白い字が読める濃さ) */
export function GitAvatar({ name, email, size = "sm" }: GitAvatarProps) {
  return (
    <span
      data-testid="git-avatar"
      title={email ? `${name} <${email}>` : name}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white",
        size === "sm" ? "size-[18px] text-[9px]" : "size-7 text-[12px]"
      )}
      style={{ backgroundColor: `oklch(0.58 0.13 ${authorHue(email, name)})` }}
    >
      {authorInitials(name)}
    </span>
  );
}
