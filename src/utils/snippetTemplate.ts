// `{{name}}` placeholders in command snippets, e.g. `show interface {{port}}`.
// Filled in by prompting once per distinct name before the snippet is used.

const PLACEHOLDER = /\{\{\s*([\w.-]+)\s*\}\}/g;

/** Distinct placeholder names in `command`, in first-seen order. */
export function snippetPlaceholders(command: string): string[] {
  const names: string[] = [];
  for (const m of command.matchAll(PLACEHOLDER)) {
    if (!names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/** Replace every `{{name}}` that has a value; unknown names are left as typed. */
export function fillPlaceholders(command: string, values: Record<string, string>): string {
  return command.replace(PLACEHOLDER, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(values, name) ? values[name] : whole
  );
}
