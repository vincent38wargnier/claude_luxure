import { useState, useEffect, useCallback } from "react";
import { X, Plus, Save, Trash2, ExternalLink } from "lucide-react";
import type { SkillInfo, SkillScope } from "../../types";
import SkillListItem from "./SkillListItem";

interface SkillsPanelProps {
  open: boolean;
  skills: SkillInfo[];
  selectedSkillId: string | null;
  editorContent: string;
  dirty: boolean;
  error: string | null;
  savedFlash: boolean;
  hasWorkspace: boolean;
  onClose: () => void;
  onSelectSkill: (skillId: string) => void;
  onEditorChange: (content: string) => void;
  onListSkills: () => void;
  onSave: () => void;
  onDelete: () => void;
  onCreate: (scope: SkillScope, name: string) => void;
  onOpenInEditor: (filePath: string) => void;
}

function groupByScope(skills: SkillInfo[]) {
  return {
    global: skills.filter((s) => s.scope === "global"),
    project: skills.filter((s) => s.scope === "project"),
  };
}

export default function SkillsPanel({
  open,
  skills,
  selectedSkillId,
  editorContent,
  dirty,
  error,
  savedFlash,
  hasWorkspace,
  onClose,
  onSelectSkill,
  onEditorChange,
  onListSkills,
  onSave,
  onDelete,
  onCreate,
  onOpenInEditor,
}: SkillsPanelProps) {
  const [createScope, setCreateScope] = useState<SkillScope>("global");
  const [createName, setCreateName] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    if (open) {
      onListSkills();
    }
  }, [open, onListSkills]);

  const selectedSkill = skills.find((s) => s.id === selectedSkillId);

  const handleCreate = useCallback(() => {
    const name = createName.trim().toLowerCase();
    if (!name) return;
    onCreate(createScope, name);
    setCreateName("");
    setShowCreate(false);
  }, [createScope, createName, onCreate]);

  if (!open) {
    return null;
  }

  const { global: globalSkills, project: projectSkills } = groupByScope(skills);

  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-vscode-bg">
      <div className="flex items-center justify-between px-3 py-2 border-b border-[rgba(255,255,255,0.06)] shrink-0">
        <h2 className="text-sm font-medium text-vscode-fg">Skills</h2>
        <button
          type="button"
          onClick={onClose}
          className="p-1 rounded opacity-60 hover:opacity-100 text-vscode-fg transition-opacity"
          title="Close"
        >
          <X size={16} />
        </button>
      </div>

      {error && (
        <div className="px-3 py-2 text-xs text-[#f87171] bg-[rgba(248,113,113,0.08)] border-b border-[rgba(248,113,113,0.15)]">
          {error}
        </div>
      )}

      {savedFlash && (
        <div className="px-3 py-1.5 text-xs text-[#4ade80] bg-[rgba(34,197,94,0.08)] border-b border-[rgba(34,197,94,0.12)]">
          Saved
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        <div className="w-[200px] shrink-0 border-r border-[rgba(255,255,255,0.06)] flex flex-col min-h-0">
          <div className="p-2 border-b border-[rgba(255,255,255,0.04)]">
            <button
              type="button"
              onClick={() => setShowCreate((v) => !v)}
              className="flex items-center gap-1 w-full px-2 py-1.5 text-xs rounded bg-vscode-buttonBg text-vscode-buttonFg hover:bg-vscode-buttonHover transition-colors"
            >
              <Plus size={12} />
              New skill
            </button>
          </div>

          {showCreate && (
            <div className="p-2 border-b border-[rgba(255,255,255,0.04)] space-y-2">
              <select
                value={createScope}
                onChange={(e) =>
                  setCreateScope(e.target.value as SkillScope)
                }
                className="w-full text-xs px-2 py-1 rounded bg-vscode-inputBg text-vscode-fg border border-vscode-border"
                disabled={createScope === "project" && !hasWorkspace}
              >
                <option value="global">Global (~/.claude/skills)</option>
                <option value="project" disabled={!hasWorkspace}>
                  Project (.claude/skills)
                </option>
              </select>
              <input
                type="text"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="skill-name"
                className="w-full text-xs px-2 py-1 rounded bg-vscode-inputBg text-vscode-fg border border-vscode-border"
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                }}
              />
              <button
                type="button"
                onClick={handleCreate}
                disabled={!createName.trim()}
                className="w-full text-xs px-2 py-1 rounded bg-vscode-buttonBg text-vscode-buttonFg disabled:opacity-40"
              >
                Create
              </button>
            </div>
          )}

          <div className="flex-1 overflow-y-auto p-1 space-y-3">
            <div>
              <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-vscode-descriptionFg opacity-60">
                Global
              </p>
              {globalSkills.length === 0 ? (
                <p className="px-2 text-[10px] text-vscode-descriptionFg opacity-50">
                  No global skills
                </p>
              ) : (
                globalSkills.map((skill) => (
                  <SkillListItem
                    key={skill.id}
                    skill={skill}
                    selected={skill.id === selectedSkillId}
                    onSelect={() => onSelectSkill(skill.id)}
                  />
                ))
              )}
            </div>

            {hasWorkspace && (
              <div>
                <p className="px-2 py-1 text-[10px] uppercase tracking-wide text-vscode-descriptionFg opacity-60">
                  Project
                </p>
                {projectSkills.length === 0 ? (
                  <p className="px-2 text-[10px] text-vscode-descriptionFg opacity-50">
                    No project skills
                  </p>
                ) : (
                  projectSkills.map((skill) => (
                    <SkillListItem
                      key={skill.id}
                      skill={skill}
                      selected={skill.id === selectedSkillId}
                      onSelect={() => onSelectSkill(skill.id)}
                    />
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex-1 flex flex-col min-w-0 min-h-0">
          {selectedSkill ? (
            <>
              <div className="flex items-center justify-between px-3 py-2 border-b border-[rgba(255,255,255,0.04)] shrink-0 gap-2">
                <div className="min-w-0">
                  <span className="text-xs font-medium">{selectedSkill.command}</span>
                  {dirty && (
                    <span className="ml-2 text-[10px] text-[#f59e0b]">unsaved</span>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    type="button"
                    onClick={() => onOpenInEditor(selectedSkill.path)}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] rounded text-vscode-descriptionFg hover:text-vscode-fg transition-colors"
                    title="Open in VS Code editor"
                  >
                    <ExternalLink size={12} />
                    Open
                  </button>
                  <button
                    type="button"
                    onClick={onSave}
                    disabled={!dirty}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] rounded bg-vscode-buttonBg text-vscode-buttonFg disabled:opacity-40"
                  >
                    <Save size={12} />
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={onDelete}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] rounded text-[#f87171] hover:bg-[rgba(248,113,113,0.1)] transition-colors"
                  >
                    <Trash2 size={12} />
                    Delete
                  </button>
                </div>
              </div>
              <textarea
                value={editorContent}
                onChange={(e) => onEditorChange(e.target.value)}
                spellCheck={false}
                className="flex-1 w-full p-3 text-xs font-mono leading-relaxed resize-none bg-transparent text-vscode-fg outline-none min-h-0"
                placeholder="SKILL.md content..."
              />
            </>
          ) : (
            <div className="flex-1 flex items-center justify-center text-xs text-vscode-descriptionFg opacity-50">
              Select a skill or create a new one
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
