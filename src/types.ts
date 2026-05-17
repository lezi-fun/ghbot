export type PullRequestRef = {
  owner: string;
  repo: string;
  pullNumber: number;
};

export type PullRequestFile = {
  filename: string;
  patch?: string;
  status: string;
  additions: number;
  deletions: number;
};

export type ReviewFinding = {
  path: string;
  line: number;
  severity: "blocking" | "suggestion";
  title: string;
  body: string;
};

export type ReviewDecision = {
  safeToMerge: boolean;
  shouldClosePullRequest: boolean;
  closeReason: string;
  summary: string;
  fixTips: string[];
  findings: ReviewFinding[];
};

export type ReviewMode = "strict" | "lenient";

export type DiffPosition = {
  path: string;
  line: number;
  side: "RIGHT";
};
