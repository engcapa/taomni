import { type LiveTemplate } from "../types";

export const KOTLIN_TEMPLATES: LiveTemplate[] = [
  {
    abbreviation: "sout",
    body: "println(${})",
    description: "Prints a string to stdout",
    languages: ["kotlin"],
  },
  {
    abbreviation: "soutv",
    body: "println(\"${expr} = $${expr}\")",
    description: "Prints a value",
    languages: ["kotlin"],
  },
  {
    abbreviation: "main",
    body: "fun main(args: Array<String>) {\n\t${}\n}",
    description: "main function",
    languages: ["kotlin"],
  },
  {
    abbreviation: "psvm",
    body: "fun main(args: Array<String>) {\n\t${}\n}",
    description: "main function",
    languages: ["kotlin"],
  },
  {
    abbreviation: "fori",
    body: "for (${i} in 0 until ${}) {\n\t${}\n}",
    description: "for loop with index",
    languages: ["kotlin"],
  },
  {
    abbreviation: "iter",
    body: "for (${item} in ${iterable}) {\n\t${}\n}",
    description: "Iterate collection",
    languages: ["kotlin"],
  },
  {
    abbreviation: "ifn",
    body: "if (${var} == null) {\n\t${}\n}",
    description: "null check",
    languages: ["kotlin"],
  },
  {
    abbreviation: "inn",
    body: "if (${var} != null) {\n\t${}\n}",
    description: "not-null check",
    languages: ["kotlin"],
  },
  {
    abbreviation: "todo",
    body: "TODO(\"${}\")",
    description: "TODO stub",
    languages: ["kotlin"],
  },
  {
    abbreviation: "sout",
    body: "println($EXPR$)",
    description: "Print expression",
    languages: ["kotlin"],
    postfix: true,
  },
  {
    abbreviation: "nn",
    body: "if ($EXPR$ != null) {\n\t${}\n}",
    description: "not-null check",
    languages: ["kotlin"],
    postfix: true,
  },
  {
    abbreviation: "return",
    body: "return $EXPR$",
    description: "return expression",
    languages: ["kotlin"],
    postfix: true,
  },
];
