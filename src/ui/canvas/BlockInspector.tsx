'use client'

import type { CSSProperties } from 'react'
import type { Block } from '@/domain/graph'
import { strings } from '@/ui/strings'
import { theme } from '@/ui/theme'

const field: CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 4,
  padding: '6px 8px',
  background: theme.bg,
  color: 'inherit',
  border: `1px solid ${theme.border}`,
  borderRadius: 6,
  boxSizing: 'border-box',
}

export function BlockInspector({ block, onChange }: { block: Block; onChange: (b: Block) => void }) {
  const model = typeof block.config.model === 'string' ? block.config.model : ''

  function setModel(value: string) {
    // An empty model means "use the default": drop the key rather than store an empty string.
    const { model: _old, ...rest } = block.config
    onChange({ ...block, config: value === '' ? rest : { ...rest, model: value } })
  }

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <label>
        {strings.editing.name}
        <input style={field} value={block.label} onChange={e => onChange({ ...block, label: e.target.value })} />
      </label>
      <label>
        {strings.editing.model}
        <input
          style={field}
          value={model}
          placeholder={strings.editing.modelPlaceholder}
          onChange={e => setModel(e.target.value)}
        />
      </label>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={block.enabled}
          onChange={e => onChange({ ...block, enabled: e.target.checked })}
        />
        {strings.editing.enabled}
      </label>
    </div>
  )
}
