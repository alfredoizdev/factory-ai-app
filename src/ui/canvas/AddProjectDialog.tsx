'use client'

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { CheckName, ProjectAnalysis } from '@/engine/project-setup'
import type { AskMode } from '@/domain/ask-mode'
import { strings } from '@/ui/strings'
import { AskModeChoice } from './AskModeChoice'
import { theme } from '@/ui/theme'
import { WorkingSpinner } from './BlockCard'

const s = strings.setup
const EXTRA: readonly CheckName[] = ['lint', 'build', 'typecheck']

/**
 * Adding a project: pick its folder, see what the app found in it (and what is missing), choose the extra checks,
 * then create it. Its dependencies are installed once in the background after that, for every task to copy.
 */
export function AddProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (workflowId: string) => void }) {
  const [path, setPath] = useState('')
  const [analysis, setAnalysis] = useState<ProjectAnalysis | null>(null)
  const [name, setName] = useState('')
  const [testCommand, setTestCommand] = useState('')
  const [checks, setChecks] = useState<Set<CheckName>>(new Set())
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

  async function read(folder: string) {
    setBusy('read')
    setError(null)
    try {
      const res = await fetch('/api/projects/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: folder }) })
      const body = (await res.json().catch(() => null)) as (ProjectAnalysis & { error?: string }) | null
      if (!res.ok || !body) return setError(body?.error ?? s.readFailed)
      setAnalysis(body)
      setPath(body.root)
      setName(body.name)
      setTestCommand(body.commands.test ?? '')
      // Every extra check the project has is suggested; the person can untick any.
      setChecks(new Set(EXTRA.filter(c => body.commands[c])))
    } catch {
      setError(s.readFailed)
    } finally {
      setBusy(null)
    }
  }

  async function pick() {
    setBusy('pick')
    setError(null)
    try {
      const res = await fetch('/api/system/choose-folder', { method: 'POST' })
      const body = (await res.json().catch(() => null)) as { path?: string; cancelled?: boolean; error?: string } | null
      setBusy(null)
      if (body?.path) await read(body.path)
      else if (body?.error) setError(body.error)
    } catch {
      setBusy(null)
      setError(s.readFailed)
    }
  }

  async function create() {
    if (!analysis) return
    setBusy('create')
    setError(null)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path,
          name,
          testCommand: testCommand.trim() || null,
          checks: EXTRA.filter(c => checks.has(c) && analysis.commands[c]).map(c => ({ label: s.checkLabel[c], command: analysis.commands[c]! })),
          askMode,
        }),
      })
      const body = (await res.json().catch(() => null)) as { workflowId?: string; error?: string } | null
      if (!res.ok || !body?.workflowId) return setError(body?.error ?? s.createFailed)
      onCreated(body.workflowId)
    } catch {
      setError(s.createFailed)
    } finally {
      setBusy(null)
    }
  }

  // The folder on screen is the one whose results are shown: the button then says it is done, until the path changes.
  const checked = analysis !== null && path.trim() === analysis.root
  // What the app cannot work without. Everything else can be missing and is only pointed out.
  const missingRequired = analysis !== null && analysis.defaultBranch === null

  const field: CSSProperties = { padding: '10px 12px', background: theme.bg, color: 'inherit', border: `1px solid ${theme.border}`, borderRadius: 8, fontSize: 14, minWidth: 0 }
  const button = (primary: boolean): CSSProperties => ({
    padding: '8px 14px',
    borderRadius: 8,
    border: `1px solid ${primary ? theme.running : theme.border}`,
    background: primary ? theme.running : theme.card,
    color: primary ? '#fff' : 'inherit',
    fontWeight: 600,
    cursor: busy ? 'wait' : 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
  })

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 50, display: 'grid', placeItems: 'center', background: 'rgba(5, 7, 11, 0.6)' }}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label={s.title}
        tabIndex={-1}
        onClick={e => e.stopPropagation()}
        style={{ width: 'min(880px, calc(100% - 32px))', maxHeight: 'calc(100% - 48px)', overflowY: 'auto', display: 'grid', gap: 18, padding: 28, fontSize: 14, background: theme.card, border: `1px solid ${theme.border}`, borderRadius: 14, boxShadow: '0 24px 60px rgba(0,0,0,0.55)', outline: 'none' }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 className="factory-display" style={{ margin: 0, fontSize: 22 }}>{s.title}</h2>
          <button type="button" aria-label={s.close} onClick={onClose} style={{ background: 'none', border: 'none', color: theme.skipped, cursor: 'pointer', fontSize: 16 }}>
            ✕
          </button>
        </div>

        <div style={{ display: 'grid', gap: 6 }}>
          <span style={{ fontSize: 14.5, color: theme.dim }}>{s.folderHint}</span>
          <div style={{ display: 'flex', gap: 8 }}>
            <input aria-label={s.folder} value={path} onChange={e => setPath(e.target.value)} placeholder="/Users/you/projects/my-app" spellCheck={false} style={{ ...field, flex: 1, fontFamily: 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 13 }} />
            <button type="button" disabled={busy !== null} onClick={() => void pick()} style={button(false)}>
              {busy === 'pick' ? <WorkingSpinner blockId="pick" size={14} /> : null} {s.choose}
            </button>
            <button
              type="button"
              data-testid="check-folder"
              data-checked={checked}
              disabled={busy !== null || path.trim() === ''}
              title={checked ? s.checkedHint : s.readHint}
              onClick={() => void read(path)}
              style={checked ? { ...button(false), border: `1px solid ${theme.passed}`, color: theme.passed, background: 'rgba(34, 197, 94, 0.08)' } : button(!analysis)}
            >
              {busy === 'read' ? <WorkingSpinner blockId="read" size={14} /> : checked ? <LevelIcon level="ok" /> : null} {checked ? s.checked : s.read}
            </button>
          </div>
        </div>

        {analysis && (
          <>
            <label style={{ display: 'grid', gap: 6, fontSize: 14.5, color: theme.dim }}>
              {s.name}
              <input value={name} onChange={e => setName(e.target.value)} style={field} />
            </label>
            <div data-testid="setup-found" style={{ display: 'grid', gap: 9, padding: 16, background: '#0f141c', border: `1px solid ${theme.border}`, borderRadius: 10, fontSize: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: theme.dim }}>{s.found}</div>
              <Row level="ok" label={s.gitRepo} value={s.gitRepoFound} />
              <Row level={analysis.defaultBranch !== null ? 'ok' : 'required'} label={s.mainBranch} value={analysis.defaultBranch ?? s.noMainBranch} />
              <Row level={analysis.packageManager !== null ? 'ok' : 'optional'} label={s.packageManager} value={analysis.packageManager ?? s.noPackageJson} />
              <Row level={analysis.framework !== null ? 'ok' : 'optional'} label={s.framework} value={analysis.framework ?? s.unknown} />
              <Row level={analysis.commands.test ? 'ok' : 'optional'} label={s.tests} value={analysis.commands.test ? s.testsFound(analysis.commands.test) : s.testsNone} />
              <Row level={analysis.github.gh === 'ready' ? 'ok' : 'optional'} label={s.github} value={s.gh[analysis.github.gh](analysis.github.repo)} />
              <Row level={analysis.deploy.length > 0 ? 'ok' : 'optional'} label={s.deploy} value={analysis.deploy.length > 0 ? analysis.deploy.join(', ') : s.noDeploy} />
              <div data-testid="setup-legend" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', marginTop: 6, paddingTop: 10, borderTop: `1px solid ${theme.border}`, fontSize: 12.5, color: theme.dim }}>
                {(['ok', 'optional', 'required'] as const).map(l => (
                  <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <LevelIcon level={l} /> {s.legend[l]}
                  </span>
                ))}
              </div>
            </div>
            <label style={{ display: 'grid', gap: 6, fontSize: 14.5, color: theme.dim }}>
              {s.testCommand}
              <input value={testCommand} onChange={e => setTestCommand(e.target.value)} placeholder={s.noTests} spellCheck={false} style={{ ...field, fontFamily: 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12 }} />
              {!analysis.commands.test && testCommand.trim() === '' && (
                <span data-testid="no-tests-hint" style={{ fontSize: 13, lineHeight: 1.45, color: theme.dim }}>
                  {s.noTestsFound(EXTRA.some(c => analysis.commands[c]))}
                </span>
              )}
            </label>
            {EXTRA.some(c => analysis.commands[c]) && (
              <div style={{ display: 'grid', gap: 6 }}>
                <span style={{ fontSize: 14.5, color: theme.dim }}>{s.extraChecks}</span>
                {EXTRA.filter(c => analysis.commands[c]).map(c => (
                  <label key={c} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
                    <input
                      type="checkbox"
                      checked={checks.has(c)}
                      onChange={e =>
                        setChecks(prev => {
                          const next = new Set(prev)
                          if (e.target.checked) next.add(c)
                          else next.delete(c)
                          return next
                        })
                      }
                    />
                    {s.checkLabel[c]} <code style={{ fontSize: 11.5, color: theme.dim }}>{analysis.commands[c]}</code>
                  </label>
                ))}
              </div>
            )}
            <AskModeChoice value={askMode} onChange={setAskMode} showSmallChanges={false} fontSize={14} />
            <span style={{ fontSize: 12, color: theme.dim, lineHeight: 1.45 }}>{s.installNote(analysis.packageManager)}</span>
            {missingRequired && (
              <div role="alert" data-testid="fix-required" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14.5, color: theme.failed }}>
                <LevelIcon level="required" /> {s.fixRequired}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button type="button" disabled={busy !== null || name.trim() === '' || missingRequired} onClick={() => void create()} style={button(true)}>
                {busy === 'create' ? <WorkingSpinner blockId="create" size={14} /> : null} {s.create}
              </button>
              <button type="button" disabled={busy === 'create'} onClick={onClose} style={button(false)}>
                {s.cancel}
              </button>
            </div>
          </>
        )}
        {!analysis && (
          <button type="button" onClick={onClose} style={{ ...button(false), justifySelf: 'start' }}>
            {s.cancel}
          </button>
        )}
        {error && (
          <div role="alert" style={{ fontSize: 12.5, color: theme.failed }}>
            {error}
          </div>
        )}
      </div>
    </div>
  )
}

