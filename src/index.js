const core = require('@actions/core');
const github = require('@actions/github');

async function run() {
  try {
    const token = process.env.GITHUB_TOKEN;
    const octokit = github.getOctokit(token);
    const context = github.context;
    const apiKey = core.getInput('cortex-api-key');
    const backendUrl = core.getInput('backend-url');
    const consoleUrl = core.getInput('console-url');

    const eventName = context.eventName;
    const action = context.payload.action;

    console.log(`Event: ${eventName}, Action: ${action}`);

    let triggerType;
    let prNumber;
    let branch;

    if (eventName === 'pull_request' && action === 'opened') {
      triggerType = 'pr_opened';
      prNumber = context.payload.pull_request.number;
      branch = context.payload.pull_request.head.ref;

    } else if (eventName === 'pull_request' && action === 'closed' && context.payload.pull_request.merged) {
      triggerType = 'pr_merged';
      prNumber = context.payload.pull_request.number;
      branch = context.payload.pull_request.head.ref;

    } else if (eventName === 'issue_comment' && action === 'created') {
      const comment = context.payload.comment.body.trim();
      console.log(`Comment received: "${comment}"`);

      // case insensitive check
      if (!comment.toLowerCase().includes('/cortex code review')) {
        console.log('Comment does not match trigger. Skipping.');
        return;
      }
      if (!context.payload.issue.pull_request) {
        console.log('Comment is not on a PR. Skipping.');
        return;
      }
      triggerType = 'manual_comment';
      prNumber = context.payload.issue.number;

      const { data: pr } = await octokit.rest.pulls.get({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: prNumber
      });
      branch = pr.head.ref;

    } else {
      console.log('Event not handled. Skipping.');
      return;
    }

    // Fetch changed files
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: prNumber
    });

    const changedFiles = files.map(f => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch
    }));

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

    // Write initial job summary — scan started
    await core.summary
      .addHeading('🔍 Cortex Code Review', 1)
      .addTable([
        [{ data: 'Field', header: true }, { data: 'Value', header: true }],
        ['Repository', repoData.full_name],
        ['Branch', branch],
        ['PR', `#${prNumber}`],
        ['Triggered by', `${triggerUser.name || triggerUser.login} (${triggerUser.email || 'email not public'})`],
        ['Owner', `${ownerDetails.name || ownerDetails.login} (${ownerDetails.type})`],
        ['Files Changed', String(changedFiles.length)],
        ['Trigger', triggerType]
      ])
      .addHeading('⏳ Scan Status', 2)
      .addRaw('Scan has been submitted to Pervaziv. Please wait for results...')
      .write();

    console.log(`Calling Pervaziv backend for PR #${prNumber}...`);

    // Call backend
    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        trigger_type: triggerType,
        provider: 'github',
        github_token: token,
        cortex_api_key: apiKey,
        repository: `${context.repo.owner}/${context.repo.repo}`,
        branch: branch,
        commit: context.sha,
        pr_number: String(prNumber),
        changed_files: changedFiles,
        triggered_by: {
          login: triggerUser.login,
          name: triggerUser.name,
          email: triggerUser.email,
          avatar_url: triggerUser.avatar_url,
          profile_url: triggerUser.html_url,
          company: triggerUser.company
        },
        repo: {
          name: repoData.name,
          full_name: repoData.full_name,
          description: repoData.description,
          private: repoData.private,
          default_branch: repoData.default_branch,
          language: repoData.language,
          stars: repoData.stargazers_count,
          forks: repoData.forks_count,
          created_at: repoData.created_at
        },
        owner: ownerDetails
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Backend responded with ${response.status}: ${errorText}`);
    }

    const result = await response.json();

    // Build console URL from backend response
    let fullConsoleUrl = consoleUrl || 'https://console.pervaziv.com';
    if (result.scan_url) {
      fullConsoleUrl = result.scan_url;
    } else if (result.scan_id) {
      fullConsoleUrl = `${fullConsoleUrl}/scans/${result.scan_id}`;
    }

    // Upload SARIF to Security tab
    if (result.issues && result.issues.length > 0) {
  const sarif = {
    version: "2.1.0",
    runs: [{
      tool: {
        driver: {
          name: "Cortex Code Review",
          rules: []
        }
      },
      results: result.issues.map(issue => ({
        ruleId: issue.rule_id,
        message: { text: issue.message },
        level: issue.severity,
        locations: [{
          physicalLocation: {
            artifactLocation: { uri: issue.filename },
            region: { startLine: issue.line }
          }
        }]
      }))
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
        ['PR', `#${prNumber}`],
        ['Triggered by', `${triggerUser.name || triggerUser.login} (${triggerUser.email || 'email not public'})`],
        ['Owner', `${ownerDetails.name || ownerDetails.login} (${ownerDetails.type})`],
        ['Files Changed', String(changedFiles.length)],
        ['Trigger', triggerType]
      ])
      .addHeading('Scan Results', 2)
      .addTable([
        [{ data: 'Metric', header: true }, { data: 'Count', header: true }],
        ['Critical Issues', String(result.critical || 0)],
        ['Warnings', String(result.warnings || 0)],
        ['Suggestions', String(result.suggestions || 0)],
        ['Passed Checks', String(result.passed || 0)]
      ])
      .addHeading(' View Full Results', 2)
      .addLink('View Full Scan Results on Pervaziv Console →', fullConsoleUrl)
      .write();

    console.log(`Scan complete. Results: ${JSON.stringify(result)}`);
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