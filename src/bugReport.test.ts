import { describe, expect, it } from 'vitest';
import { buildBugReportUrl } from './bugReport';

const systemDetails = {
  appVersion: '0.1.1',
  platform: 'MacIntel',
  userAgent: 'Cobble test agent',
  language: 'en-US',
  screen: '1440 × 900 @ 2x',
};

describe('buildBugReportUrl', () => {
  it('prepares a GitHub issue with the report and system details', () => {
    const url = new URL(buildBugReportUrl({
      title: ' Map shifts ',
      description: ' The branch map moved. ',
      steps: ' Open a repository. ',
      includeSystemDetails: true,
    }, systemDetails));

    expect(url.origin + url.pathname).toBe('https://github.com/lupfister/cobble/issues/new');
    expect(url.searchParams.get('title')).toBe('[Bug] Map shifts');
    expect(url.searchParams.get('body')).toContain('## What happened?\n\nThe branch map moved.');
    expect(url.searchParams.get('body')).toContain('## Steps to reproduce\n\nOpen a repository.');
    expect(url.searchParams.get('body')).toContain('- Cobble: 0.1.1');
  });

  it('omits optional sections', () => {
    const url = new URL(buildBugReportUrl({
      title: 'Map shifts',
      description: 'The branch map moved.',
      steps: '',
      includeSystemDetails: false,
    }, systemDetails));

    expect(url.searchParams.get('body')).toBe('## What happened?\n\nThe branch map moved.');
  });
});
