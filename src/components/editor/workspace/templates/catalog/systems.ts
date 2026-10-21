import { type LiveTemplate } from "../types";

export const RUST_TEMPLATES: LiveTemplate[] = [
  {
    abbreviation: "sout",
    body: "println!(\"${}\");",
    description: "println! (IDEA-style sout)",
    languages: ["rust"],
  },
  {
    abbreviation: "p",
    body: "println!(\"${}\");",
    description: "println!",
    languages: ["rust"],
  },
  {
    abbreviation: "pd",
    body: "println!(\"{:?}\", ${});",
    description: "println! debug",
    languages: ["rust"],
  },
  {
    abbreviation: "main",
    body: "fn main() {\n\t${}\n}",
    description: "main function",
    languages: ["rust"],
  },
  {
    abbreviation: "fori",
    body: "for ${i} in 0..${} {\n\t${}\n}",
    description: "for range loop",
    languages: ["rust"],
  },
  {
    abbreviation: "for",
    body: "for ${item} in ${iterable} {\n\t${}\n}",
    description: "for loop",
    languages: ["rust"],
  },
  {
    abbreviation: "match",
    body: "match ${expr} {\n\t${} => ${},\n\t_ => ${},\n}",
    description: "match expression",
    languages: ["rust"],
  },
  {
    abbreviation: "ifl",
    body: "if let ${Some}(${val}) = ${expr} {\n\t${}\n}",
    description: "if let",
    languages: ["rust"],
  },
  {
    abbreviation: "wl",
    body: "while let ${Some}(${val}) = ${expr} {\n\t${}\n}",
    description: "while let",
    languages: ["rust"],
  },
  {
    abbreviation: "fn",
    body: "fn ${name}(${}) ${-> Type }{\n\t${}\n}",
    description: "function",
    languages: ["rust"],
  },
  {
    abbreviation: "sout",
    body: "println!(\"{:?}\", $EXPR$);",
    description: "println! expression",
    languages: ["rust"],
    postfix: true,
  },
  {
    abbreviation: "return",
    body: "return $EXPR$;",
    description: "return expression",
    languages: ["rust"],
    postfix: true,
  },
];

export const GO_TEMPLATES: LiveTemplate[] = [
  {
    abbreviation: "sout",
    body: "fmt.Println(${})",
    description: "fmt.Println (IDEA-style sout)",
    languages: ["go"],
  },
  {
    abbreviation: "main",
    body: "func main() {\n\t${}\n}",
    description: "main function",
    languages: ["go"],
  },
  {
    abbreviation: "psvm",
    body: "func main() {\n\t${}\n}",
    description: "main function",
    languages: ["go"],
  },
  {
    abbreviation: "fori",
    body: "for ${i} := 0; ${i} < ${}; ${i}++ {\n\t${}\n}",
    description: "for loop with index",
    languages: ["go"],
  },
  {
    abbreviation: "for",
    body: "for ${key}, ${value} := range ${collection} {\n\t${}\n}",
    description: "for range",
    languages: ["go"],
  },
  {
    abbreviation: "err",
    body: "if err != nil {\n\t${return err}\n}",
    description: "if err != nil",
    languages: ["go"],
  },
  {
    abbreviation: "ierr",
    body: "if ${err} != nil {\n\t${}\n}",
    description: "if error check",
    languages: ["go"],
  },
  {
    abbreviation: "fn",
    body: "func ${name}(${}) ${} {\n\t${}\n}",
    description: "function",
    languages: ["go"],
  },
  {
    abbreviation: "sout",
    body: "fmt.Println($EXPR$)",
    description: "fmt.Println expression",
    languages: ["go"],
    postfix: true,
  },
  {
    abbreviation: "return",
    body: "return $EXPR$",
    description: "return expression",
    languages: ["go"],
    postfix: true,
  },
];
