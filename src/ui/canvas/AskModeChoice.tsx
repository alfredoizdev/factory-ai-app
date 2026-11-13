'use client'

import { useId } from 'react'
import type { AskMode } from '@/domain/ask-mode'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'

const a = strings.settings.ask

const LABELS: Record<AskMode, { label: string; help: string }> = {
  what_matters: { label: a.whatMatters, help: a.whatMattersHelp },
  everything: { label: a.everything, help: a.everythingHelp },
  small_changes: { label: a.smallChanges, help: a.smallChangesHelp },
}

/**
 * When the app stops for the person: one plain choice. The old third option is offered only while the project
 * still has it (`showSmallChanges`), so it disappears once another is picked. Every help text is on screen, under
 * its option, and tied to it for screen readers.
 */
export function AskModeChoice({
  value,
  onChange,
  showSmallChanges,
  disabled = false,
  fontSize = 12.5,
}: {
  value: AskMode
  onChange: (next: AskMode) => void
  showSmallChanges: boolean
  disabled?: boolean
  fontSize?: number
}) {
  const group = useId()
  const modes: AskMode[] = showSmallChanges ? ['what_matters', 'everything', 'small_changes'] : ['what_matters', 'everything']
  return (
    <fieldset data-testid="ask-mode" style={{ margin: 0, padding: 0, border: 'none', minWidth: 0, display: 'grid', gap: 8 }}>
      <legend style={{ padding: 0, marginBottom: 6, fontSize, fontWeight: 700, color: '#d6dce6' }}>{a.title}</legend>
      {modes.map(mode => (
        <label key={mode} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize, color: theme.dim, lineHeight: 1.4, cursor: disabled ? 'default' : 'pointer', minWidth: 0 }}>
          <input
            type="radio"
            name={group}
            value={mode}
            checked={value === mode}
            disabled={disabled}
            aria-describedby={`${group}-${mode}`}
            onChange={() => onChange(mode)}
            style={{ marginTop: 2, flex: 'none' }}
          />
          <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
            <span style={{ color: 'inherit', fontWeight: 600 }}>{LABELS[mode].label}</span>
            <span id={`${group}-${mode}`} style={{ display: 'block' }}>{LABELS[mode].help}</span>
          </span>
        </label>
      ))}
    </fieldset>
  )
}
