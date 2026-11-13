'use client'

import type { CheckName, ProjectAnalysis } from '@/engine/project-setup'
import { strings } from '@/ui/strings'
import { brand } from '@/ui/brand'
import { theme } from '@/ui/theme'
import { WorkingSpinner } from '../BlockCard'
import { button, field, hint, LevelIcon, mono, Row } from './parts'

const s = strings.setup
export const EXTRA: readonly CheckName[] = ['lint', 'build', 'typecheck']

export type Existing = { path: string; name: string; testCommand: string; checks: ReadonlySet<CheckName>; coreAreas: readonly string[] }

/**
 * A project that already has code: the person points at its folder, the app reads it and shows what it found, and
 * only what is missing is asked for. Nothing is changed in the folder.
 */
export function ExistingStep({
  value,
  onChange,
  analysis,
  busy,
  onPick,
  onRead,
}: {
  value: Existing
  onChange: (next: Existing) => void
  analysis: ProjectAnalysis | null
  busy: 'pick' | 'read' | 'create' | null
  onPick: () => void
  onRead: () => void
}) {
  // The folder on screen is the one whose results are shown: the button then says it is done, until the path changes.
  const checked = analysis !== null && value.path.trim() === analysis.root
  const folders = analysis?.folders ?? []
  const toggle = <T,>(set: ReadonlySet<T>, item: T, on: boolean) => {
    const next = new Set(set)
    if (on) next.add(item)
    else next.delete(item)
    return next
  }
  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div style={{ display: 'grid', gap: 6 }}>
        <span style={{ fontSize: 14.5, color: brand.quiet }}>{s.folderHint}</span>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input aria-label={s.folder} value={value.path} onChange={e => onChange({ ...value, path: e.target.value })} placeholder="/Users/you/projects/my-app" spellCheck={false} style={{ ...field, ...mono, flex: '1 1 240px' }} />
          <button type="button" disabled={busy !== null} onClick={onPick} style={button(false, busy !== null)}>
            {busy === 'pick' ? <WorkingSpinner blockId="pick" size={14} /> : null} {s.choose}
          </button>
          <button
            type="button"
            data-testid="check-folder"
            data-checked={checked}
            disabled={busy !== null || value.path.trim() === ''}
            title={checked ? s.checkedHint : s.readHint}
            onClick={onRead}
            style={checked ? { ...button(false), border: `1px solid ${theme.passed}`, color: theme.passed, background: 'rgba(121, 220, 139, 0.08)' } : button(!analysis, busy !== null)}
          >
            {busy === 'read' ? <WorkingSpinner blockId="read" size={14} /> : checked ? <LevelIcon level="ok" /> : null} {checked ? s.checked : s.read}
          </button>
        </div>
      </div>

      {analysis && (
        <>
          <label style={{ display: 'grid', gap: 6, fontSize: 14.5, color: brand.quiet }}>
            {s.name}
            <input value={value.name} onChange={e => onChange({ ...value, name: e.target.value })} style={field} />
          </label>
          <div data-testid="setup-found" style={{ display: 'grid', gap: 9, padding: 16, background: brand.bg, border: `1px solid ${brand.line}`, borderRadius: 10, fontSize: 14 }}>
            <div style={{ fontSize: 12, fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: brand.quiet }}>{s.found}</div>
            <Row level="ok" label={s.gitRepo} value={s.gitRepoFound} />
            <Row level={analysis.defaultBranch !== null ? 'ok' : 'required'} label={s.mainBranch} value={analysis.defaultBranch ?? s.noMainBranch} />
            {analysis.defaultBranch !== null && analysis.currentBranch !== undefined && (
              <Row level={analysis.currentBranch === analysis.defaultBranch ? 'ok' : 'optional'} label={s.folderOn} value={analysis.currentBranch === analysis.defaultBranch ? s.folderOnMain(analysis.defaultBranch) : s.folderOnOther(analysis.currentBranch, analysis.defaultBranch)} />
            )}
            <Row level={analysis.packageManager !== null ? 'ok' : 'optional'} label={s.packageManager} value={analysis.packageManager ?? s.noPackageJson} />
            <Row level={analysis.framework !== null ? 'ok' : 'optional'} label={s.framework} value={analysis.framework ?? s.unknown} />
            <Row level={analysis.commands.test ? 'ok' : 'optional'} label={s.tests} value={analysis.commands.test ? s.testsFound(analysis.commands.test) : s.testsNone} />
            <Row level={analysis.github.gh === 'ready' ? 'ok' : 'optional'} label={s.github} value={s.gh[analysis.github.gh](analysis.github.repo)} />
            <Row level={analysis.deploy.length > 0 ? 'ok' : 'optional'} label={s.deploy} value={analysis.deploy.length > 0 ? analysis.deploy.join(', ') : s.noDeploy} />
            <div data-testid="setup-legend" style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 18px', marginTop: 6, paddingTop: 10, borderTop: `1px solid ${brand.line}`, fontSize: 12.5, color: brand.quiet }}>
              {(['ok', 'optional', 'required'] as const).map(l => (
                <span key={l} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <LevelIcon level={l} /> {s.legend[l]}
                </span>
              ))}
            </div>
          </div>
          <label style={{ display: 'grid', gap: 6, fontSize: 14.5, color: brand.quiet }}>
            {s.testCommand}
            <input value={value.testCommand} onChange={e => onChange({ ...value, testCommand: e.target.value })} placeholder={s.noTests} spellCheck={false} style={{ ...field, ...mono, fontSize: 12 }} />
            {!analysis.commands.test && value.testCommand.trim() === '' && (
              <span data-testid="no-tests-hint" style={hint}>
                {s.noTestsFound(EXTRA.some(c => analysis.commands[c]))}
              </span>
            )}
          </label>
          {EXTRA.some(c => analysis.commands[c]) && (
            <div style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 14.5, color: brand.quiet }}>{s.extraChecks}</span>
              {EXTRA.filter(c => analysis.commands[c]).map(c => (
                <label key={c} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14 }}>
                  <input type="checkbox" checked={value.checks.has(c)} onChange={e => onChange({ ...value, checks: toggle(value.checks, c, e.target.checked) })} />
                  {s.checkLabel[c]} <code style={{ fontSize: 11.5, color: brand.quiet }}>{analysis.commands[c]}</code>
                </label>
              ))}
            </div>
          )}
          {folders.length > 0 && (
            // Folded away: most people never need it, since sign-in, payments and the database already stop for them.
            <details data-testid="ask-before" style={{ fontSize: 13.5, color: brand.quiet }}>
              <summary style={{ cursor: 'pointer' }}>{strings.wizard.found.askBefore}</summary>
              <div role="group" aria-label={strings.wizard.found.askBefore} style={{ display: 'grid', gap: 6, marginTop: 8 }}>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px' }}>
                {folders.map(f => (
                  <label key={f} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13.5 }}>
                    <input type="checkbox" checked={value.coreAreas.includes(f)} onChange={e => onChange({ ...value, coreAreas: e.target.checked ? [...value.coreAreas, f] : value.coreAreas.filter(x => x !== f) })} />
                    <code style={{ fontSize: 12.5 }}>{f}</code>
                  </label>
                ))}
              </div>
              <span style={hint}>{strings.wizard.found.askBeforeHint}</span>
              </div>
            </details>
          )}
          <span style={{ fontSize: 12, color: brand.quiet, lineHeight: 1.45 }}>{s.installNote(analysis.packageManager)}</span>
          {analysis.defaultBranch === null && (
            <div role="alert" data-testid="fix-required" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14.5, color: theme.failed }}>
              <LevelIcon level="required" /> {s.fixRequired}
            </div>
          )}
        </>
      )}
    </div>
  )
}
