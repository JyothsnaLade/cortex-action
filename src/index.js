const core = require('@actions/core');
const github = require('@actions/github');
const zlib = require('zlib');

async function run() {
  try {
    const token = process.env.GITHUB_TOKEN;
    const octokit = github.getOctokit(token);
    const context = github.context;
    const backendUrl =
      core.getInput('backend-url')

    let triggerType;
    let branch;

    if (context.eventName === 'push') {
      triggerType = 'push_to_main';
      branch = context.ref.replace('refs/heads/', '');
    } else if (context.eventName === 'schedule') {
      triggerType = 'scheduled_scan';
      branch = 'main';
    } else {
      console.log('Event not handled. Skipping.');
      return;
    }

    // Fetch repository details
    const { data: repoData } = await octokit.rest.repos.get({
      owner: context.repo.owner,
      repo: context.repo.repo
    });

    // Call backend
    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        provider: 'github',
        id: String(repoData.owner.login),
        accesstoken: token,
      },
      body: JSON.stringify({
        project_url: repoData.clone_url,
        branch_name: branch,
      })
    });
    console.log('project_url:', repoData.clone_url);

    // Improved backend error handling
    if (!response.ok) {
      throw new Error(`Backend responded with ${response.status}`);
}

    const result = await response.json();

    // Validate SARIF response
    if (!result.sarif) {
      throw new Error('Backend did not return SARIF object');
    }

    // Upload SARIF directly
    const sarifGzipped = zlib.gzipSync(JSON.stringify(result.sarif));
    const sarifBase64 = sarifGzipped.toString('base64');

    await octokit.rest.codeScanning.uploadSarif({
      owner: context.repo.owner,
      repo: context.repo.repo,
      commit_sha: context.sha,
      ref: context.ref,
      sarif: sarifBase64,
      tool_name: 'Cortex Code Review'
    });

    // Update job summary
    await core.summary
      .addHeading('Cortex Code Review', 1)
      .addTable([
        [{ data: 'Field', header: true }, { data: 'Value', header: true }],
        ['Repository', `${context.repo.owner}/${context.repo.repo}`],
        ['Branch', branch],
        ['Trigger', triggerType],
        ['Total Findings', String(result.total_findings || 0)]
      ])
      .addLink(
        'View Full Scan Results on Pervaziv Console →',
        result.security_report_url || 'https://console.pervaziv.com'
      )
      .write();

  } catch (error) {
    await core.summary
      .addHeading('Cortex Code Review Failed', 1)
      .addRaw(`Error: ${error.message}`)
      .write();

    core.setFailed(error.message);
  }
}

run();