// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QuestionPanel } from '@/ui/canvas/QuestionPanel'
import type { Question } from '@/engine/questions'
import { strings } from '@/ui/strings'

const question: Question = {
  id: 'q1', runId: 'r1', nodeRunId: 'n1', findingId: 'f1', kind: 'finding',
  text: 'The change may not be safe. The app ran a check and saw the problem happen.',
  why: 'The app is asking instead of deciding on its own. It touches a decision you made (D-07).',
  detail: 'The reviewer wrote that the token is logged.', 
  options: [
    { id: 'fix', label: 'Fix it', means: 'A helper changes only what this problem needs.' },
    { id: 'leave', label: 'Leave it as it is', means: 'Nothing is changed for this.' },
  ],
  recommended: 'fix', touches: [7], state: 'open', answerOption: null, answerText: null, actor: null, answeredAt: null,
}
const touched = [{ number: 7, label: 'D-07', kind: 'decision', text: 'Tokens are never written to the log' }]
const confirm = () => screen.getByRole('button', { name: strings.question.confirm })

test('shows the sentence, why, each choice with what it means, and marks the recommended one only', () => {
  render(<QuestionPanel question={question} touched={touched} onAnswer={async () => undefined} />)
  expect(screen.getByText(question.text)).toBeInTheDocument()
  expect(screen.getByText(/The app is asking instead of deciding on its own/)).toBeInTheDocument()
  for (const o of question.options) {
    expect(screen.getByRole('radio', { name: new RegExp(o.label) })).toBeInTheDocument()
    expect(screen.getByText(o.means)).toBeInTheDocument()
  }
  expect(screen.getAllByText(strings.question.recommended)).toHaveLength(1)
  expect(screen.getByRole('radio', { name: new RegExp(`Fix it.*${strings.question.recommended}`) })).toBeInTheDocument()
  expect(screen.getByLabelText(strings.question.ownWordsLabel)).toBeInTheDocument()
})

test('an earlier decision is shown by its own words next to its label, never as a bare number', () => {
  render(<QuestionPanel question={question} touched={touched} onAnswer={async () => undefined} />)
  const text = document.body.textContent ?? ''
  expect(text).toContain('Tokens are never written to the log')
  expect(text.match(/D-07/g)!.length).toBeGreaterThan(0)
  expect(text).not.toMatch(/D-07\)/) // the bare "(D-07)" of the sentence was replaced
  expect(screen.getByText(strings.question.touchesTitle)).toBeInTheDocument()
})

test('a number with no entry behind it is not shown bare', () => {
  render(<QuestionPanel question={question} touched={[]} onAnswer={async () => undefined} />)
  expect(document.body.textContent).not.toMatch(/D-\d/)
  expect(document.body.textContent).toContain(strings.question.earlierDecision)
})

test('the button is disabled until a choice or words are given; words need to be words', () => {
  render(<QuestionPanel question={question} onAnswer={async () => undefined} />)
  expect(confirm()).toBeDisabled()
  fireEvent.change(screen.getByLabelText(strings.question.ownWordsLabel), { target: { value: '   ' } })
  expect(confirm()).toBeDisabled()
  fireEvent.click(screen.getByRole('radio', { name: /Leave it as it is/ }))
  expect(confirm()).toBeEnabled()
})

test('a click answers with the chosen option once; a double click while sending still answers once', async () => {
  let release!: () => void
  const onAnswer = vi.fn(() => new Promise<void>(r => (release = r)))
  render(<QuestionPanel question={question} onAnswer={onAnswer} />)
  fireEvent.click(screen.getByRole('radio', { name: /Fix it/ }))
  const button = confirm()
  fireEvent.click(button)
  fireEvent.click(button)
  fireEvent.click(screen.getByRole('button', { name: strings.question.sending }))
  expect(onAnswer).toHaveBeenCalledTimes(1)
  expect(onAnswer).toHaveBeenCalledWith('fix', undefined)
  expect(screen.getByRole('button', { name: strings.question.sending })).toBeDisabled()
  await act(async () => release())
})

