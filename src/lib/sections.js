/**
 * The sections of the app: the cards on the dashboard (/) and the section name in the header.
 * Order = order of the cards.
 */
export const SECTIONS = [
  {
    href: '/test-runs',
    label: 'Test Runs',
    description:
      'Manual sanity checks: a snapshot of every connector, tested component by component.'
  },
  {
    href: '/e2e-flows',
    label: 'E2E Flows',
    description:
      'The E2E test flows from GitHub by connector, what is deployed on the instance and how the last runs went.'
  },
  {
    href: '/prs',
    label: 'PRs',
    description: 'Open connector pull requests and the E2E state of every connector they touch.'
  },
  {
    href: '/releases',
    label: 'Release',
    description: 'What dev has that is not released yet, and the release PR to master.'
  },
  {
    href: '/statistics',
    label: 'Statistics',
    description: 'What was released month by month: connectors, components and E2E test flows.'
  },
  {
    href: '/authub',
    label: 'Auth Hub',
    description:
      'Connectors registered in the Auth Hub of each environment, their bundles and configuration.'
  },
  {
    href: '/automation-hub',
    label: 'Automation Hub',
    description:
      'The integrations published on the Appmixer instance: activate one, see your instances.'
  },
  {
    href: '/automations',
    label: 'Automations',
    description:
      'A map of what each CI automation does: the status-driven pipeline, PR assistants, hygiene, release.'
  },
  {
    href: '/cloud-flows',
    label: 'Cloud flows',
    description:
      'What appmixer-cloud does in each scenario (signup, login, instances, admin), step by step and linked to the code.'
  },
  {
    href: '/ops',
    label: 'Operations',
    description:
      'Live runs of the CI: Appmixer integrations, GitHub workflows and the OpenClaw agents.'
  },
  {
    href: '/settings',
    label: 'Settings',
    description: 'GitHub and Appmixer connections used by the pages above.'
  }
];

/**
 * The section a path belongs to, or null on the dashboard.
 * @param {string} pathname
 */
export function sectionOf(pathname) {
  return SECTIONS.find((s) => pathname === s.href || pathname.startsWith(s.href + '/')) ?? null;
}
