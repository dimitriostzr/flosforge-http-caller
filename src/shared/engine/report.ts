import type { RunStep, RunSummary } from './collectionRun'

// Run reports. JSON for scripts and archiving; JUnit XML because every CI system
// (GitHub Actions, GitLab, Jenkins, Azure) can display it as test results.

export interface JsonReport {
  tool: string
  collection: string
  summary: Omit<RunSummary, 'scopes'>
  steps: Omit<RunStep, 'logs'>[]
}

export function toJsonReport(collection: string, summary: RunSummary, steps: RunStep[], tool = 'FlosForge Caller'): JsonReport {
  const { scopes, ...rest } = summary
  return { tool, collection, summary: rest, steps: steps.map(({ logs, ...s }) => s) }
}

const xml = (s: string): string =>
  s.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]!)
// XML 1.0 can't carry most control characters at all, even escaped.
const clean = (s: string): string => xml(s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''))

/** One <testsuite> per request execution, one <testcase> per test (the usual runner layout). */
export function toJUnit(collection: string, summary: RunSummary, steps: RunStep[]): string {
  const multi = summary.totalIterations > 1
  const suites = steps.map((s) => {
    const name = `${multi ? `Iteration ${s.iteration + 1} / ` : ''}${s.name}`
    const time = ((s.timeMs ?? 0) / 1000).toFixed(3)
    const cases = s.tests.map((t) => {
      const body = t.skipped
        ? '<skipped/>'
        : t.passed
          ? ''
          : `<failure type="AssertionFailure" message="${clean(t.error ?? 'failed')}">${clean(t.error ?? '')}</failure>`
      return `      <testcase classname="${clean(name)}" name="${clean(t.name)}" time="${time}">${body}</testcase>`
    })
    const problems = [s.error, ...s.scriptErrors].filter((x): x is string => !!x)
    if (problems.length)
      cases.push(
        `      <testcase classname="${clean(name)}" name="${clean(`${s.method} ${s.url}`)}" time="${time}"><error type="RequestError" message="${clean(problems[0])}">${clean(problems.join('\n'))}</error></testcase>`
      )
    const failures = s.tests.filter((t) => !t.passed && !t.skipped).length
    const skipped = s.tests.filter((t) => t.skipped).length
    return [
      `    <testsuite name="${clean(name)}" tests="${cases.length}" failures="${failures}" errors="${problems.length ? 1 : 0}" skipped="${skipped}" time="${time}">`,
      ...cases,
      '    </testsuite>'
    ].join('\n')
  })
  const total = (summary.finishedAt - summary.startedAt) / 1000
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${clean(collection)}" tests="${summary.tests.passed + summary.tests.failed + summary.tests.skipped}" failures="${summary.tests.failed}" time="${total.toFixed(3)}">`,
    ...suites,
    '</testsuites>',
    ''
  ].join('\n')
}