test('words with a chosen option are sent with that option', async () => {
  const onAnswer = vi.fn(async () => undefined)
  render(<QuestionPanel question={question} onAnswer={onAnswer} />)
  fireEvent.click(screen.getByRole('radio', { name: /Leave it as it is/ }))
  fireEvent.change(screen.getByLabelText(strings.question.noteLabel), { target: { value: '  the rounding is on purpose ' } })
  expect(screen.getByRole('radio', { name: /Leave it as it is/ })).toBeChecked() // typing keeps the chosen option
  fireEvent.click(confirm())
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith('leave', 'the rounding is on purpose'))
})

test('choosing an option after typing keeps the words, and the box says they go with the choice', async () => {
  const onAnswer = vi.fn(async () => undefined)
  render(<QuestionPanel question={question} onAnswer={onAnswer} />)
  fireEvent.change(screen.getByLabelText(strings.question.ownWordsLabel), { target: { value: 'the rounding is on purpose' } })
  fireEvent.click(screen.getByRole('radio', { name: /Leave it as it is/ }))
  const box = screen.getByLabelText(strings.question.noteLabel)
  expect(box).toHaveValue('the rounding is on purpose')
  fireEvent.click(screen.getByRole('radio', { name: /Fix it/ }))
  expect(box).toHaveValue('the rounding is on purpose')
  fireEvent.click(confirm())
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith('fix', 'the rounding is on purpose'))
})

test('the person\'s own words with no option chosen are sent as "other"', async () => {
  const onAnswer = vi.fn(async () => undefined)
  render(<QuestionPanel question={question} onAnswer={onAnswer} />)
  fireEvent.change(screen.getByLabelText(strings.question.ownWordsLabel), { target: { value: '  only change the log line ' } })
  for (const o of question.options) expect(screen.getByRole('radio', { name: new RegExp(o.label) })).not.toBeChecked()
  fireEvent.click(confirm())
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith('other', 'only change the log line'))
})

test('a chosen option with no words sends no words, and Enter in the box does not send', async () => {
  const onAnswer = vi.fn(async () => undefined)
  render(<QuestionPanel question={question} onAnswer={onAnswer} />)
  fireEvent.click(screen.getByRole('radio', { name: /Leave it as it is/ }))
  const box = screen.getByLabelText(strings.question.noteLabel)
  fireEvent.change(box, { target: { value: 'a reason' } })
  fireEvent.keyDown(box, { key: 'Enter' })
  expect(onAnswer).not.toHaveBeenCalled()
  fireEvent.change(box, { target: { value: '   ' } })
  fireEvent.click(confirm())
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith('leave', undefined))
})

test('an error from the server is shown as the sentence it sent, and the buttons work again', async () => {
  const onAnswer = vi.fn(async () => { throw new Error(strings.question.alreadyAnswered) })
  render(<QuestionPanel question={question} onAnswer={onAnswer} />)
  fireEvent.click(screen.getByRole('radio', { name: /Fix it/ }))
  fireEvent.click(confirm())
  expect(await screen.findByRole('alert')).toHaveTextContent(strings.question.alreadyAnswered)
  expect(confirm()).toBeEnabled()
})

test('"Problem 2 of 3" only when there is more than one problem', () => {
  const { rerender } = render(<QuestionPanel question={question} position={{ n: 2, of: 3 }} onAnswer={async () => undefined} />)
  expect(screen.getByText(strings.question.position(2, 3))).toBeInTheDocument()
  rerender(<QuestionPanel question={question} position={{ n: 1, of: 1 }} onAnswer={async () => undefined} />)
  expect(screen.queryByText(/Problem 1 of/)).toBeNull()
})

test('the reviewer\'s words and the place are one click away, labelled as the AI\'s, and the button says it is open', () => {
  render(<QuestionPanel question={question} onAnswer={async () => undefined} />)
  expect(screen.queryByText(/token is logged/)).toBeNull()
  const button = screen.getByRole('button', { name: strings.question.seeDetails })
  expect(button).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(button)
  expect(button).toHaveAttribute('aria-expanded', 'true')
  expect(screen.getByText(strings.question.aiSaid)).toBeInTheDocument()
  expect(screen.getByText(/token is logged/)).toBeInTheDocument()
})

