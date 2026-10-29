import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

// One CodeMirror theme for both light and dark: all colors come from CSS
// variables defined in styles.css, so switching the app theme just works.

export const baseTheme = EditorView.theme({
  '&': {
    color: 'var(--text)',
    backgroundColor: 'transparent',
    fontSize: 'var(--code-size)',
    height: '100%'
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--accent)' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, ::selection':
    { backgroundColor: 'var(--selection) !important' },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--text-faint)',
    border: 'none',
    borderRight: '1px solid var(--border)'
  },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-muted)' },
  '.cm-activeLine': { backgroundColor: 'var(--active-line)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--bg-hover)', border: 'none', color: 'var(--text-muted)' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--accent-bg)',
    outline: '1px solid var(--accent-border)'
  },
  '.cm-searchMatch': { backgroundColor: 'var(--search-match)', outline: '1px solid var(--warn)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'var(--accent-bg)' },
  '.cm-panels': { backgroundColor: 'var(--bg-elev-2)', color: 'var(--text)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--border)' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid var(--border)' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': { fontSize: '12px' },
  '.cm-tooltip': {
    backgroundColor: 'var(--bg-elev)',
    border: '1px solid var(--border-strong)',
    borderRadius: '6px',
    boxShadow: 'var(--shadow)',
    color: 'var(--text)'
  },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'var(--accent-bg)', color: 'var(--text)' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: '12px' },
  '.cm-completionDetail': { color: 'var(--text-muted)', fontStyle: 'normal', marginLeft: '1em' },
  '.cm-placeholder': { color: 'var(--text-faint)' }
})

export const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--syn-keyword)' },
    { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--syn-string)' },
    { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--syn-number)' },
    { tag: [t.propertyName, t.attributeName], color: 'var(--syn-property)' },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--syn-function)' },
    { tag: [t.typeName, t.className, t.tagName], color: 'var(--syn-tag)' },
    { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syn-comment)', fontStyle: 'italic' },
    { tag: [t.punctuation, t.bracket, t.separator], color: 'var(--syn-punct)' },
    { tag: t.invalid, color: 'var(--danger)' }
  ])
)
