use super::shell_safety::RiskLevel;
use serde::{Deserialize, Serialize};

/// The JSON schema that the LLM must return for generate_shell_command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GeneratedCommand {
    pub command: String,
    pub explanation: String,
    pub risk: RiskLevel,
    #[serde(default)]
    pub needs_inputs: Vec<String>,
}

/// Tool definition sent to the LLM as a function/tool schema.
pub fn generate_shell_command_schema() -> serde_json::Value {
    serde_json::json!({
        "name": "generate_shell_command",
        "description": "用户用自然语言描述了一个想在当前 shell 中执行的命令或脚本。生成实际命令，附带简短解释和风险等级评估。绝不要假定文件名，从用户描述中提取；不确定则使用占位符 <FILENAME>。",
        "input_schema": {
            "type": "object",
            "properties": {
                "command": {
                    "type": "string",
                    "description": "可执行 shell 文本（单行或 heredoc 多行）"
                },
                "explanation": {
                    "type": "string",
                    "description": "1-2 句中文解释"
                },
                "risk": {
                    "type": "string",
                    "enum": ["low", "medium", "high"],
                    "description": "low=只读/创建；medium=改动现有文件；high=删除/格式化/sudo"
                },
                "needs_inputs": {
                    "type": "array",
                    "items": { "type": "string" },
                    "description": "命令中尚未确定、需用户填入的占位符列表"
                }
            },
            "required": ["command", "explanation", "risk"]
        }
    })
}
