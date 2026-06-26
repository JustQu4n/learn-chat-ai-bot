export const TOPICS = [
  'api_progress_update',
  'bug_report',
  'pr_review_comment',
  'deadline_concern',
  'requirement_clarification',
  'payment_subscription_issue',
  'stripe_invoice_issue',
  'database_performance',
  'redis_cache_issue',
  'deployment_problem',
  'daily_standup',
  'estimate_task',
  'explain_technical_issue',
  'client_update',
] as const;

export type Topic = (typeof TOPICS)[number];
export type ClientTone = 'polite' | 'urgent' | 'confused' | 'casual';
export type PracticeLevelValue = 'intern' | 'fresher' | 'junior';

export interface ClientScenario {
  topic: Topic;
  tone: ClientTone;
  difficulty: PracticeLevelValue;
  message: string;
}

export interface EvaluationResult {
  overallScore: number;
  criteria: {
    grammar: number;
    professionalTone: number;
    clarity: number;
    completeness: number;
  };
  grammarFeedback: string[];
  toneFeedback: string[];
  clarityFeedback: string[];
  missingInformation: string[];
  betterReply: string;
  vietnameseExplanation: string;
}
