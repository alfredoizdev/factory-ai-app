// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react'
import type { Block } from '@/domain/graph'
import type { NodeState } from '@/domain/states'
import { StepsLane, stepsOf, stepToShow } from '@/ui/canvas/StepsView'
import { strings } from '@/ui/strings'

const block = (id: string, kind: Block['kind'], label: string, enabled = true): Block => ({ id, kind, label, enabled, config: {}, position: { x: 0, y: 0 } })
// As a project stores them: the extra check was added last, after Ship.
const blocks = [block('input', 'input', 'Input'), block('plan', 'plan', 'Plan'), block('build', 'build', 'Build'), block('tests', 'tests', 'Tests'), block('ship', 'ship', 'Ship'), block('lint', 'tests', 'Lint'), block('off', 'review', 'Review', false)]
const states = (of: Record<string, NodeState>) => (id: string) => of[id] ?? null

describe('the steps view', () => {
  it('lists the steps in the order a task goes through them, with the checks as one step', () => {
    expect(stepsOf(blocks).map(s => [s.label, s.blocks.map(b => b.id)])).toEqual([
      ['Input', ['input']],
      ['Plan', ['plan']],
      ['Build', ['build']],
      [strings.steps.checks, ['tests', 'lint']],
      ['Review', ['off']],
      ['Ship', ['ship']],
    ])
  })

  it('keeps the name of a check that stands alone', () => {
    expect(stepsOf(blocks.filter(b => b.id !== 'lint')).map(s => s.label)).toContain('Tests')
  })

  it('shows the step that needs the person, else the last one that is on', () => {
    expect(stepToShow(blocks, states({ input: 'passed', plan: 'waiting_approval' }))).toBe('plan')
    expect(stepToShow(blocks, states({}))).toBe('ship')
  })

  it('marks the picked step, says a turned-off step is off, and tells which block was clicked', () => {
    const picked: string[] = []
    render(<StepsLane blocks={blocks} stateOf={states({ input: 'passed', tests: 'passed', lint: 'failed' })} hasRun pickedId="lint" onPick={id => picked.push(id)} detail={<p>the details</p>} />)
    expect(screen.getByTestId('step-tests').getAttribute('aria-current')).toBe('step')
    expect(screen.getByTestId('check-lint').getAttribute('aria-current')).toBe('step')
    // The group stands where its least finished check stands.
    expect(screen.getByTestId('step-tests').textContent).toContain(strings.canvas.stateLabel.failed)
    expect(screen.getByTestId('step-off').textContent).toContain(strings.steps.off)
    expect(screen.getByText('the details')).toBeTruthy()
    fireEvent.click(screen.getByTestId('step-plan'))
    fireEvent.click(screen.getByTestId('check-tests'))
    expect(picked).toEqual(['plan', 'tests'])
  })

  it('shows where the work is: the working step is marked live with the turning ring, and no other step is', () => {
    render(<StepsLane blocks={blocks} stateOf={states({ input: 'passed', plan: 'running' })} hasRun pickedId="plan" onPick={() => undefined} />)
    expect(screen.getByTestId('step-plan').closest('[data-live]')).not.toBeNull()
    expect(screen.getByTestId('spinner-step-plan')).toBeTruthy()
    expect(screen.getByTestId('step-input').closest('[data-live]')).toBeNull()
    expect(document.querySelectorAll('[data-live]').length).toBe(1)
  })

  it('says what the row is for before any task runs', () => {
    render(<StepsLane blocks={blocks} stateOf={() => null} hasRun={false} pickedId="ship" onPick={() => undefined} />)
    expect(screen.getByText(strings.steps.beforeRun)).toBeTruthy()
  })
})
