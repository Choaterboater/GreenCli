// What the AI sees in place of a hidden secret. Plain strings, so code that
// only looks for the markers (the gate below) never loads the regex rules,
// which an old WebView can't parse. casperSync.test.ts checks these match
// SECRET_MARKER / LINE_MARKER in scrub.ts.

export const SECRET_MARKER = '<secret hidden>';
export const LINE_MARKER = '<line hidden: secret>';