type Level = 'ok' | 'optional' | 'required'
const LEVEL_COLOR: Record<Level, string> = { ok: theme.passed, optional: theme.waiting, required: theme.failed }

/** Found (a tick), missing but not needed (a warning sign), or required and missing (a cross in a circle). */
function LevelIcon({ level, size = 16 }: { level: Level; size?: number }) {
  return (
    <svg data-level={level} viewBox="0 0 24 24" width={size} height={size} fill="none" stroke={LEVEL_COLOR[level]} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      {level === 'ok' && <path d="M5 12.5l4.5 4.5L19 7.5" />}
      {level === 'optional' && (
        <>
          <path d="M12 3.5L2.5 20h19L12 3.5z" strokeWidth="2" />
          <path d="M12 10v4.5M12 17.2v.1" />
        </>
      )}
      {level === 'required' && (
        <>
          <circle cx="12" cy="12" r="9" strokeWidth="2" />
          <path d="M9 9l6 6M15 9l-6 6" />
        </>
      )}
    </svg>
  )
}

function Row({ level, label, value }: { level: Level; label: string; value: ReactNode }) {
  return (
    <div data-level={level} style={{ display: 'grid', gridTemplateColumns: '18px 170px minmax(0, 1fr)', gap: 10, alignItems: 'center' }}>
      <LevelIcon level={level} />
      <span style={{ color: theme.dim }}>{label}</span>
      <span style={{ color: level === 'ok' ? '#e6e9ef' : LEVEL_COLOR[level], overflowWrap: 'anywhere' }}>{value}</span>
    </div>
  )
}
