import { strings } from '@/ui/strings'

// Sentences the person reads that must be true in every case they are shown in.

test('a project that never chose is not told it chose', () => {
  expect(strings.plan.reasons.everything).not.toMatch(/you chose/i)
  expect(strings.risk.passedLow).not.toMatch(/you chose/i)
})

test('the help for "only what matters" names every kind of thing that stops a change, in plain words', () => {
  const help = strings.settings.ask.whatMattersHelp
  for (const word of ['sign-in', 'payments', 'database', 'server', 'settings', 'deploy', 'core area', 'decisions', 'large', 'tests']) expect(help).toContain(word)
})

test('"stop for me" says nothing is sent on its own', () => {
  expect(strings.composer.stopForMeWhy).toMatch(/nothing is sent to GitHub until you press the button/)
})
