'use client'

import { useId, useRef, useState } from 'react'
import type { Question } from '@/engine/questions'
import type { FindingView } from '@/engine/finding-view'
import { strings } from '@/ui/strings'
import { explained, type Touched } from '@/ui/explain'
import { theme } from '@/ui/theme'
import { displayOrder } from './FindingsList'
import { Bone } from './Skeleton'
import type { ReviewRecord } from './useReviewRecord'

export type { Touched }

const OTHER = 'other'
const MONO = 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace'
/** How much of the reviewer's sentence the first level shows; the rest of what was recorded is one click away. */
const SAID_MAX = 400
const cut = (text: string) => (text.length > SAID_MAX ? `${text.slice(0, SAID_MAX - 1)}…` : text)

/**
 * A question the review cannot answer for the person: one plain sentence, why it asks, a few choices each saying what
 * it means, the recommended one marked, and a box for their own words: a note that goes with the chosen option, or
 * the whole answer when none is chosen. One button answers it, once.
 */
export function QuestionPanel({
  question,
  onAnswer,
  position,
  touched = [],
  finding,
}: {
  question: Question
  /** The problem the question is about, as the list shows it (already redacted and clipped on the server). */
  finding?: FindingView['detail']
  /** Sends the answer. A rejection's message is shown to the person as it is. */
  onAnswer: (option: string, text?: string) => Promise<void>
  /** Which problem of the review this is, when there is more than one. */
  position?: { n: number; of: number }
  touched?: readonly Touched[]
}) {
  const [choice, setChoice] = useState<string | null>(null)
  const [words, setWords] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDetail, setShowDetail] = useState(false)
  // A second click before the first has been answered must not send a second answer.
  const inFlight = useRef(false)
  const name = useId()
  const detailId = useId()

  // Words go with whichever option is chosen; with none chosen, the words alone are the answer ("other").
  const answer = choice ?? (words.trim() !== '' ? OTHER : null)
  const ready = answer !== null
  const locked = sending || sent

  async function confirm() {
    if (!ready || inFlight.current || sent) return
    inFlight.current = true
    setSending(true)
    setError(null)
    try {
      await onAnswer(answer!, words.trim() !== '' ? words.trim() : undefined)
      setSent(true)
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : strings.question.failed)
    } finally {
      inFlight.current = false
      setSending(false)
    }
  }

  const mentioned = touched.filter(t => question.touches.includes(t.number))
  // What the problem is, in the AI reviewer's own words: on the first level, so two questions of a kind never read the same.
  const said = finding?.problem.trim() ? finding.problem.trim() : null
  // One click away: where it is and how the app checked it; without the reviewer's sentence, the question's own detail.
  const place = said ? [finding!.where.trim() ? { label: strings.findings.detail.where, text: finding!.where.trim(), mono: false } : null, finding!.command.trim() ? { label: strings.findings.detail.command, text: finding!.command.trim(), mono: true } : null, finding!.outputTail.trim() ? { label: strings.findings.detail.output, text: finding!.outputTail.trim(), mono: true } : null].filter((x): x is { label: string; text: string; mono: boolean } => x !== null) : []
  const more = question.detail && (!said || question.kind === 'fix_held') ? question.detail : null
  const hasDetail = place.length > 0 || more !== null
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span aria-hidden="true" style={{ flex: 'none', width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', background: theme.waiting, color: '#1a1206', fontWeight: 900, fontSize: 17 }}>
          ?
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="factory-display" style={{ fontSize: 17, fontWeight: 700 }}>{strings.question.title}</div>
          <div style={{ fontSize: 12.5, color: '#d9c9a3' }}>{strings.question.waiting}</div>
        </div>
      </div>

      {position && position.of > 1 && (
        <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: '0.04em', color: theme.dim }}>{strings.question.position(position.n, position.of)}</div>
      )}

      <p style={{ margin: 0, fontSize: 15, lineHeight: 1.45, color: theme.ink, fontWeight: 600, overflowWrap: 'anywhere' }}>{explained(question.text, touched)}</p>
      {question.why && <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: theme.dim, overflowWrap: 'anywhere' }}>{explained(question.why, touched)}</p>}

      {mentioned.length > 0 && (
        <div style={{ display: 'grid', gap: 4, fontSize: 12.5, color: theme.dim }}>
          <span style={{ fontWeight: 700 }}>{strings.question.touchesTitle}</span>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
            {mentioned.map(t => (
              <li key={t.number} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '6px 8px', borderRadius: 8, border: `1px solid ${theme.border}`, background: '#0d1118', color: '#d6dce6', overflowWrap: 'anywhere' }}>
                <span style={{ flex: 'none', fontFamily: MONO, fontSize: 11.5, color: theme.waiting }}>{t.label}</span>
                <span>{t.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {said && (
        <div style={{ display: 'grid', gap: 4, padding: 10, borderRadius: 10, border: `1px solid ${theme.border}`, background: '#0d1118', minWidth: 0 }}>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: theme.waiting }}>{strings.question.aiSaid}</span>
          <span style={{ fontSize: 13, lineHeight: 1.5, color: '#d6dce6', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{explained(cut(said), touched)}</span>
        </div>
      )}

      {hasDetail && (
        <div style={{ display: 'grid', gap: 6 }}>
          <button
            type="button"
            className="factory-action"
            aria-expanded={showDetail}
            aria-controls={detailId}
            onClick={() => setShowDetail(v => !v)}
            style={{ justifySelf: 'start', background: 'none', border: 'none', padding: '6px 8px 6px 0', minHeight: 32, color: theme.running, cursor: 'pointer', fontSize: 12.5 }}
          >
            {strings.question.seeDetails}
          </button>
          {showDetail && (
            <div id={detailId} style={{ display: 'grid', gap: 8, padding: 10, borderRadius: 10, border: `1px solid ${theme.border}`, background: '#0d1118', minWidth: 0 }}>
              {place.map(p => (
                <div key={p.label} style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: theme.dim }}>{p.label}</span>
                  <span style={{ fontSize: 12.5, lineHeight: 1.5, color: '#d6dce6', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', ...(p.mono ? { fontFamily: MONO, fontSize: 12 } : {}) }}>{p.text}</span>
                </div>
              ))}
              {more && (
                <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: theme.waiting }}>{said ? strings.question.moreAbout : strings.question.aiSaid}</span>
                  <span style={{ fontSize: 12.5, lineHeight: 1.5, color: '#d6dce6', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{explained(more, touched)}</span>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <fieldset disabled={locked} style={{ margin: 0, padding: 0, border: 'none', minWidth: 0, display: 'grid', gap: 8 }}>
        <legend style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>{strings.question.choicesLabel}</legend>
        {question.options.map(o => {
          const chosen = choice === o.id
          return (
            <label
              key={o.id}
              className="factory-choice"
              style={{ display: 'flex', gap: 10, alignItems: 'flex-start', padding: '10px 12px', borderRadius: 10, border: `1px solid ${chosen ? theme.waiting : theme.border}`, background: chosen ? theme.tint('waiting', 0.1) : '#0d1118', cursor: locked ? 'not-allowed' : 'pointer' }}
            >
              <input
                type="radio"
                name={name}
                value={o.id}
                checked={chosen}
                onChange={() => setChoice(o.id)}
                style={{ flex: 'none', marginTop: 3, accentColor: theme.waiting }}
              />
              <span style={{ display: 'grid', gap: 3, minWidth: 0 }}>
                <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', fontSize: 14, fontWeight: 700, color: theme.ink }}>
                  {o.label}
                  {question.recommended === o.id && (
                    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#1a1206', background: theme.waiting, borderRadius: 999, padding: '2px 7px' }}>{strings.question.recommended}</span>
                  )}
                </span>
                <span style={{ fontSize: 12.5, lineHeight: 1.45, color: theme.dim, overflowWrap: 'anywhere' }}>{o.means}</span>
              </span>
            </label>
          )
        })}
        <label style={{ display: 'grid', gap: 4, fontSize: 12.5, fontWeight: 600, color: theme.dim }}>
          {choice === null ? strings.question.ownWordsLabel : strings.question.noteLabel}
          <textarea
            value={words}
            rows={3}
            placeholder={choice === null ? strings.question.ownWordsPlaceholder : strings.question.notePlaceholder}
            // Typing never changes a chosen option; the words are sent with it.
            onChange={e => setWords(e.target.value)}
            style={{ font: 'inherit', fontSize: 13, fontWeight: 400, padding: '8px 10px', boxSizing: 'border-box', width: '100%', resize: 'vertical', background: '#0b0e14', color: '#e6e9ef', border: `1px solid ${theme.border}`, borderRadius: 8 }}
          />
        </label>
      </fieldset>

      <button
        type="button"
        className="factory-action"
        disabled={!ready || locked}
        onClick={() => void confirm()}
        style={{ padding: '10px 12px', borderRadius: 8, border: `1px solid ${theme.waiting}`, background: ready && !locked ? theme.waiting : 'transparent', color: ready && !locked ? '#1a1206' : theme.skipped, fontWeight: 700, fontSize: 14, cursor: ready && !locked ? 'pointer' : 'not-allowed' }}
      >
        {sending ? strings.question.sending : strings.question.confirm}
      </button>
      {error && (
        <div role="alert" style={{ fontSize: 13, fontWeight: 600, color: theme.failed, lineHeight: 1.4 }}>
          {error}
        </div>
      )}
      {sent && (
        <div role="status" style={{ fontSize: 13, fontWeight: 600, color: theme.passed }}>
          {strings.question.sent}
        </div>
      )}
    </>
  )
}

/** The question card of a run: the panel, with the answer sent to the run and the record read again if it is refused. */
export function QuestionSection({
  runId,
  record,
  failed = false,
  mark = 0,
  readMark = 0,
  askedId = null,
  onChanged,
}: {
  runId: string
  record: ReviewRecord | null
  failed?: boolean
  /** The latest event that changes the record, and the one the shown record was read for. */
  mark?: number
  readMark?: number
  /** The question the events say is open. */
  askedId?: string | null
  onChanged: () => void
}) {
  // A record read before the latest event may be out of date: it is neither shown for a question it does not know, nor
  // taken as proof that nothing is waiting.
  const stale = readMark < mark
  const question = record?.question && !(stale && askedId !== null && record.question.id !== askedId) ? record.question : null
  // The question last shown, and the sentence the server last refused with, stay until a read succeeds with something else.
  const [shown, setShown] = useState<Question | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)
  if (question && shown?.id !== question.id) {
    setShown(question)
    setRefusal(null)
  }
  const retry = (
    <div role="alert" style={{ display: 'grid', gap: 8, fontSize: 13, color: theme.failed, lineHeight: 1.4 }}>
      {strings.question.loadFailed}
      <button type="button" className="factory-action" onClick={onChanged} style={{ justifySelf: 'start', minHeight: 32, padding: '6px 12px', borderRadius: 8, border: `1px solid ${theme.border}`, background: '#0f141c', color: '#e6e9ef', fontWeight: 700, cursor: 'pointer' }}>
        {strings.question.tryAgain}
      </button>
    </div>
  )
  if (!question) {
    if (record && !stale && !failed) {
      // Read after the latest event, and nothing is waiting any more: say so, with the server's own sentence when there was one.
      return (
        <div role="status" style={{ fontSize: 13.5, fontWeight: 600, color: theme.dim, lineHeight: 1.45 }}>
          {refusal ?? strings.question.closed}
        </div>
      )
    }
    if (failed) return retry
    return (
      <div aria-busy="true" aria-label={strings.question.title} style={{ display: 'grid', gap: 8 }}>
        <Bone height={20} width="60%" />
        <Bone height={70} radius={10} />
      </div>
    )
  }
  async function answer(option: string, text?: string): Promise<void> {
    let res: Response
    try {
      res = await fetch(`/api/runs/${encodeURIComponent(runId)}/questions/${encodeURIComponent(question!.id)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ option, ...(text !== undefined ? { text } : {}) }),
      })
    } catch {
      throw new Error(strings.question.failed)
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      const said = body?.error ?? strings.question.failed
      setRefusal(said)
      onChanged() // already answered, or no longer waiting: show what is there now
      throw new Error(said)
    }
    onChanged()
  }
  // Direct edit's pause is not a question about a problem: it is "what next, or is it done?", with its own panel.
  if (question.kind === 'direct') return <>{failed && retry}<DirectPause key={question.id} question={question} onAnswer={answer} /></>
  const order = displayOrder(record!.findings)
  const at = order.findIndex(f => f.id === question.findingId)
  return (
    <>
      {failed && retry}
      <QuestionPanel key={question.id} question={question} touched={record!.touched} onAnswer={answer} position={at >= 0 ? { n: at + 1, of: order.length } : undefined} {...(at >= 0 ? { finding: order[at]!.detail } : {})} />
    </>
  )
}

const d = strings.direct
/** After how many requests the panel says the task is getting big. */
export const MANY_REQUESTS = 5

/**
 * Direct edit between two requests: what was just built, a box for the next thing, and the button that ends it (the
 * tests and the review then run once, on everything). Says so when the task is getting big.
 */
export function DirectPause({ question, onAnswer }: { question: Question; onAnswer: (option: string, text?: string) => Promise<void> }) {
  const [words, setWords] = useState('')
  const [sending, setSending] = useState<'next' | 'done' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)
  const boxId = useId()
  const n = Number(/^direct-(\d+)$/.exec(question.findingId ?? '')?.[1] ?? 1)
  // The last request a task holds: the app only offers to finish.
  const last = question.text === d.lastText
  async function send(what: 'next' | 'done') {
    if (inFlight.current || (what === 'next' && words.trim() === '')) return
    inFlight.current = true
    setSending(what)
    setError(null)
    try {
      await (what === 'done' ? onAnswer('leave') : onAnswer(OTHER, words.trim()))
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : strings.question.failed)
      inFlight.current = false
      setSending(null)
    }
  }
  const busy = sending !== null
  return (
    <div data-testid="direct-pause" style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'grid', gap: 4 }}>
        <div className="factory-display" style={{ fontSize: 17, fontWeight: 700 }}>{d.pauseTitle}</div>
        <div style={{ fontSize: 13, color: theme.dim, lineHeight: 1.45 }}>{d.look} {d.pauseWhy}</div>
      </div>
      {question.detail && (
        <div style={{ display: 'grid', gap: 4, padding: '10px 12px', borderRadius: 10, border: `1px solid ${theme.border}`, background: '#0f141c' }}>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: theme.dim }}>{d.lastBuilt}</span>
          <span style={{ fontSize: 13.5, lineHeight: 1.45, overflowWrap: 'anywhere' }}>{cut(question.detail)}</span>
        </div>
      )}
      <div style={{ fontSize: 12, color: theme.dim }}>{d.count(n)}</div>
      {(n >= MANY_REQUESTS || last) && (
        <div role="note" data-testid="direct-many" style={{ padding: '9px 12px', borderRadius: 10, border: `1px solid ${theme.waiting}`, color: '#f3d9a4', fontSize: 13, lineHeight: 1.45 }}>{last ? d.lastText : d.many}</div>
      )}
      {!last && (
        <div style={{ display: 'grid', gap: 6 }}>
          <label htmlFor={boxId} style={{ fontSize: 13, fontWeight: 700 }}>{d.nextLabel}</label>
          <textarea
            id={boxId}
            value={words}
            disabled={busy}
            onChange={e => setWords(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send('next')
              }
            }}
            placeholder={d.nextPlaceholder}
            rows={4}
            style={{ resize: 'vertical', padding: 10, borderRadius: 10, border: `1px solid ${theme.border}`, background: '#0f141c', color: theme.ink, font: 'inherit', fontSize: 14, lineHeight: 1.45 }}
          />
          <button type="button" className="factory-action" disabled={busy || words.trim() === ''} onClick={() => void send('next')} style={{ justifySelf: 'end', minHeight: 34, padding: '7px 16px', borderRadius: 8, border: `1px solid ${theme.border}`, background: '#0f141c', color: theme.ink, fontWeight: 700, cursor: busy || words.trim() === '' ? 'default' : 'pointer', opacity: words.trim() === '' ? 0.5 : 1 }}>
            {sending === 'next' ? d.sending : d.send}
          </button>
        </div>
      )}
      <div style={{ display: 'grid', gap: 5, paddingTop: 12, borderTop: `1px solid ${theme.border}` }}>
        <button type="button" className="factory-action" data-testid="direct-done" disabled={busy} onClick={() => void send('done')} style={{ minHeight: 40, padding: '9px 16px', borderRadius: 9, border: 'none', background: theme.passed, color: '#0d1f12', fontWeight: 800, fontSize: 14.5, cursor: busy ? 'default' : 'pointer' }}>
          {sending === 'done' ? d.sending : d.done}
        </button>
        <span style={{ fontSize: 12, color: theme.dim, textAlign: 'center' }}>{d.doneHint}</span>
      </div>
      {error && <div role="alert" style={{ fontSize: 13, color: theme.failed }}>{error}</div>}
    </div>
  )
}
