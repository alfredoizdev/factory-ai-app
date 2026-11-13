'use client'

import { strings } from '@/ui/strings'
import { brand } from '@/ui/brand'
import { WorkingSpinner } from '../BlockCard'
import { button, field, hint, lead, mono } from './parts'

const w = strings.wizard.where

export type Where = { name: string; path: string; githubUrl: string; addTests: boolean }

/** A folder name made from the project's name: lower case, words joined by "-". */
export function folderName(name: string): string {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'my-project'
  )
}

/** The essentials of a project from scratch: its name, its folder, its GitHub repository if any, and tests or not. */
export function WhereStep({ value, onChange, onChooseParent, picking }: { value: Where; onChange: (next: Where) => void; onChooseParent: () => void; picking: boolean }) {
  const label = { display: 'grid', gap: 6, fontSize: 14.5, color: brand.quiet } as const
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <h3 style={lead}>{w.lead}</h3>
      <label style={label}>
        {w.name}
        <input value={value.name} onChange={e => onChange({ ...value, name: e.target.value })} placeholder="My landing page" style={field} />
      </label>
      <div style={{ display: 'grid', gap: 6 }}>
        <label htmlFor="wizard-folder" style={{ fontSize: 14.5, color: brand.quiet }}>
          {w.folder}
        </label>
        <div style={{ display: 'flex', gap: 8 }}>
          <input id="wizard-folder" value={value.path} onChange={e => onChange({ ...value, path: e.target.value })} placeholder="/Users/you/projects/my-landing-page" spellCheck={false} style={{ ...field, ...mono, flex: 1 }} />
          <button type="button" disabled={picking} onClick={onChooseParent} style={button(false, picking)}>
            {picking ? <WorkingSpinner blockId="pick" size={14} /> : null} {w.chooseParent}
          </button>
        </div>
        <p style={hint}>{w.folderHint}</p>
      </div>
      <label style={label}>
        {w.github}
        <input value={value.githubUrl} onChange={e => onChange({ ...value, githubUrl: e.target.value })} placeholder={w.githubPlaceholder} spellCheck={false} style={{ ...field, ...mono }} />
        <span style={hint}>{w.githubHint}</span>
      </label>
      <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, fontSize: 14 }}>
        <input type="checkbox" role="switch" checked={value.addTests} onChange={e => onChange({ ...value, addTests: e.target.checked })} style={{ marginTop: 3 }} />
        <span style={{ display: 'grid', gap: 3 }}>
          {w.addTests}
          <span style={hint}>{w.addTestsHint}</span>
        </span>
      </label>
    </div>
  )
}
