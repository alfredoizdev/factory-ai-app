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
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
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

  async function save() {
    setBusy(true)
    setMessage(null)
    try {
      const res = await fetch(`/api/projects/${settings.projectId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repoPath: repoPath.trim() || undefined, testCommand: testCommand.trim() || null }),
      })
      const body = (await res.json().catch(() => null)) as (ProjectSettings & { error?: string }) | null
      if (!res.ok || !body) return setMessage({ text: body?.error ?? strings.settings.saveFailed, ok: false })
      setRepoPath(body.repoPath ?? '')
      setTestCommand(body.testCommand ?? '')
      onSaved(body)
      setMessage({ text: strings.settings.saved, ok: true })
    } catch {
      setMessage({ text: strings.settings.saveFailed, ok: false })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section
      data-testid="agent-settings"
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '8px 12px', borderBottom: `1px solid ${theme.border}`, background: theme.bg }}
    >
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: theme.dim }}>
        {strings.settings.repoLabel}
        <input
          aria-label={strings.settings.repoLabel}
          value={repoPath}
          placeholder={strings.settings.repoPlaceholder}
          onChange={e => setRepoPath(e.target.value)}
          style={{ ...field, width: 340 }}
        />
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: theme.dim }}>
        {strings.settings.testLabel}
        <input
          aria-label={strings.settings.testLabel}
          value={testCommand}
          placeholder={strings.settings.testPlaceholder}
          onChange={e => setTestCommand(e.target.value)}
          style={{ ...field, width: 160 }}
        />
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={save}
        style={{ padding: '6px 14px', background: theme.card, color: 'inherit', border: `1px solid ${theme.border}`, borderRadius: 6, cursor: 'pointer' }}
      >
        {strings.settings.save}
      </button>
      {message && (
        <span role={message.ok ? 'status' : 'alert'} style={{ fontSize: 12.5, color: message.ok ? theme.passed : theme.failed }}>
          {message.text}
        </span>
      )}
      <span style={{ flexBasis: '100%', fontSize: 12, color: theme.waiting }}>{strings.settings.notSandboxed}</span>
    </section>
  )
}
