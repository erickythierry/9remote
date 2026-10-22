import ts from "typescript";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const directories = ["web/shared/i18n/locales", "host/ui/src/i18n/locales"];
let removed = 0;
for (const directory of directories) {
  for (const name of readdirSync(path.join(root, directory))) {
    if (!name.endsWith(".ts") || name === "index.ts") continue;
    const file = path.join(root, directory, name);
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    let duplicates = 0;
    const result = ts.transform(source, [(context) => {
      const visit = (node) => {
        const updated = ts.visitEachChild(node, visit, context);
        if (!ts.isObjectLiteralExpression(updated)) return updated;
        const values = new Map();
        for (const property of updated.properties) {
          if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) continue;
          values.set(property.name.text, property.initializer);
        }
        const seen = new Set();
        const properties = [];
        for (const property of updated.properties) {
          if (!ts.isPropertyAssignment(property) || ts.isComputedPropertyName(property.name)) {
            properties.push(property);
            continue;
          }
          const key = property.name.text;
          if (seen.has(key)) { duplicates++; continue; }
          seen.add(key);
          // Keep first insertion order and the last assigned value, matching JavaScript object semantics.
          properties.push(context.factory.updatePropertyAssignment(property, property.name, values.get(key)));
        }
        return context.factory.updateObjectLiteralExpression(updated, properties);
      };
      return (node) => ts.visitNode(node, visit);
    }]);
    if (duplicates) writeFileSync(file, ts.createPrinter().printFile(result.transformed[0]));
    removed += duplicates;
    result.dispose();
  }
}
console.log(`Removed ${removed} shadowed locale assignments; run verifyLocaleMigration.mjs to check values.`);
