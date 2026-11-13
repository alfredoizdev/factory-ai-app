'use client'

import { useEffect, useRef, useState } from 'react'
import type { AskMode } from '@/domain/ask-mode'
import { DEFAULT_MODELS, MODEL_STEPS, presetOf, type StepModels } from '@/domain/models'
import { listed, NO_STACK, stackNames, type Stack } from '@/domain/stack'
import type { ProjectAnalysis } from '@/engine/project-setup'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'
import { AskModeChoice } from './AskModeChoice'
import { WorkingSpinner } from './BlockCard'
import { BuildStep } from './wizard/BuildStep'
import { EXTRA, ExistingStep, type Existing } from './wizard/ExistingStep'
import { ModelsStep } from './wizard/ModelsStep'
import { button, choice, hint, lead, StepBar, SummaryRow } from './wizard/parts'
import { folderName, WhereStep, type Where } from './wizard/WhereStep'

const s = strings.setup
const w = strings.wizard

type Way = 'scratch' | 'existing'
type Step = 'start' | 'build' | 'where' | 'existing' | 'models' | 'review'
const STEPS: Record<Way, readonly Step[]> = {
  scratch: ['start', 'build', 'where', 'models', 'review'],
  existing: ['start', 'existing', 'models', 'review'],
}
const STEP_NAME: Record<Step, string> = { start: w.steps.start, build: w.steps.build, where: w.steps.where, existing: w.steps.folder, models: w.steps.models, review: w.steps.review }

/** Where the first task of a project made from scratch waits for the canvas to put it in the task box, once. */
export const firstTaskKey = (workflowId: string) => `factory.firstTask.${workflowId}`

/**
 * "New project": a few short screens. Two ways in: from scratch (what to build, where it lives, tests) or a folder
 * that already has code (the app reads it and shows what it found). Both then choose the model of each step and
 * check everything on a last screen before the project is created. Nothing is created until that last button.
 */
