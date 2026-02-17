const core = require('@actions/core');
const github = require('@actions/github');

async function run() {
  try {
    const token = process.env.GITHUB_TOKEN;
    const octokit = github.getOctokit(token);
    const context = github.context;
    const apiKey = core.getInput('cortex-api-key');
    const backendUrl = core.getInput('backend-url');

    const eventName = context.eventName;
    const action = context.payload.action;

    console.log(`Event: ${eventName}, Action: ${action}`);

    // ── Determine trigger type ──────────────────────────────────────
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
      if (!comment.includes('/Cortex Code Review')) {
        console.log('Comment does not match trigger. Skipping.');
        return;
      }
      if (!context.payload.issue.pull_request) {
        console.log('Comment is not on a PR. Skipping.');
        return;
      }
      triggerType = 'manual_comment';
      prNumber = context.payload.issue.number;

      // Fetch branch from PR since issue_comment doesn't include it
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

    // ── Fetch changed files in PR ───────────────────────────────────
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: prNumber
    });

    const changedFiles = files.map(f => ({
      filename: f.filename,
      status: f.status,        // added, modified, removed
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch           // actual diff
    }));

    // ── Fetch user who triggered the action ─────────────────────────
    const { data: triggerUser } = await octokit.rest.users.getByUsername({
      username: context.actor
    });

    // ── Fetch repo details ──────────────────────────────────────────
    const { data: repoData } = await octokit.rest.repos.get({
      owner: context.repo.owner,
      repo: context.repo.repo
    });

    // ── Fetch repo owner (org or user) ──────────────────────────────
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

    console.log(`Trigger: ${triggerType} | PR: #${prNumber} | Branch: ${branch}`);
    console.log(`Changed files: ${changedFiles.length}`);

    // ── Call your backend ───────────────────────────────────────────
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

        // Changed files with diffs
        changed_files: changedFiles,

        // Who triggered it
        triggered_by: {
          login: triggerUser.login,
          name: triggerUser.name,
          email: triggerUser.email,
          avatar_url: triggerUser.avatar_url,
          profile_url: triggerUser.html_url,
          company: triggerUser.company
        },

        // Repo info
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

        // Repo owner or org
        owner: ownerDetails
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Backend responded with ${response.status}: ${errorText}`);
    }

    console.log('Cortex scan triggered successfully');

  } catch (error) {
    core.setFailed(error.message);
  }
}

run();