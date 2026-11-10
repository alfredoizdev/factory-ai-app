import { serve } from 'inngest/next'
import { inngest } from '@/engine/inngest/client'
import { executeRun } from '@/engine/inngest/execute-run'

export const { GET, POST, PUT } = serve({ client: inngest, functions: [executeRun] })
