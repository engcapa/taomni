import { answerLanguageLabelKey,type AiAnswerLanguage } from "../../../../lib/ai/answerLanguage";
import { type WorkspaceCommand } from "../workspaceCommands";
import { type WorkspaceCommandsContext } from "./types";


export type AiCommandsContext=Pick<WorkspaceCommandsContext,"t"|"activeFile"|"runEditorAiActionAtCursor"|"editorAiPreferences"|"cycleAiAnswerLanguage"|"setAiAnswerLanguage">;

export function createAiCommands(controllerContext: AiCommandsContext): Record<string,WorkspaceCommand> {
  return {
    "workspace.aiExplainSyntax": {
      id: "workspace.aiExplainSyntax",
      title: controllerContext.t("codeWorkspaceAi.commandExplainSyntax"),
      category: "AI",
      // ED-PARITY-013 DEC-013-05: Ctrl+Alt+S is IDEA Settings; the Taomni
      // Classic keymap scheme keeps the old binding.
      keywords: ["ai","syntax","grammar","teach","learn","explain","语法","讲解"],
      when: (context) => context.focus!=="tree"&&!!controllerContext.activeFile&&!controllerContext.activeFile.loading,
      run: () => void controllerContext.runEditorAiActionAtCursor("syntax"),
    },
    "workspace.aiExplainCode": {
      id: "workspace.aiExplainCode",
      title: controllerContext.t("codeWorkspaceAi.commandExplainCode"),
      category: "AI",
      keybinding: "Ctrl+Alt+E",
      keywords: ["ai","explain","describe","解释"],
      when: (context) => context.focus!=="tree"&&!!controllerContext.activeFile&&!controllerContext.activeFile.loading,
      run: () => void controllerContext.runEditorAiActionAtCursor("explain"),
    },
    "workspace.aiFixSelection": {
      id: "workspace.aiFixSelection",
      title: controllerContext.t("codeWorkspaceAi.commandFix"),
      category: "AI",
      keywords: ["ai","fix","repair","修复"],
      when: (context) => context.focus!=="tree"&&!!controllerContext.activeFile&&!controllerContext.activeFile.loading,
      run: () => void controllerContext.runEditorAiActionAtCursor("fix"),
    },
    "workspace.aiAskSelection": {
      id: "workspace.aiAskSelection",
      title: controllerContext.t("codeWorkspaceAi.commandAsk"),
      category: "AI",
      keywords: ["ai","ask","rewrite","改写","询问"],
      when: (context) => context.focus!=="tree"&&!!controllerContext.activeFile&&!controllerContext.activeFile.loading,
      run: () => void controllerContext.runEditorAiActionAtCursor("rewrite"),
    },
    "workspace.aiCycleAnswerLanguage": {
      // The keyboard path to the explain actions bypasses the selection
      // toolbar, so without this there is no way to change the answer language
      // without reaching for the mouse.
      id: "workspace.aiCycleAnswerLanguage",
      title: controllerContext.t("codeWorkspaceAi.commandCycleAnswerLanguage",{
        current: controllerContext.t(answerLanguageLabelKey(controllerContext.editorAiPreferences.answerLanguage)),
      }),
      category: "AI",
      keywords: ["ai","language","answer","chinese","english","语言","回答","中文","英文"],
      run: controllerContext.cycleAiAnswerLanguage,
    },
    "workspace.aiSetAnswerLanguage": {
      id: "workspace.aiSetAnswerLanguage",
      title: "Set AI Answer Language",
      category: "AI",
      keywords: ["ai","language","answer","语言"],
      run: (context) => {
        const payload=context.payload as { language?: string; }|undefined;
        if(!payload||typeof payload.language!=="string") return;
        controllerContext.setAiAnswerLanguage(payload.language as AiAnswerLanguage);
      },
    }
  };
}
