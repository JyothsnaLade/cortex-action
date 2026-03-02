const core = require('@actions/core');
const github = require('@actions/github');
const zlib = require('zlib');

async function run() {
  try {
    const token = process.env.GITHUB_TOKEN;
    const octokit = github.getOctokit(token);
    const context = github.context;

    const backendUrl =
      core.getInput('backend-url') ||
      'https://api.pervaziv.com/handleGitAction';

    let branch;
    let triggerType;

    if (context.eventName === 'push') {
      branch = context.ref.replace('refs/heads/', '');
      triggerType = 'push_to_main';
    } else if (context.eventName === 'schedule') {
      branch = 'main';
      triggerType = 'scheduled_scan';
    } else {
      console.log('Event not handled. Skipping.');
      return;
    }

    // 🔹 Call backend (minimal payload)
    const response = await fetch(backendUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'provider': 'github',
        'access-token': token
      },
      body: JSON.stringify({
        repository: `${context.repo.owner}/${context.repo.repo}`,
        branch: branch,
        commit: context.sha,
        trigger_type: triggerType
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Backend responded with ${response.status}: ${errorText}`);
    }

    const result = await response.json();

    if (!result.sarif) {
      throw new Error('Backend did not return SARIF object');
    }

    // 🔹 Compress + Upload SARIF
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

    // 🔹 Summary
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
        'View Full Scan Results →',
        result.security_report_url || 'https://console.pervaziv.com'
      )
      .write();

    console.log('SARIF uploaded successfully.');

  } catch (error) {
    await core.summary
      .addHeading('Cortex Code Review Failed', 1)
      .addRaw(`Error: ${error.message}`)
      .write();

    core.setFailed(error.message);
  }
}

run();