test('no details button when the question has none', () => {
  render(<QuestionPanel question={{ ...question, detail: null }} onAnswer={async () => undefined} />)
  expect(screen.queryByRole('button', { name: strings.question.seeDetails })).toBeNull()
})

test('typing only spaces does not take a chosen option away', () => {
  render(<QuestionPanel question={question} onAnswer={async () => undefined} />)
  fireEvent.click(screen.getByRole('radio', { name: /Fix it/ }))
  fireEvent.change(screen.getByLabelText(strings.question.noteLabel), { target: { value: '   ' } })
  expect(screen.getByRole('radio', { name: /Fix it/ })).toBeChecked()
  expect(confirm()).toBeEnabled()
})

test('two clicks in the same tick, before anything re-renders, answer once', async () => {
  const onAnswer = vi.fn(() => new Promise<void>(() => undefined))
  render(<QuestionPanel question={question} onAnswer={onAnswer} />)
  fireEvent.click(screen.getByRole('radio', { name: /Fix it/ }))
  const button = confirm()
  act(() => {
    fireEvent.click(button)
    fireEvent.click(button)
  })
  expect(onAnswer).toHaveBeenCalledTimes(1)
})

test('See details and the choices are big enough to tap', () => {
  render(<QuestionPanel question={question} onAnswer={async () => undefined} />)
  expect(screen.getByRole('button', { name: strings.question.seeDetails }).style.minHeight).toBe('32px')
})

describe('what the problem is, on the first level', () => {
  const said = { where: 'src/auth.ts, line 12', problem: 'The session token is written to the log on every request.', command: 'node repro/check.mjs', outputTail: 'TOKEN-SEEN', reason: '' }

  test('the reviewer\'s own sentence is shown open, under its label, without the place; the place and the check are one click away', () => {
    render(<QuestionPanel question={question} finding={said} onAnswer={async () => undefined} />)
    expect(screen.getByText(strings.question.aiSaid)).toBeInTheDocument()
    expect(screen.getByText(said.problem)).toBeInTheDocument()
    expect(screen.queryByText(/src\/auth\.ts/)).toBeNull()
    expect(screen.queryByText('node repro/check.mjs')).toBeNull()
    const button = screen.getByRole('button', { name: strings.question.seeDetails })
    fireEvent.click(button)
    expect(screen.getByText(/src\/auth\.ts, line 12/)).toBeInTheDocument()
    expect(screen.getByText('node repro/check.mjs')).toBeInTheDocument()
    expect(screen.getByText('TOKEN-SEEN')).toBeInTheDocument()
    // the sentence is not said twice
    expect(screen.getAllByText(said.problem)).toHaveLength(1)
  })

  test('two problems of one kind no longer read the same', () => {
    const { container: a } = render(<QuestionPanel question={question} finding={said} onAnswer={async () => undefined} />)
    const { container: b } = render(<QuestionPanel question={question} finding={{ ...said, problem: 'The price is rounded the wrong way.' }} onAnswer={async () => undefined} />)
    expect(a.textContent).not.toBe(b.textContent)
  })

  test('a long sentence is cut on the first level', () => {
    render(<QuestionPanel question={question} finding={{ ...said, problem: 'x'.repeat(2000) }} onAnswer={async () => undefined} />)
    expect(document.body.textContent).not.toContain('x'.repeat(500))
    expect(document.body.textContent).toContain('x'.repeat(300))
  })

  test('wraps at phone width: nothing in it asks for more room than the card has', () => {
    render(<QuestionPanel question={question} finding={{ ...said, problem: 'averyveryverylongwordwithoutanyspace'.repeat(20) }} onAnswer={async () => undefined} />)
    const shown = screen.getByText(/averyvery/)
    expect(shown.style.overflowWrap).toBe('anywhere')
  })
})
