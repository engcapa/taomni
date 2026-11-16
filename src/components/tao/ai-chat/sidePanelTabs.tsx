import { Archive, BookOpen, BrainCircuit, FileText, Files, PackageOpen, Volume2, WandSparkles, Workflow } from "lucide-react";

const panels = {
  "来源": { id: "sources", Icon: BookOpen },
  "文件": { id: "files", Icon: Files },
  "生成物": { id: "artifacts", Icon: PackageOpen },
  "工作流": { id: "workflows", Icon: Workflow },
  "语音": { id: "voice", Icon: Volume2 },
  "导入导出": { id: "archive", Icon: Archive },
  "记忆": { id: "memory", Icon: BrainCircuit },
  "技能": { id: "skills", Icon: WandSparkles },
};

export function sidePanelTab(panel: string) {
  return panels[panel as keyof typeof panels] ?? { id: "other", Icon: FileText };
}
