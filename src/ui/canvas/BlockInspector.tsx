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

export function BlockInspector({
  block,
  onChange,
  canDisable = true,
  runOnScreen = false,
}: {
  block: Block
  onChange: (b: Block) => void
  /** False when turning this block off would leave a required stage with nothing enabled. */
  canDisable?: boolean
  /** True while the canvas shows a run: an edit here changes the next run, not the one on screen. */
  runOnScreen?: boolean
}) {
  const model = typeof block.config.model === 'string' ? block.config.model : ''

  function setConfig(key: 'model' | 'modelFrontend' | 'modelBackend' | 'testCommand', value: string) {
    // An empty model means "use the default": drop the key rather than store an empty string.
    const { [key]: _old, ...rest } = block.config
    onChange({ ...block, config: value === '' ? rest : { ...rest, [key]: value } })
  }
  const setModel = (value: string) => setConfig('model', value)
  const configured = (key: 'modelFrontend' | 'modelBackend' | 'testCommand') => (typeof block.config[key] === 'string' ? (block.config[key] as string) : '')

  return (
    <div style={{ display: 'grid', gap: 10 }}>
      <label>
        {strings.editing.name}
        <input style={field} value={block.label} onChange={e => onChange({ ...block, label: e.target.value })} />
      </label>
      {block.kind === 'tests' ? (
        // A Tests block runs a command, not a model: what it checks is the command it runs.
        <>
          <label>
            {strings.editing.testCommand}
            <input
              style={{ ...field, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12.5 }}
              value={configured('testCommand')}
              placeholder={strings.editing.testCommandPlaceholder}
              spellCheck={false}
              onChange={e => setConfig('testCommand', e.target.value)}
            />
          </label>
          <p style={{ margin: 0, fontSize: 12, color: theme.skipped }}>{strings.editing.testCommandHint}</p>
        </>
      ) : (
        <label>
          {strings.editing.model}
          <input
            style={field}
            value={model}
            placeholder={strings.editing.modelPlaceholder}
            onChange={e => setModel(e.target.value)}
          />
        </label>
      )}
      {block.kind === 'build' && (
        <>
          <label>
            {strings.editing.modelFrontend}
            <input style={field} value={configured('modelFrontend')} placeholder={strings.editing.sameAsModel} onChange={e => setConfig('modelFrontend', e.target.value)} />
          </label>
          <label>
            {strings.editing.modelBackend}
            <input style={field} value={configured('modelBackend')} placeholder={strings.editing.sameAsModel} onChange={e => setConfig('modelBackend', e.target.value)} />
          </label>
          <p style={{ margin: 0, fontSize: 12, color: theme.skipped }}>{strings.editing.areaHint}</p>
        </>
      )}
      {runOnScreen && <p style={{ margin: 0, fontSize: 12, color: theme.skipped }}>{strings.editing.appliesNextRun}</p>}
      <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <input
          type="checkbox"
          checked={block.enabled}
          disabled={!canDisable}
          aria-describedby={canDisable ? undefined : 'cannot-disable'}
          onChange={e => onChange({ ...block, enabled: e.target.checked })}
        />
        {strings.editing.enabled}
      </label>
      {!canDisable && (
        <p id="cannot-disable" style={{ margin: 0, color: theme.skipped }}>
          {strings.editing.cannotDisable}
        </p>
      )}
    </div>
  )
}