export function AddProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (workflowId: string) => void }) {
  const [way, setWay] = useState<Way>('scratch')
  const [at, setAt] = useState(0)
  const [stack, setStack] = useState<Stack>(NO_STACK)
  const [where, setWhere] = useState<Where>({ name: '', path: '', githubUrl: '', addTests: true })
  // The folder the person chose to put the new project in; its own folder is named after the project until they type a path.
  const [parent, setParent] = useState<string | null>(null)
  const [existing, setExisting] = useState<Existing>({ path: '', name: '', testCommand: '', checks: new Set(), coreAreas: [] })
  const [analysis, setAnalysis] = useState<ProjectAnalysis | null>(null)
  const [models, setModels] = useState<StepModels>(DEFAULT_MODELS)
  const [askMode, setAskMode] = useState<AskMode>('what_matters')
  const [busy, setBusy] = useState<'pick' | 'read' | 'create' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    panel.current?.focus({ preventScroll: true })
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const steps = STEPS[way]
  const step = steps[at]!
  const go = (to: number) => {
    setError(null)
    setAt(to)
    panel.current?.scrollTo?.({ top: 0 })
  }

  async function chooseFolder(): Promise<string | null> {
    setBusy('pick')
    setError(null)
    try {
      const res = await fetch('/api/system/choose-folder', { method: 'POST' })
      const body = (await res.json().catch(() => null)) as { path?: string; cancelled?: boolean; error?: string } | null
      if (body?.error) setError(body.error)
      return body?.path ?? null
    } catch {
      setError(s.readFailed)
      return null
    } finally {
      setBusy(null)
    }
  }

  async function read(folder: string) {
    setBusy('read')
    setError(null)
    try {
      const res = await fetch('/api/projects/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: folder }) })
      const body = (await res.json().catch(() => null)) as (ProjectAnalysis & { error?: string }) | null
      if (!res.ok || !body) return setError(body?.error ?? s.readFailed)
      setAnalysis(body)
      // Every extra check the project has is suggested; the person can untick any.
      setExisting({ path: body.root, name: body.name, testCommand: body.commands.test ?? '', checks: new Set(EXTRA.filter(c => body.commands[c])), coreAreas: [] })
    } catch {
      setError(s.readFailed)
    } finally {
      setBusy(null)
    }
  }

  async function pickExisting() {
    const path = await chooseFolder()
    if (path) await read(path)
  }

  async function pickParent() {
    const path = await chooseFolder()
    if (!path) return
    setParent(path)
    setWhere(v => ({ ...v, path: `${path.replace(/\/+$/, '')}/${folderName(v.name)}` }))
  }

  /** While the folder is still the one the app named, it follows the project's name. */
  function changeWhere(next: Where) {
    const auto = parent !== null && where.path === `${parent.replace(/\/+$/, '')}/${folderName(where.name)}`
    setWhere(auto && next.name !== where.name && next.path === where.path ? { ...next, path: `${parent!.replace(/\/+$/, '')}/${folderName(next.name)}` } : next)
  }

  const chosenModels = presetOf(models) === 'balanced' ? {} : { models }

  async function create() {
    setBusy('create')
    setError(null)
    try {
      const res =
        way === 'scratch'
          ? await fetch('/api/projects/scratch', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ path: where.path.trim(), name: where.name.trim(), githubUrl: where.githubUrl.trim() || null, stack, addTests: where.addTests, askMode, ...chosenModels }),
            })
          : await fetch('/api/projects', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                path: existing.path,
                name: existing.name,
                testCommand: existing.testCommand.trim() || null,
                checks: EXTRA.filter(c => existing.checks.has(c) && analysis?.commands[c]).map(c => ({ label: s.checkLabel[c], command: analysis!.commands[c]! })),
                askMode,
                ...chosenModels,
                ...(existing.coreAreas.length > 0 ? { coreAreas: existing.coreAreas } : {}),
              }),
            })
      const body = (await res.json().catch(() => null)) as { workflowId?: string; firstTask?: string; error?: string } | null
      if (!res.ok || !body?.workflowId) return setError(body?.error ?? s.createFailed)
      if (body.firstTask) {
        try {
          window.sessionStorage.setItem(firstTaskKey(body.workflowId), body.firstTask)
        } catch {
          // Without it the task box starts empty; the project is still there.
        }
      }
      onCreated(body.workflowId)
    } catch {
      setError(s.createFailed)
    } finally {
      setBusy(null)
    }
  }

  // What each screen needs before the person can go on. Everything else can be missing and is only pointed out.
  const ready: Record<Step, boolean> = {
    start: true,
    build: true,
    where: where.name.trim() !== '' && where.path.trim().startsWith('/'),
    existing: analysis !== null && analysis.defaultBranch !== null && existing.path.trim() === analysis.root && existing.name.trim() !== '',
    models: true,
    review: true,
  }
  const names = stackNames(stack)
  const modelWord = (k: (typeof MODEL_STEPS)[number]) => w.models.choice[models[k]]

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'grid', placeItems: 'center', background: 'rgba(5, 7, 11, 0.6)' }}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={w.title}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        style={{ width: 'min(760px, calc(100% - 32px))', maxHeight: 'calc(100% - 48px)', overflowY: 'auto', display: 'grid', gap: 18, padding: 28, fontSize: 14, background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 14, boxShadow: '0 24px 60px rgba(0,0,0,0.55)', outline: 'none' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 className="factory-display" style={{ margin: 0, fontSize: 22 }}>{w.title}</h2>
          <button type="button" aria-label={s.close} onClick={onClose} style={{ background: 'none', border: 'none', color: theme.skipped, cursor: 'pointer', fontSize: 16 }}>
            ✕
          </button>
        </div>
        <StepBar steps={steps.map(k => STEP_NAME[k])} current={at} />

        {step === 'start' && (
          <div style={{ display: 'grid', gap: 12 }}>
            <h3 style={lead}>{w.start.lead}</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
              {(['scratch', 'existing'] as const).map(k => (
                <button key={k} type="button" data-testid={`way-${k}`} aria-pressed={way === k} onClick={() => setWay(k)} style={{ ...choice(way === k), padding: '18px 16px', display: 'grid', gap: 6, textAlign: 'left' }}>
                  <strong style={{ fontSize: 16 }}>{k === 'scratch' ? w.start.scratch : w.start.existing}</strong>
                  <span style={{ fontSize: 13.5, lineHeight: 1.45, color: theme.dim }}>{k === 'scratch' ? w.start.scratchHint : w.start.existingHint}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {step === 'build' && <BuildStep stack={stack} onChange={setStack} />}
        {step === 'where' && <WhereStep value={where} onChange={changeWhere} onChooseParent={() => void pickParent()} picking={busy === 'pick'} />}
        {step === 'existing' && <ExistingStep value={existing} onChange={setExisting} analysis={analysis} busy={busy} onPick={() => void pickExisting()} onRead={() => void read(existing.path)} />}
        {step === 'models' && <ModelsStep models={models} onChange={setModels} />}
        {step === 'review' && (
          <div style={{ display: 'grid', gap: 14 }}>
            <h3 style={lead}>{w.review.lead}</h3>
            <div data-testid="wizard-summary" style={{ display: 'grid', gap: 8, padding: 16, background: '#0f141c', border: `1px solid ${theme.border}`, borderRadius: 10 }}>
              <SummaryRow label={w.review.start} value={way === 'scratch' ? w.review.fromScratch : w.review.fromCode} />
              <SummaryRow label={s.name} value={way === 'scratch' ? where.name.trim() : existing.name.trim()} />
              {way === 'scratch' ? (
                <>
                  <SummaryRow label={w.review.build} value={names.length > 0 ? listed(names) : w.review.agentsChoose} />
                  <SummaryRow label={w.review.folder} value={where.path.trim()} />
                  <SummaryRow label={w.review.github} value={where.githubUrl.trim() || w.review.notConnected} />
                  <SummaryRow label={w.review.tests} value={where.addTests ? w.review.testsYes : w.review.testsNo} />
                </>
              ) : (
                <>
                  <SummaryRow label={w.review.build} value={analysis?.framework ?? s.unknown} />
                  <SummaryRow label={w.review.folder} value={existing.path} />
                  <SummaryRow label={w.review.github} value={analysis?.github.repo ?? w.review.notConnected} />
                  <SummaryRow label={w.review.tests} value={existing.testCommand.trim() || w.review.testsNone} />
                  {existing.coreAreas.length > 0 && <SummaryRow label={w.review.askBefore} value={existing.coreAreas.join(', ')} />}
                </>
              )}
              <SummaryRow label={w.review.models} value={w.review.modelsLine(modelWord('plan'), modelWord('build'), modelWord('review'))} />
            </div>
            <AskModeChoice value={askMode} onChange={setAskMode} showSmallChanges={false} fontSize={14} />
            {way === 'scratch' && <p style={hint}>{w.review.scratchNote}</p>}
          </div>
        )}

        {error && (
          <div role="alert" style={{ fontSize: 13.5, lineHeight: 1.45, color: theme.failed }}>
            {error}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <button type="button" disabled={busy === 'create'} onClick={at === 0 ? onClose : () => go(at - 1)} style={button(false)}>
            {at === 0 ? s.cancel : w.back}
          </button>
          {step === 'review' ? (
            <button type="button" disabled={busy !== null} onClick={() => void create()} style={button(true, busy !== null)}>
              {busy === 'create' ? <WorkingSpinner blockId="create" size={14} /> : null} {s.create}
            </button>
          ) : (
            <button type="button" disabled={!ready[step] || busy !== null} onClick={() => go(at + 1)} style={{ ...button(true), opacity: ready[step] ? 1 : 0.5 }}>
              {w.next}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
