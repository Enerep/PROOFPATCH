/** Associate declared requirements with the results of their linked checks. */
export function assessRequirements(definitions, checks) {
  return definitions.map(({ id, description }) => {
    const linked = checks.filter((check) => Array.isArray(check.requirements) && check.requirements.includes(id));
    const failed = linked.filter((check) => check.status === 'failed').length;
    const unverified = linked.filter((check) => check.status !== 'passed').length;
    let status;
    let reason;
    if (failed > 0) {
      status = 'failed';
      reason = `${failed} linked check${failed === 1 ? '' : 's'} failed.`;
    } else if (linked.length === 0) {
      status = 'unverified';
      reason = 'No check results are linked to this requirement.';
    } else if (unverified > 0) {
      status = 'unverified';
      reason = `${unverified} linked check${unverified === 1 ? ' did' : 's did'} not run to a passing result.`;
    } else {
      status = 'passed';
      reason = linked.length === 1 ? 'The linked check passed.' : `All ${linked.length} linked checks passed.`;
    }
    return {
      id,
      description,
      status,
      reason,
      checks: linked.map((check) => ({
        name: check.name,
        kind: check.kind,
        status: check.status,
        artifacts: Array.isArray(check.artifacts) ? [...check.artifacts] : [],
      })),
    };
  });
}

export function summarizeRequirements(requirements) {
  const summary = { passed: 0, failed: 0, unverified: 0 };
  for (const requirement of requirements) summary[requirement.status]++;
  return summary;
}
