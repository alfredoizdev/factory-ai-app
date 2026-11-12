'use client'

import { useState } from 'react'
import type { ProjectSettings } from '@/engine/project-settings'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'

const field = {
  padding: '6px 10px',
  background: theme.card,
  color: 'inherit',
  border: `1px solid ${theme.border}`,
  borderRadius: 6,
  fontFamily: 'var(--font-mono), ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 12.5,
}

/**
 * Where a real agent works and what counts as its tests. Shown only while Claude is the chosen agent, with the
 * plain warning that it works on its own and is not sandboxed — the person should not have to infer that.
 */
export function AgentSettings({ settings, onSaved }: { settings: ProjectSettings; onSaved: (next: ProjectSettings) => void }) {
  const [repoPath, setRepoPath] = useState(settings.repoPath ?? '')
  const [testCommand, setTestCommand] = useState(settings.testCommand ?? '')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ text: string; ok: boolean } | null>(null)
  // What is on the server. The button only says "Saved" while the fields still match it: an edit after a save is
  // unsaved again, and the button must not keep claiming otherwise.
  const [stored, setStored] = useState({ repoPath: settings.repoPath ?? '', testCommand: settings.testCommand ?? '' })
  const unchanged = repoPath.trim() === stored.repoPath && testCommand.trim() === stored.testCommand
  const state: 'saving' | 'saved' | 'failed' | 'idle' = busy
    ? 'saving'
    : message?.ok && unchanged
      ? 'saved'
      : message && !message.ok
        ? 'failed'
        : 'idle'
  const tone = state === 'saved' ? theme.passed : state === 'failed' ? theme.failed : theme.border

  const [choosing, setChoosing] = useState(false)
  const [autoLow, setAutoLow] = useState(settings.askMode === 'small_changes' || settings.askMode === 'what_matters')

  // The switch saves on its own: it is one decision, and leaving it half-set would be worse than one more request.
  async function toggleAutoLow(on: boolean) {
    setAutoLow(on)
    try {
      const res = await fetch(`/api/projects/${settings.projectId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ askMode: on ? 'small_changes' : 'everything' }),
      })
      const body = (await res.json().catch(() => null)) as (ProjectSettings & { error?: string }) | null
      if (!res.ok || !body) {
        setAutoLow(!on)
        return setMessage({ text: body?.error ?? strings.settings.saveFailed, ok: false })
      }
      onSaved(body)
    } catch {
      setAutoLow(!on)
      setMessage({ text: strings.settings.saveFailed, ok: false })
    }
  }

  async function save(values: { repoPath: string; testCommand: string } = { repoPath, testCommand }) {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/projects/${settings.projectId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repoPath: values.repoPath.trim() || undefined, testCommand: values.testCommand.trim() || null }),
      })
      const body = (await res.json().catch(() => null)) as (ProjectSettings & { error?: string }) | null
      if (!res.ok || !body) return setMessage({ text: body?.error ?? strings.settings.saveFailed, ok: false })
      setRepoPath(body.repoPath ?? '')
      setTestCommand(body.testCommand ?? '')
      setStored({ repoPath: body.repoPath ?? '', testCommand: body.testCommand ?? '' })
      onSaved(body)
      setMessage({ text: strings.settings.saved, ok: true })
    } catch {
      setMessage({ text: strings.settings.saveFailed, ok: false })
    } finally {
      setBusy(false)
    }
  }

  // The Mac's own folder window: pick the project, and its path and test command fill in and save in one go.
  async function chooseFolder() {
    setChoosing(true)
    setMessage(null)
    try {
      const res = await fetch('/api/system/choose-folder', { method: 'POST' })
      const body = (await res.json().catch(() => null)) as { path?: string; testCommand?: string | null; cancelled?: boolean; error?: string } | null
      if (!res.ok || !body) return setMessage({ text: body?.error ?? strings.settings.pickerFailed, ok: false })
      if (body.cancelled || !body.path) return
      const next = { repoPath: body.path, testCommand: body.testCommand ?? testCommand }
      setRepoPath(next.repoPath)
      setTestCommand(next.testCommand)
      await save(next)
    } catch {
      setMessage({ text: strings.settings.pickerFailed, ok: false })
    } finally {
      setChoosing(false)
    }
  }

  return (
    <section data-testid="agent-settings" style={{ display: 'grid', gap: 8 }}>
      <span style={{ fontSize: 12, color: theme.waiting, lineHeight: 1.4 }}>{strings.settings.notSandboxed}</span>
      <label style={{ display: 'grid', gap: 4, fontSize: 12.5, color: theme.dim }}>
        {strings.settings.repoLabel}
        <input
          aria-label={strings.settings.repoLabel}
          value={repoPath}
          placeholder={strings.settings.repoPlaceholder}
          onChange={e => setRepoPath(e.target.value)}
          style={{ ...field, width: '100%', boxSizing: 'border-box' }}
        />
      </label>
      <button
        type="button"
        onClick={chooseFolder}
        disabled={choosing || busy}
        style={{
          padding: '7px 12px',
          background: theme.card,
          color: 'inherit',
          border: `1px dashed ${theme.border}`,
          borderRadius: 6,
          cursor: choosing ? 'wait' : 'pointer',
          textAlign: 'left',
          fontSize: 13,
        }}
      >
        📁 {strings.settings.choose}
      </button>
      {choosing && (
        <span role="status" style={{ fontSize: 12, color: theme.dim, lineHeight: 1.4 }}>
          {strings.settings.choosing} {strings.settings.choosingHint}
        </span>
      )}
      <label style={{ display: 'grid', gap: 4, fontSize: 12.5, color: theme.dim }}>
        {strings.settings.testLabel}
        <input
          aria-label={strings.settings.testLabel}
          value={testCommand}
          placeholder={strings.settings.testPlaceholder}
          onChange={e => setTestCommand(e.target.value)}
          style={{ ...field, width: '100%', boxSizing: 'border-box' }}
        />
      </label>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: 12.5, color: theme.dim, lineHeight: 1.4, cursor: 'pointer' }}>
        <input type="checkbox" checked={autoLow} onChange={e => void toggleAutoLow(e.target.checked)} style={{ marginTop: 2 }} />
        <span>
          <span style={{ color: 'inherit', fontWeight: 600 }}>{strings.settings.autoLowLabel}</span>
          <br />
          {strings.settings.autoLowHelp}
        </span>
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      <button
        type="button"
        data-state={state}
        disabled={busy}
        onClick={() => void save()}
        style={{
          position: 'relative',
          padding: '6px 14px',
          background: state === 'saved' ? theme.tint('passed', 0.14) : state === 'failed' ? theme.tint('failed', 0.12) : theme.card,
          color: state === 'saved' ? theme.passed : state === 'failed' ? theme.failed : 'inherit',
          border: `1px solid ${tone}`,
          borderRadius: 6,
          cursor: busy ? 'wait' : 'pointer',
          fontWeight: state === 'saved' ? 600 : 400,
          transition: 'background 160ms ease-out, border-color 160ms ease-out, color 160ms ease-out',
        }}
      >
        {state === 'saving' ? strings.settings.saving : state === 'saved' ? strings.settings.savedButton : strings.settings.save}
        {state === 'saved' && (
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              top: -8,
              right: -8,
              width: 18,
              height: 18,
              borderRadius: '50%',
              display: 'grid',
              placeItems: 'center',
              background: theme.passed,
              color: '#07090d',
              border: `2px solid ${theme.bg}`,
              fontSize: 10,
              fontWeight: 800,
              lineHeight: 1,
            }}
          >
            ✓
          </span>
        )}
      </button>
      {/* The button carries the success; a sentence is only needed when something went wrong, and says what. */}
      {message && !message.ok && (
        <span role="alert" style={{ fontSize: 12.5, color: theme.failed }}>
          {message.text}
        </span>
      )}
      {message?.ok && unchanged && (
        <span role="status" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)' }}>
          {message.text}
        </span>
      )}
      </div>
    </section>
  )
}
