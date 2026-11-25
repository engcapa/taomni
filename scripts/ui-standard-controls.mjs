import ts from "typescript";

function literal(value) {
  if (value && ts.isJsxExpression(value)) value = value.expression;
  return value && ts.isStringLiteralLike(value) ? value.text : undefined;
}

function iconOnly(node, icons) {
  if (!ts.isJsxElement(node.parent)) return false;
  const children = node.parent.children.filter((child) => !ts.isJsxText(child) || child.text.trim());
  if (!children.length) return false;
  return children.every((child) => {
    const element = ts.isJsxElement(child) ? child.openingElement : child;
    if (!ts.isJsxOpeningElement(element) && !ts.isJsxSelfClosingElement(element)) return false;
    return element.tagName.getText() === "svg" || icons.has(element.tagName.getText());
  });
}

export function importedIconNames(ast) {
  const names = new Set();
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== "lucide-react") continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) {
      for (const part of bindings.elements) names.add(part.name.text);
    }
  }
  return names;
}

// Only inspect author-supplied inline style values. User content, code samples,
// color picker values and protocol payloads can also contain literal colors.
export function checkInlineStyle(initializer, add) {
  if (!initializer || !ts.isJsxExpression(initializer)
      || !initializer.expression || !ts.isObjectLiteralExpression(initializer.expression)) return;
  const colorProperty = /^(?:color|background(?:Color)?|border(?:Top|Bottom|Left|Right)?Color|outlineColor|textDecorationColor|boxShadow)$/;
  const fixedColor = /(?:#(?:[\da-f]{8}|[\da-f]{6}|[\da-f]{4}|[\da-f]{3})\b|rgba?\()/i;
  function inspectValue(property, value) {
    if (ts.isConditionalExpression(value)) {
      inspectValue(property, value.whenTrue);
      inspectValue(property, value.whenFalse);
    } else if (property === "zIndex" && (ts.isNumericLiteral(value)
        || (ts.isPrefixUnaryExpression(value) && ts.isNumericLiteral(value.operand))
        || (ts.isStringLiteralLike(value) && /^-?\d+$/.test(value.text)))) {
      add("L05-inline");
    } else if (colorProperty.test(property) && ts.isStringLiteralLike(value)
        && fixedColor.test(value.text.replace(/var\(\s*--taomni-[\w-]+\s*,\s*(?:#[\da-f]+|rgba?\([^)]*\))\s*\)/gi, ""))) {
      add("L04-inline");
    }
  }
  for (const property of initializer.expression.properties) {
    if (ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) {
      inspectValue(property.name.text, property.initializer);
    }
  }
}

export function checkElement(node, attrs, icons, path, add) {
  const tag = node.tagName.getText();
  if (!/^[a-z]+$/.test(tag)) return;
  const role = literal(attrs.get("role"));
  const classes = literal(attrs.get("className"))?.split(/\s+/) ?? [];
  const spread = node.attributes.properties.some(ts.isJsxSpreadAttribute);

  // A canvas that fills a window and a listbox popup have their own contracts.
  if ((tag === "dialog" || (["dialog", "alertdialog"].includes(role) && attrs.has("aria-modal")))
      && path !== "src/components/ui/ModalSurface.tsx") add("L02");
  if (role === "menu" && path !== "src/components/ContextMenu.tsx") add("L13");
  if (classes.includes("outline-none") && !classes.includes("taomni-btn")
      && !classes.some((name) => name.startsWith("focus-visible:"))) add("L07");

  if (!spread && role === "button" && ["div", "span"].includes(tag)
      && (!attrs.has("tabIndex") || (!attrs.has("onKeyDown") && !attrs.has("onKeyUp")))) add("L06");
  if (tag !== "button") return;
  if (!spread && !attrs.has("aria-label") && !attrs.has("aria-labelledby") && iconOnly(node, icons)) add("L11");
  if (ts.isJsxElement(node.parent) && node.parent.children.some((child) =>
    ts.isJsxText(child) && /\p{Extended_Pictographic}/u.test(child.text))) add("L12");
}
