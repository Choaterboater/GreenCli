import { describe, expect, it } from 'vitest';
import { inPopup, isTextEntry } from './textEntry';

describe('isTextEntry', () => {
  it('knows text fields', () => {
    expect(isTextEntry(document.createElement('input'))).toBe(true);
    expect(isTextEntry(document.createElement('textarea'))).toBe(true);
  });

  it("counts Monaco's EditContext div (Chromium / WebView2), which is not a textarea", () => {
    const editor = document.createElement('div');
    editor.className = 'monaco-editor';
    const input = document.createElement('div');
    input.className = 'native-edit-context';
    editor.appendChild(input);
    document.body.appendChild(editor);
    expect(isTextEntry(input)).toBe(true);
    editor.remove();
  });

  it('counts any element that has an EditContext attached', () => {
    const div = document.createElement('div') as HTMLDivElement & { editContext?: unknown };
    div.editContext = {};
    expect(isTextEntry(div)).toBe(true);
  });

  it('leaves buttons, plain divs and nothing to the terminal', () => {
    expect(isTextEntry(document.createElement('button'))).toBe(false);
    expect(isTextEntry(document.createElement('div'))).toBe(false);
    expect(isTextEntry(null)).toBe(false);
    expect(isTextEntry(window)).toBe(false);
  });
});

describe('inPopup', () => {
  it('keeps keys inside a dialog or an open menu away from the terminal', () => {
    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    const item = document.createElement('button');
    menu.appendChild(item);
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    const ok = document.createElement('button');
    dialog.appendChild(ok);
    document.body.append(menu, dialog);
    expect(inPopup(item)).toBe(true);
    expect(inPopup(ok)).toBe(true);
    expect(inPopup(document.createElement('button'))).toBe(false);
    expect(inPopup(null)).toBe(false);
    menu.remove();
    dialog.remove();
  });
});
