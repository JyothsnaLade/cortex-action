const core = require('@actions/core');
const github = require('@actions/github');
async function run() {
  try {
    const token = process.env.GITHUB_TOKEN;
    const octokit = github.getOctokit(token);
    const context = github.context;
    const backendUrl = core.getInput('backend-url') || 'https://api.pervaziv.com/handleGitAction';
    const consoleUrl = core.getInput('console-url');

    const eventName = context.eventName;
    const action = context.payload.action;

    console.log(`Event: ${eventName}, Action: ${action}`);

    let triggerType;
    let prNumber;
    let branch;

if (eventName === 'push') {
  triggerType = 'push_to_main';
  branch = context.ref.replace('refs/heads/', '');
  prNumber = null; // no PR for push event

} else if (eventName === 'schedule') {
  triggerType = 'scheduled_scan';
  branch = 'main';
  prNumber = null; // no PR for scheduled scan

    } else {
      console.log('Event not handled. Skipping.');
      return;
    }

let changedFiles = [];

if (prNumber) {
  const { data: files } = await octokit.rest.pulls.listFiles({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: prNumber
  });
  changedFiles = files.map(f => ({
    filename: f.filename,
    status: f.status,
    additions: f.additions,
    deletions: f.deletions,
    patch: f.patch
  }));
}

    // Fetch triggered user details
    const { data: triggerUser } = await octokit.rest.users.getByUsername({
      username: context.actor
    });

    // Fetch repo details
    const { data: repoData } = await octokit.rest.repos.get({
      owner: context.repo.owner,
      repo: context.repo.repo
    });

    // Fetch repo owner (org or user)
    let ownerDetails;
    try {
      const { data: orgData } = await octokit.rest.orgs.get({
        org: context.repo.owner
      });
      ownerDetails = {
        type: 'organization',
        login: orgData.login,
        name: orgData.name,
        email: orgData.email,
        avatar_url: orgData.avatar_url,
        profile_url: orgData.html_url,
        description: orgData.description,
        location: orgData.location,
        blog: orgData.blog,
        public_repos: orgData.public_repos,
        created_at: orgData.created_at
      };
    } catch (e) {
      const { data: userData } = await octokit.rest.users.getByUsername({
        username: context.repo.owner
      });
      ownerDetails = {
        type: 'user',
        login: userData.login,
        name: userData.name,
        email: userData.email,
        avatar_url: userData.avatar_url,
        profile_url: userData.html_url,
        company: userData.company,
        blog: userData.blog,
        location: userData.location,
        bio: userData.bio,
        public_repos: userData.public_repos,
        created_at: userData.created_at
      };
    }
    // Call backend
    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json',
        'provider': 'github',
        'id': String(repoData.owner.id),
        'accesstoken': token,
        'email': ownerDetails.email || ''
      },
      body: JSON.stringify({
        project_url: `https://github.com/${context.repo.owner}/${context.repo.repo}`,
        branch_name: branch,
        email: ownerDetails.email || ''
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Backend responded with ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    const report = result.report;
    const chunkedResult = report ? report.chunked_result : null;
    let totalFindings = chunkedResult ? chunkedResult.length : 0;

    // Build console URL from backend response
    let fullConsoleUrl = result.security_report_url || consoleUrl || 'https://console.pervaziv.com';

    // Upload SARIF to Security tab
    if (chunkedResult && chunkedResult.length > 0) {
      const rulesMap = {};
      const results = [];

      chunkedResult.forEach(finding => {

        let ruleId = finding.vulnerability_class || 'unknown';
        ruleId = ruleId.toLowerCase().replace(/\s+/g, '-');

        if (!rulesMap[ruleId]) {
          rulesMap[ruleId] = {
            id: ruleId,
            shortDescription: { text: finding.vulnerability_class || ruleId },
            fullDescription: { text: finding.analysis },
            helpUri: fullConsoleUrl,
            properties: {
              tags: [
                ...(finding.cwe ? [finding.cwe] : []),
                ...(finding.owasp ? [finding.owasp] : [])
              ]
            }
          };
        }

        results.push({
          ruleId: ruleId,
          level: (finding.severity || 'warning').toLowerCase(),
          message: { text: finding.analysis },
          locations: [{
            physicalLocation: {
              artifactLocation: { uri: finding.path },
              region: {
                startLine: finding.start_line,
                endLine: finding.end_line
              }
            }
          }]
        });
      });

      const sarif = {
        version: "2.1.0",
        runs: [{
          tool: {
            driver: {
              name: "Cortex Code Review",
              rules: Object.values(rulesMap)
            }
          },
          results: results
        }]
      };

  // GitHub requires gzip compressed then Base64 encoded SARIF
  const zlib = require('zlib');
  const sarifGzipped = zlib.gzipSync(JSON.stringify(sarif));
  const sarifBase64 = sarifGzipped.toString('base64');

 await octokit.rest.codeScanning.uploadSarif({
  owner: context.repo.owner,
  repo: context.repo.repo,
  commit_sha: context.sha,
  ref: `refs/heads/${repoData.default_branch}`,  //use main/default branch
  sarif: sarifBase64,
  tool_name: 'Cortex Code Review'
});
  console.log('SARIF uploaded to Security tab successfully');
}
     

    // Update job summary with scan results
    await core.summary
      .addHeading('Cortex Code Review', 1)
      .addTable([
        [{ data: 'Field', header: true }, { data: 'Value', header: true }],
        ['Repository', repoData.full_name],
        ['Branch', branch],
        ['Trigger', triggerType],
        ['Triggered by', `${triggerUser.name || triggerUser.login} (${triggerUser.email || 'email not public'})`],
        ['Owner', `${ownerDetails.name || ownerDetails.login} (${ownerDetails.type})`],
        ...(prNumber ? [['PR', `#${prNumber}`]] : []),
        ...(changedFiles.length > 0 ? [['Files Changed', String(changedFiles.length)]] : []),
        ...(result.ai_score ? [['AI Risk Score', String(result.ai_score)]] : []),
        ...(result.commit_id ? [['Commit ID', result.commit_id]] : []),
      ])
      .addHeading('Scan Results', 2)
      .addTable([
        [{ data: 'Metric', header: true }, { data: 'Count', header: true }],
        ['Total Findings', String(totalFindings)]
      ])
      .addHeading(' View Full Results', 2)
      .addLink('View Full Scan Results on Pervaziv Console →', fullConsoleUrl)
      .write();

    console.log(`Scan complete. Total findings: ${totalFindings}`);
    console.log(`Console URL: ${fullConsoleUrl}`);

  } catch (error) {
    await core.summary
      .addHeading('Cortex Code Review Failed', 1)
      .addRaw(`Error: ${error.message}`)
      .write();

    core.setFailed(error.message);
  }
}

run();