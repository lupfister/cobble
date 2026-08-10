export const BUG_REPORT_URL = 'https://github.com/lupfister/cobble/issues/new';

export type BugReportDraft = {
  title: string;
  description: string;
  steps: string;
  includeSystemDetails: boolean;
};

export type BugReportSystemDetails = {
  appVersion: string;
  platform: string;
  userAgent: string;
  language: string;
  screen: string;
};

export const buildBugReportUrl = (
  draft: BugReportDraft,
  systemDetails: BugReportSystemDetails,
) => {
  const sections = [
    `## What happened?\n\n${draft.description.trim()}`,
  ];

  if (draft.steps.trim()) {
    sections.push(`## Steps to reproduce\n\n${draft.steps.trim()}`);
  }

  if (draft.includeSystemDetails) {
    sections.push([
      '## System details',
      '',
      `- Cobble: ${systemDetails.appVersion}`,
      `- Platform: ${systemDetails.platform}`,
      `- Language: ${systemDetails.language}`,
      `- Screen: ${systemDetails.screen}`,
      `- User agent: ${systemDetails.userAgent}`,
    ].join('\n'));
  }

  const url = new URL(BUG_REPORT_URL);
  url.searchParams.set('title', `[Bug] ${draft.title.trim()}`);
  url.searchParams.set('body', sections.join('\n\n'));
  return url.toString();
};
