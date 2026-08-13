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
  title: string;
  body: string;
};

export type ReviewDecision = {
  review: ReviewFinding[];
  change: ReviewFinding[];
  comment: string;
  result: {
    canMerge: boolean;
    summary: string;
    shouldClosePullRequest: boolean;
    closeReason: string;
  };
};

export type ReviewMode = "strict" | "lenient";

export type DiffPosition = {
  path: string;
  line: number;
  side: "RIGHT";
};
