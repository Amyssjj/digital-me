export interface WorkflowStep {
  stepKey: string;
  name: string;
  blockedByKeys: string[];
  dispatch: { mode: string; agentId?: string };
  sortOrder: number;
}

export interface WorkflowLatestRun {
  goalId: string;
  status: string;
  startedAt: string;
  completedAt: string | null;
  taskStatuses: Record<string, string>;
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  version: number;
  tags: string[];
  steps: WorkflowStep[];
  latestRun: WorkflowLatestRun | null;
  totalRuns: number;
  successRate: number;
}
