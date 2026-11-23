// Failures of a release run (spec §5.5, ADR 0012, ADR 0013): the report of a release step that failed, as
// scripts/failure-issues.mjs takes it ({ key, context, state, errors }).

// The observed state of a release whose publication stopped at a step after drafts.
const STAYS_A_DRAFT = (v) => `Release ${v} stays a draft, without its tag, and release-please opens no release PR until it is published; consumers keep the previous release.`;

// The context and observed state of each release step's run failure, for release <v>; its runbook is
// docs/runbooks/release/<step>.md.
const RELEASE_STEPS = {
  drafts: {
    context: () => 'The release could not list the releases, or found a second draft release, or a draft whose tag name is not `X.Y.Z`: it publishes one draft at a time, and publishing a draft creates the tag it is named after.',
    state: () => 'No draft is published, and release-please opens no release PR, until one draft `X.Y.Z` is left.',
  },
  index: {
    context: (v) => `The release could not push the \`${v}-tools\` index of release ${v} to \`ghcr.io/camunda/infra-tools\`, built from the tool definitions and the catalog at the draft's target commit.`,
    state: STAYS_A_DRAFT,
  },
  mirror: {
    context: (v) => `The release could not copy the \`${v}-tools\` index of release ${v} to a mirror: a release is published only once every mirror holds its index, with the same digests (D65).`,
    state: STAYS_A_DRAFT,
  },
  notes: {
    context: (v) => `The release could not add the tool tables to the notes of release ${v}, or attach its \`tools.json\`. Its index is on \`ghcr.io\` and every mirror.`,
    state: STAYS_A_DRAFT,
  },
  undraft: {
    context: (v) => `The release could not publish the draft release ${v}, which creates its tag \`${v}\`. Its index is on \`ghcr.io\` and every mirror, and its notes and \`tools.json\` are written.`,
    state: STAYS_A_DRAFT,
  },
};

// Lines of an error kept in a run failure report: its cause is at the end.
const ERROR_LINES = 50;

// The report of a release step that failed (drafts, index, mirror.<name>, notes or undraft) for release (none for drafts),
// with its error. Without an error, the step did not finish: its timeout.
export function releaseFailureReport({ step, release, error }) {
  const { context, state } = RELEASE_STEPS[step.split('.')[0]];
  const excerpt = error?.trim() ? error.trimEnd().split('\n').slice(-ERROR_LINES).join('\n') : `No log: the ${step} step did not finish (its timeout); see the run's job log.`;
  return { key: { flow: 'release', step, ...(release && { release }) }, context: context(release), state: state(release), errors: { [step]: excerpt } };
}
