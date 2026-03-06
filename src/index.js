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

    // Fetch repository owner details (org or user)
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
      headers: {
        'Content-Type': 'application/json',
        provider: 'github',
        id: String(repoData.owner.login),
        accesstoken: token,
      },
      body: JSON.stringify({
        project_url: `https://github.com/${context.repo.owner}/${context.repo.repo}`,
        branch_name: branch,
      })
    });

    // Improved backend error handling
    if (!response.ok) {
      const responseText = await response.text();
      let errorMessage = `Backend responded with ${response.status}`;

      try {
        const errorData = JSON.parse(responseText);
        if (errorData && errorData.error) {
          errorMessage = `Backend responded with ${response.status}: ${errorData.error}`;
        }
      } catch {
        if (responseText) {
          errorMessage = `Backend responded with ${response.status}: ${responseText}`;
        }
      }

      throw new Error(errorMessage);
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

    console.log('SARIF uploaded to Security tab successfully');

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

    console.log(`Scan complete. Total findings: ${result.total_findings}`);
  } catch (error) {
    await core.summary
      .addHeading('Cortex Code Review Failed', 1)
      .addRaw(`Error: ${error.message}`)
      .write();

    core.setFailed(error.message);
  }
}

run();