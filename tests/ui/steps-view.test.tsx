// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import type { Block } from '@/domain/graph'
import { StepsView, stepsOf } from '@/ui/canvas/StepsView'
import { strings } from '@/ui/strings'

const block = (id: string, kind: Block['kind'], label: string, enabled = true): Block => ({ id, kind, label, enabled, config: {}, position: { x: 0, y: 0 } })
// As a project stores them: the extra checks were added last, after Ship.
const blocks = [block('input', 'input', 'Input'), block('plan', 'plan', 'Plan'), block('build', 'build', 'Build'), block('tests', 'tests', 'Tests'), block('ship', 'ship', 'Ship'), block('lint', 'tests', 'Lint'), block('off', 'review', 'Review', false)]

beforeEach(() => vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 }))))
afterEach(() => vi.unstubAllGlobals())

describe('the steps view', () => {
  it('lists the steps in the order a task goes through them, the checks as one step, and leaves out a block that is off', () => {
    expect(stepsOf(blocks).map(s => [s.label, s.blocks.map(b => b.id)])).toEqual([
      ['Input', ['input']],
      ['Plan', ['plan']],
      ['Build', ['build']],
      [strings.steps.checks, ['tests', 'lint']],
      ['Ship', ['ship']],
    ])
  })

  it('keeps the name of a check that stands alone', () => {
    expect(stepsOf(blocks.filter(b => b.id !== 'lint')).map(s => s.label)).toContain('Tests')
  })

  it('opens on the step that needs the person, and shows another when it is picked', () => {
    render(<StepsView blocks={blocks} views={{ input: { state: 'passed' }, plan: { state: 'waiting_approval' } }} runId="r1" onEditFlow={() => undefined} />)
    expect(screen.getByTestId('step-plan').getAttribute('aria-current')).toBe('step')
    expect(screen.getByTestId('block-details').getAttribute('aria-label')).toBe(strings.details.title('Plan'))
    fireEvent.click(screen.getByTestId('check-lint'))
    expect(screen.getByTestId('step-tests').getAttribute('aria-current')).toBe('step')
    expect(screen.getByTestId('block-details').getAttribute('aria-label')).toBe(strings.details.title('Lint'))
  })

  it('opens on the last step when nothing waits, and draws no details before a task runs', () => {
    const { rerender } = render(<StepsView blocks={blocks} views={{}} runId="r1" onEditFlow={() => undefined} />)
    expect(screen.getByTestId('step-ship').getAttribute('aria-current')).toBe('step')
    rerender(<StepsView blocks={blocks} views={{}} runId={null} onEditFlow={() => undefined} />)
    expect(screen.queryByTestId('block-details')).toBeNull()
    expect(screen.getByText(strings.steps.beforeRun)).toBeTruthy()
  })
})
