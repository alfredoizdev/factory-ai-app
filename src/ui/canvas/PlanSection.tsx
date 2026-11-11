'use client'

import { useEffect, useState, type ReactNode } from 'react'
import type { Job } from '@/engine/plan'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { WorkingSpinner } from './BlockCard'
import type { ComposerSend } from './Composer'
import { Bone } from './Skeleton'

/** How long the card waits for the run to move after the person's word before saying it has not. */
const PICKUP_WAIT_MS = 20_000

type Draft = { key: string; title: string; done: string }
const toDraft = (jobs: readonly Job[]): Draft[] => jobs.map((j, i) => ({ key: `j${i}-${Date.now()}`, title: j.title, done: j.done.join('\n') }))
const toJobs = (drafts: readonly Draft[]): Job[] =>
  drafts
    .map(d => ({ title: d.title.trim(), done: d.done.split('\n').map(l => l.trim()).filter(Boolean) }))
    .filter(j => j.title !== '')

/**
 * The plan, waiting for the person: the jobs the planner proposed, each editable, removable, with a way to add one,
 * and one button to build it as it stands. The box below asks the planner for a different plan instead.
 */
export function PlanSection({ runId, note, composer, onSent }: { runId: string; note: string; composer: (send: ComposerSend) => ReactNode; onSent: () => void }) {
  const [drafts, setDrafts] = useState<Draft[] | null>(null)
  const [busy, setBusy] = useState<'build' | 'replan' | null>(null)
  const [outcome, setOutcome] = useState<{ text: string; ok: boolean } | null>(null)
  const [stalled, setStalled] = useState(false)

  useEffect(() => {
    let live = true
    fetch(`/api/runs/${runId}/plan`)
      .then(r => (r.ok ? (r.json() as Promise<{ plan: { jobs: Job[] } | null }>) : null))
      .then(d => live && setDrafts(toDraft(d?.plan?.jobs ?? [])))
      .catch(() => live && setDrafts([]))
    return () => {
      live = false
    }
  }, [runId])

  const sent = outcome?.ok === true
  useEffect(() => {
    if (!sent) return
    const t = setTimeout(() => setStalled(true), PICKUP_WAIT_MS)
    return () => clearTimeout(t)
  }, [sent])

  async function send(body: unknown, what: 'build' | 'replan') {
    setBusy(what)
    setOutcome(null)
    try {
      const res = await fetch(`/api/runs/${runId}/plan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const answer = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) return setOutcome({ ok: false, text: answer?.error ?? strings.run.startFailed })
      setOutcome({ ok: true, text: what === 'build' ? strings.plan.building_sent : strings.plan.replanned })
      if (what === 'replan') onSent()
    } catch {
      setOutcome({ ok: false, text: strings.run.startFailed })
    } finally {
      setBusy(null)
    }
  }

  const edit = (key: string, patch: Partial<Draft>) => setDrafts(ds => (ds ?? []).map(d => (d.key === key ? { ...d, ...patch } : d)))
  const jobs = drafts ? toJobs(drafts) : []
  const locked = busy !== null || sent
  const field = { width: '100%', boxSizing: 'border-box', background: '#0b0e14', color: '#d6dce6', border: `1px solid ${theme.border}`, borderRadius: 6, font: 'inherit' } as const

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span aria-hidden="true" style={{ width: 30, height: 30, borderRadius: 8, display: 'grid', placeItems: 'center', background: theme.waiting, color: '#1a1206' }}>
          <ListIcon />
        </span>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{strings.plan.title}</div>
          <div style={{ fontSize: 12.5, color: '#d9c9a3' }}>{strings.plan.waiting}</div>
        </div>
      </div>

      {drafts === null ? (
        <div aria-busy="true" style={{ display: 'grid', gap: 8 }}>
          <Bone height={70} radius={10} />
          <Bone height={70} radius={10} />
        </div>
      ) : (
        <ol data-testid="plan-jobs" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 8, maxHeight: 320, overflowY: 'auto', scrollbarWidth: 'thin', scrollbarColor: `${theme.floorLine} transparent` }}>
          {drafts.map((d, i) => (
            <li key={d.key} style={{ display: 'grid', gap: 6, padding: 10, borderRadius: 10, border: `1px solid ${theme.border}`, background: '#0d1118' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span aria-hidden="true" style={{ flex: 'none', width: 20, height: 20, borderRadius: '50%', display: 'grid', placeItems: 'center', fontSize: 11, fontWeight: 800, background: theme.tint('waiting', 0.2), color: theme.waiting }}>
                  {i + 1}
                </span>
                <input
                  aria-label={strings.plan.jobLabel(i + 1)}
                  value={d.title}
                  placeholder={strings.plan.jobPlaceholder}
                  disabled={locked}
                  onChange={e => edit(d.key, { title: e.target.value })}
                  style={{ ...field, flex: 1, minWidth: 0, padding: '6px 8px', fontSize: 13, fontWeight: 600 }}
                />
                <button
                  type="button"
                  aria-label={strings.plan.removeJob(i + 1)}
                  title={strings.plan.removeJob(i + 1)}
                  disabled={locked}
                  onClick={() => setDrafts(ds => (ds ?? []).filter(x => x.key !== d.key))}
                  style={{ flex: 'none', width: 26, height: 26, display: 'grid', placeItems: 'center', padding: 0, background: 'none', border: 'none', color: theme.skipped, cursor: 'pointer' }}
                >
                  <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4" />
                  </svg>
                </button>
              </div>
              <label style={{ display: 'grid', gap: 3, fontSize: 11, color: theme.dim, paddingLeft: 28 }}>
                {strings.plan.doneLabel}
                <textarea
                  value={d.done}
                  rows={Math.max(1, d.done.split('\n').length)}
                  placeholder={strings.plan.donePlaceholder}
                  disabled={locked}
                  onChange={e => edit(d.key, { done: e.target.value })}
                  style={{ ...field, padding: '5px 8px', fontSize: 12, lineHeight: 1.45, resize: 'vertical' }}
                />
              </label>
            </li>
          ))}
        </ol>
      )}
      {drafts !== null && !locked && (
        <button
          type="button"
          onClick={() => setDrafts(ds => [...(ds ?? []), { key: `new-${Date.now()}`, title: '', done: '' }])}
          style={{ justifySelf: 'start', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderRadius: 6, border: `1px dashed ${theme.border}`, background: 'transparent', color: '#d6dce6', fontSize: 12.5, fontWeight: 600, cursor: 'pointer' }}
        >
          <span aria-hidden="true">+</span> {strings.plan.addJob}
        </button>
      )}

      {!sent && (
        <button
          type="button"
          disabled={locked || jobs.length === 0}
          onClick={() => void send({ action: 'build', jobs }, 'build')}
          style={{ padding: '9px 12px', borderRadius: 8, border: `1px solid ${theme.passed}`, background: jobs.length > 0 ? theme.passed : 'transparent', color: jobs.length > 0 ? '#07110a' : theme.skipped, fontWeight: 700, cursor: locked ? 'wait' : jobs.length === 0 ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8 }}
        >
          {busy === 'build' ? <WorkingSpinner blockId="plan-build" size={16} /> : <span aria-hidden="true">▶</span>} {busy === 'build' ? strings.plan.building : strings.plan.build}
        </button>
      )}

      {!sent && (
        <div style={{ paddingTop: 10, borderTop: `1px solid ${theme.lineSoft}`, display: 'grid' }}>
          {composer({ label: strings.plan.replan, onSend: () => void send({ action: 'replan', note }, 'replan'), enabled: !locked && note.trim() !== '' })}
        </div>
      )}

      {outcome && (
        <div role={outcome.ok ? 'status' : 'alert'} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, fontWeight: 600, color: outcome.ok ? theme.passed : theme.failed }}>
          {outcome.ok && !stalled && <WorkingSpinner blockId="plan-sent" size={16} />}
          {outcome.text}
        </div>
      )}
      {sent && stalled && (
        <div role="alert" style={{ fontSize: 12.5, color: theme.waiting, lineHeight: 1.4 }}>
          {strings.plan.notPickedUp}
        </div>
      )}
    </>
  )
}

/** A plan: three lines with bullets. */
function ListIcon() {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M6 4h7.5M6 8h7.5M6 12h7.5M2.5 4h.01M2.5 8h.01M2.5 12h.01" />
    </svg>
  )
}
