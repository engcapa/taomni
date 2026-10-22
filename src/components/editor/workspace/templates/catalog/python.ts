import { type LiveTemplate } from "../types";

export const PYTHON_TEMPLATES: LiveTemplate[] = [
  {
    abbreviation: "main",
    body: "if __name__ == \"__main__\":\n\t${}",
    description: "main guard",
    languages: ["python"],
  },
  {
    abbreviation: "sout",
    body: "print(${})",
    description: "print (IDEA-style sout)",
    languages: ["python"],
  },
  {
    abbreviation: "pr",
    body: "print(${})",
    description: "print",
    languages: ["python"],
  },
  {
    abbreviation: "fori",
    body: "for ${i} in range(${}):\n\t${}",
    description: "for range loop",
    languages: ["python"],
  },
  {
    abbreviation: "for",
    body: "for ${item} in ${iterable}:\n\t${}",
    description: "for loop",
    languages: ["python"],
  },
  {
    abbreviation: "if",
    body: "if ${}:\n\t${}",
    description: "if statement",
    languages: ["python"],
  },
  {
    abbreviation: "ife",
    body: "if ${}:\n\t${}\nelse:\n\t${}",
    description: "if/else",
    languages: ["python"],
  },
  {
    abbreviation: "def",
    body: "def ${name}(${}):\n\t${}",
    description: "function",
    languages: ["python"],
  },
  {
    abbreviation: "defs",
    body: "def ${name}(self${}):\n\t${}",
    description: "method",
    languages: ["python"],
  },
  {
    abbreviation: "class",
    body: "class ${Name}:\n\tdef __init__(self${}):\n\t\t${}",
    description: "class with __init__",
    languages: ["python"],
  },
  {
    abbreviation: "try",
    body: "try:\n\t${}\nexcept ${Exception} as ${e}:\n\t${}",
    description: "try/except",
    languages: ["python"],
  },
  {
    abbreviation: "with",
    body: "with ${expr} as ${name}:\n\t${}",
    description: "with statement",
    languages: ["python"],
  },
  {
    abbreviation: "sout",
    body: "print($EXPR$)",
    description: "print expression",
    languages: ["python"],
    postfix: true,
  },
  {
    abbreviation: "return",
    body: "return $EXPR$",
    description: "return expression",
    languages: ["python"],
    postfix: true,
  },
];
