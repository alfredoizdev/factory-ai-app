'use client'

import { useId, useRef, useState } from 'react'
import type { Question } from '@/engine/questions'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { Bone } from './Skeleton'
import type { ReviewRecord } from './useReviewRecord'

/** What an earlier decision or core area the question mentions says, in its own words. */
export type Touched = { number: number; label: string; kind: string; text: string }

const OTHER = 'other'
const MONO = 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace'

/** Puts the entry's own words next to its label; a number with nothing behind it is not shown at all. */
function explained(sentence: string, touched: readonly Touched[]): string {
  return sentence.replace(/\bD-(\d+)\b/g, (_m, n: string) => {
    const entry = touched.find(t => t.number === Number(n))
    return entry ? `${entry.label}: “${entry.text}”` : strings.question.earlierDecision
  })
}

/**
 * A question the review cannot answer for the person: one plain sentence, why it asks, a few choices each saying what
 * it means, the recommended one marked, and a box for their own words. One button answers it, once.
 */
export function QuestionPanel({
  question,
  onAnswer,
  position,
  touched = [],
}: {
  question: Question
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

  const ready = choice !== null && (choice !== OTHER || words.trim() !== '')
  const locked = sending || sent

  async function confirm() {
    if (!ready || inFlight.current || sent) return
    inFlight.current = true
    setSending(true)
    setError(null)
    try {
      await onAnswer(choice!, choice === OTHER ? words.trim() : undefined)
      setSent(true)
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : strings.question.failed)
    } finally {
      inFlight.current = false
      setSending(false)
    }
  }

  const mentioned = touched.filter(t => question.touches.includes(t.number))
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

      {question.detail && (
        <div style={{ display: 'grid', gap: 6 }}>
          <button
            type="button"
            className="factory-action"
            aria-expanded={showDetail}
            aria-controls={detailId}
            onClick={() => setShowDetail(v => !v)}
            style={{ justifySelf: 'start', background: 'none', border: 'none', padding: 0, color: theme.running, cursor: 'pointer', fontSize: 12.5 }}
          >
            {strings.question.seeDetails}
          </button>
          {showDetail && (
            <div id={detailId} style={{ display: 'grid', gap: 4, padding: 10, borderRadius: 10, border: `1px solid ${theme.border}`, background: '#0d1118' }}>
              <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.08em', textTransform: 'uppercase', color: theme.waiting }}>{strings.question.aiSaid}</span>
              <span style={{ fontSize: 12.5, lineHeight: 1.5, color: '#d6dce6', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{question.detail}</span>
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
                onChange={() => {
                  setChoice(o.id)
                  setWords('')
                }}
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
          {strings.question.ownWordsLabel}
          <textarea
            value={words}
            rows={3}
            placeholder={strings.question.ownWordsPlaceholder}
            onChange={e => {
              setWords(e.target.value)
              setChoice(e.target.value.trim() === '' ? null : OTHER)
            }}
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
export function QuestionSection({ runId, record, onChanged }: { runId: string; record: ReviewRecord | null; onChanged: () => void }) {
  const question = record?.question ?? null
  if (!question) {
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
      onChanged() // already answered, or no longer waiting: show what is there now
      throw new Error(body?.error ?? strings.question.failed)
    }
    onChanged()
  }
  // Which problem of the review this is, among the ones that are still problems.
  const open = record!.findings.filter(f => f.ending !== 'set_aside')
  const at = open.findIndex(f => f.id === question.findingId)
  return <QuestionPanel key={question.id} question={question} touched={record!.touched} onAnswer={answer} position={at >= 0 ? { n: at + 1, of: open.length } : undefined} />
}
