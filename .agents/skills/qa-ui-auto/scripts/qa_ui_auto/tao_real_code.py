"""Commercial code reasoning, shared Markdown/Mermaid and OS clipboard checks."""
from __future__ import annotations

import ast
import json
import secrets

from . import file_dialog, host_clipboard
from .steps import StepError
from .tao_real_flow import RealFlow

CODE = "return [...document.querySelectorAll('[data-tao-active=\"true\"] [data-testid=\"tao-home-markdown-reply\"]')].at(-1)?.querySelector('pre code')?.textContent ?? '';"


def verify_average(source: str):
    """Check parsed code and interpreted safe arithmetic without executing model code."""
    try:
        module = ast.parse(source)
    except SyntaxError as error:
        raise StepError("Generated Python is not syntactically valid") from error
    functions = [node for node in module.body if isinstance(node, ast.FunctionDef) and node.name == "average"]
    if len(functions) != 1:
        raise StepError("Generated code has no unique average function")
    function = functions[0]
    # This task asks for a pure arithmetic function, not arbitrary program execution.
    allowed = (ast.FunctionDef, ast.arguments, ast.arg, ast.Return, ast.If, ast.Name, ast.Load,
               ast.BinOp, ast.Div, ast.Constant, ast.Call, ast.UnaryOp, ast.Not, ast.Compare,
               ast.Eq, ast.LtE, ast.Gt, ast.GtE, ast.NotEq, ast.IfExp, ast.Assign, ast.Store,
               ast.Expr, ast.Add, ast.Sub, ast.Mult)
    if any(not isinstance(node, allowed) for node in ast.walk(function)):
        raise StepError("Generated arithmetic exceeds the safe independent oracle")
    for node in ast.walk(function):
        if isinstance(node, ast.Call) and (not isinstance(node.func, ast.Name) or node.func.id not in {"sum", "len"}):
            raise StepError("Generated arithmetic contains an unexpected call")
    def value(node, env):
        if isinstance(node, ast.Constant): return node.value
        if isinstance(node, ast.Name): return env[node.id]
        if isinstance(node, ast.Call): return {"sum": sum, "len": len}[node.func.id](*[value(arg, env) for arg in node.args])
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, ast.Not): return not value(node.operand, env)
        if isinstance(node, ast.BinOp):
            left, right = value(node.left, env), value(node.right, env)
            if isinstance(node.op, ast.Div): return left / right
            if isinstance(node.op, ast.Add): return left + right
            if isinstance(node.op, ast.Sub): return left - right
            if isinstance(node.op, ast.Mult): return left * right
        if isinstance(node, ast.IfExp): return value(node.body if value(node.test, env) else node.orelse, env)
        if isinstance(node, ast.Compare) and len(node.ops) == 1:
            left, right = value(node.left, env), value(node.comparators[0], env)
            return {ast.Eq: lambda: left == right, ast.NotEq: lambda: left != right,
                    ast.LtE: lambda: left <= right, ast.Gt: lambda: left > right,
                    ast.GtE: lambda: left >= right}[type(node.ops[0])]()
        raise StepError("Unexpected expression in arithmetic oracle")
    def statements(body, env):
        for node in body:
            if isinstance(node, ast.Return): return True, value(node.value, env)
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                env[node.targets[0].id] = value(node.value, env)
            elif isinstance(node, ast.If):
                returned, result = statements(node.body if value(node.test, env) else node.orelse, env)
                if returned: return returned, result
            elif isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant):
                pass  # Function docstring.
            else:
                raise StepError("Unexpected statement in arithmetic oracle")
        return False, None
    argument = function.args.args[0].arg
    for values, expected in (([], None), ([3, 6], 4.5), ([-4, 4], 0), ([7], 7)):
        returned, actual = statements(function.body, {argument: values})
        if not returned or actual != expected:
            raise StepError("Actual generated Python failed empty/fractional/negative/singleton arithmetic")


def run(ctx):
    flow = RealFlow(ctx, "code", 4)
    with flow.evidence():
        flow.send("Fix this Python bug: def average(values): return sum(values) // len(values). Return only one python fenced block with def average(values), using sum and len and an if or ternary guard. Empty input returns None. Fractional means must not be truncated. No imports, loops, tests, annotations or commentary.")
        flow.reply("python-debug", 1)
        source = flow.read(CODE)
        verify_average(source)
        (ctx.case_dir / "generated-average.py").write_text(source, encoding="utf-8")
        flow.record("python-independent-oracle", dict(syntax=True, empty=True, fractional=True, negative=True, singleton=True))
        flow.screenshot("python")
        previous = host_clipboard.get_text()
        try:
            flow.click('[data-testid="tao-home-message-assistant"] button[aria-label="Copy"]')
            def clipboard_state():
                text = host_clipboard.get_text().replace("\r", "")
                return dict(matches=source.replace("\r", "").strip() in text and "```" in text, length=len(text))
            copied = flow.wait(clipboard_state, lambda state: state["matches"],
                               "Message Copy did not write actual Markdown into the OS clipboard")
            flow.record("native-copy-markdown", dict(codeAndFences=True, length=copied["length"]))
        finally:
            host_clipboard.set_text(previous)

        flow.send("Now give two short fenced blocks only. First TypeScript: export function add(a: number, b: number): number { return a + b; }. Second SQL: SELECT name, COUNT(*) AS total FROM qa_items GROUP BY name ORDER BY total DESC; . Preserve both requested semantics, no outer fence.")
        flow.reply("typescript-sql", 2)
        code = flow.read("return [...document.querySelectorAll('[data-tao-active=\"true\"] [data-testid=\"tao-home-markdown-reply\"]')].at(-1)?.querySelectorAll('pre code').length;")
        text = flow.last_text()
        flow.require(code == 2 and "a + b" in text and "GROUP BY name" in text and "ORDER BY total DESC" in text,
                     "Real multi-language code reply lost code fences or requested semantics")
        flow.record("multi-language-fences", dict(blocks=code, semantics=True))

        flow.send("Return exactly one mermaid fenced block and nothing else: flowchart LR\n A[Input] --> B[Validate]\n B --> C[Output]")
        flow.reply("mermaid", 3)
        diagram = flow.wait(lambda: flow.read("return [...document.querySelectorAll('[data-tao-active=\"true\"] [data-testid=\"tao-home-markdown-reply\"]')].at(-1)?.querySelector('svg')?.textContent ?? '';"),
                            lambda text: all(label in text for label in ("Input", "Validate", "Output")),
                            "Real provider Mermaid did not render all three nodes")
        flow.record("mermaid-rendered", dict(svg=True, nodes=3))
        flow.screenshot("mermaid")

        flow.new_chat()
        token = "QA" + secrets.token_hex(5)
        prompt = "Explain in Chinese how to prevent SQL injection with parameterized queries. Give one short Python sqlite3 fenced example using SELECT ? with the value '" + token + "'. Do not call external tools."
        flow.send(prompt)
        flow.reply("chinese-secure-code", 1, token, check_marker=True)
        text = flow.last_text()
        flow.require("?" in flow.read(CODE) and any("\u4e00" <= ch <= "\u9fff" for ch in text),
                     "Real Chinese code reply did not retain parameterized SQL and Chinese explanation")
        flow.record("chinese-code", dict(chinese=True, parameterized=True, marker=True))
        flow.screenshot("chinese-code")
    return "Real DeepSeek code: " + flow.outcome
