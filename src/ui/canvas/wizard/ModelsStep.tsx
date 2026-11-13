'use client'

import { MODEL_CHOICES, MODEL_STEPS, PRESETS, presetOf, type ModelChoice, type PresetName, type StepModels } from '@/domain/models'
import { strings } from '@/ui/strings'
import { brand } from '@/ui/brand'
import { choice, field, hint, lead } from './parts'

const w = strings.wizard.models

/** Which model each step uses: three presets that fill every step at once, and each step on its own underneath. */
export function ModelsStep({ models, onChange }: { models: StepModels; onChange: (next: StepModels) => void }) {
  const current = presetOf(models)
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <h3 style={lead}>{w.lead}</h3>
      <p style={hint}>{w.hint}</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 8 }}>
        {(Object.keys(PRESETS) as PresetName[]).map(name => (
          <button key={name} type="button" data-testid={`preset-${name}`} aria-pressed={current === name} onClick={() => onChange({ ...PRESETS[name] })} style={{ ...choice(current === name), padding: '10px 8px', display: 'grid', gap: 2 }}>
            <strong style={{ fontSize: 14 }}>{w.presets[name].name}</strong>
            <span style={{ fontSize: 12.5, color: brand.quiet }}>{w.presets[name].hint}</span>
          </button>
        ))}
      </div>
      <div>
        {MODEL_STEPS.map(step => (
          <label key={step} style={{ display: 'grid', gridTemplateColumns: 'minmax(70px, 90px) minmax(0, 1fr) minmax(120px, 160px)', gap: 10, alignItems: 'center', padding: '9px 0', borderTop: `1px solid ${brand.line}`, fontSize: 14 }}>
            <strong>{w.step[step].name}</strong>
            <span style={{ fontSize: 13, color: brand.quiet }}>{w.step[step].hint}</span>
            <select aria-label={w.modelFor(w.step[step].name)} value={models[step]} onChange={e => onChange({ ...models, [step]: e.target.value as ModelChoice })} style={{ ...field, padding: '7px 10px' }}>
              {MODEL_CHOICES.map(c => (
                <option key={c} value={c}>
                  {w.choice[c]}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <p style={hint}>{w.testsNote}</p>
    </div>
  )
}
