import { invoke } from '@tauri-apps/api/core'
import type { DiagnosticEnvironment } from './diagnosticEnvironment'
import type { FeedbackImage } from './feedbackImages'

export type FeedbackCategory = 'bug' | 'suggestion' | 'copyright' | 'other'
export type FeedbackAccount = { uid: string; accountSession: string }
export type FeedbackPolicy = { version: string; title: string; sections: [heading: string, body: string][] }
export type FeedbackInput = {
  category: FeedbackCategory
  title: string
  message: string
  contact?: string
  email?: string
  consent: true
  policyVersion: string
  accountSession: string
  anonymous: boolean
  environment?: DiagnosticEnvironment
  images: FeedbackImage[]
}

export type TrackedFeedback = { localId: string; id?: string; title: string; createdAt: string }
export type FeedbackStatus = {
  id: string
  status: 'new' | 'in_progress' | 'resolved' | 'closed'
  createdAt: string
  statusChangedAt?: string
  completedAt?: string
  replies: { id: string; body: string; createdAt: string }[]
}

export const readFeedbackPolicy = () => invoke<FeedbackPolicy>('get_feedback_policy')
export const readFeedbackAccount = () => invoke<FeedbackAccount | null>('feedback_account')
export const sendFeedback = (input: FeedbackInput) => invoke<{ id: string }>('submit_app_feedback', { input })
export const readTrackedFeedback = (accountSession: string) => invoke<TrackedFeedback[]>('list_tracked_feedback', { accountSession })
export const readTrackedFeedbackStatus = (accountSession: string, localId: string) => invoke<FeedbackStatus>('get_tracked_feedback_status', { accountSession, localId })
export const openFeedbackLink = (destination: 'author' | 'website') => invoke<void>('feedback_open_link', { destination })
