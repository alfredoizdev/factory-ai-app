'use client'

import { useCallback, useEffect, useState } from 'react'
import type { FindingView } from '@/engine/finding-view'
import type { Question } from '@/engine/questions'
import type { Touched } from './QuestionPanel'
import type { Wire } from './useRunStream'

/** The problems the reviewers reported and how each ended, and the question the run waits on. */
export type ReviewRecord = { findings: FindingView[]; question: Question | null; touched: Touched[] }

/** What changes the record: a question asked or answered, reports checked, a problem resolved. */
const CHANGES_RECORD: ReadonlySet<string> = new Set(['node.question_asked', 'node.question_answered', 'node.findings_checked', 'node.finding_resolved'])

/** The sequence of the latest event that changed the record: read again exactly when it moves, never on a timer. */
export function recordMark(events: readonly Wire[]): number {
  for (let i = events.length - 1; i >= 0; i--) if (CHANGES_RECORD.has(events[i]!.type)) return events[i]!.sequence
  return 0
}

/** Reads the record when the run is opened and each time `mark` moves; `reload` reads it now (after an answer was refused). */
export function useReviewRecord(runId: string | null, mark: number): { record: ReviewRecord | null; reload: () => void } {
  const [held, setHeld] = useState<{ runId: string; record: ReviewRecord } | null>(null)
  const [again, setAgain] = useState(0)
  useEffect(() => {
    if (!runId) return
    let live = true
    fetch(`/api/runs/${encodeURIComponent(runId)}/findings`)
      .then(r => (r.ok ? (r.json() as Promise<ReviewRecord>) : null))
      .then(body => live && body && setHeld({ runId, record: body }))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [runId, mark, again])
  const reload = useCallback(() => setAgain(n => n + 1), [])
  // What was read for another run is never shown for this one.
  return { record: held && held.runId === runId ? held.record : null, reload }
}
