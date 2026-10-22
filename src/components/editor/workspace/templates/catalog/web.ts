import { type LiveTemplate } from "../types";

export const CSHARP_TEMPLATES: LiveTemplate[] = [
  {
    abbreviation: "sout",
    body: "Console.WriteLine(${});",
    description: "Console.WriteLine",
    languages: ["csharp"],
  },
  {
    abbreviation: "psvm",
    body: "public static void Main(string[] args)\n{\n\t${}\n}",
    description: "Main method",
    languages: ["csharp"],
  },
  {
    abbreviation: "main",
    body: "public static void Main(string[] args)\n{\n\t${}\n}",
    description: "Main method",
    languages: ["csharp"],
  },
  {
    abbreviation: "fori",
    body: "for (int ${i} = 0; ${i} < ${}; ${i}++)\n{\n\t${}\n}",
    description: "for loop",
    languages: ["csharp"],
  },
  {
    abbreviation: "foreach",
    body: "foreach (var ${item} in ${collection})\n{\n\t${}\n}",
    description: "foreach loop",
    languages: ["csharp"],
  },
  {
    abbreviation: "prop",
    body: "public ${Type} ${Name} { get; set; }",
    description: "auto-property",
    languages: ["csharp"],
  },
  {
    abbreviation: "sout",
    body: "Console.WriteLine($EXPR$);",
    description: "WriteLine expression",
    languages: ["csharp"],
    postfix: true,
  },
];

export const PHP_TEMPLATES: LiveTemplate[] = [
  {
    abbreviation: "sout",
    body: "echo ${};",
    description: "echo",
    languages: ["php"],
  },
  {
    abbreviation: "fori",
    body: "for ($${i} = 0; $${i} < ${}; $${i}++) {\n\t${}\n}",
    description: "for loop",
    languages: ["php"],
  },
  {
    abbreviation: "foreach",
    body: "foreach ($${array} as $${item}) {\n\t${}\n}",
    description: "foreach",
    languages: ["php"],
  },
  {
    abbreviation: "pubf",
    body: "public function ${name}(${}): ${void}\n{\n\t${}\n}",
    description: "public method",
    languages: ["php"],
  },
];
