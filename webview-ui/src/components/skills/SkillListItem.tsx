import type { SkillInfo } from "../../types";

interface SkillListItemProps {
  skill: SkillInfo;
  selected: boolean;
  onSelect: () => void;
}

export default function SkillListItem({
  skill,
  selected,
  onSelect,
}: SkillListItemProps) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left px-2.5 py-2 rounded transition-colors ${
        selected
          ? "bg-[rgba(59,130,246,0.15)] text-vscode-fg"
          : "hover:bg-[rgba(255,255,255,0.04)] text-vscode-fg"
      }`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs font-medium shrink-0">{skill.command}</span>
        <span
          className={`text-[9px] uppercase tracking-wide px-1 py-0.5 rounded shrink-0 ${
            skill.scope === "global"
              ? "bg-[rgba(139,92,246,0.2)] text-[#a78bfa]"
              : "bg-[rgba(34,197,94,0.15)] text-[#4ade80]"
          }`}
        >
          {skill.scope}
        </span>
      </div>
      {skill.description && (
        <p className="text-[10px] text-vscode-descriptionFg mt-0.5 line-clamp-2">
          {skill.description}
        </p>
      )}
      <p
        className="text-[9px] text-vscode-descriptionFg opacity-40 mt-0.5 truncate"
        title={skill.path}
      >
        {skill.path}
      </p>
    </button>
  );
}
