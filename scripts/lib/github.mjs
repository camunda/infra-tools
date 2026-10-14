// Minimal GitHub REST client. Disabled (dry run) without GITHUB_TOKEN.
export class GitHub {
  constructor({ token = process.env.GITHUB_TOKEN, repository = process.env.GITHUB_REPOSITORY ?? 'camunda/infra-tools', api = process.env.GITHUB_API_URL ?? 'https://api.github.com' } = {}) {
    this.token = token;
    this.repository = repository;
    this.api = api;
  }

  get enabled() {
    return Boolean(this.token);
  }

  async request(method, path, body, { allow404 = false } = {}) {
    const res = await fetch(`${this.api}/repos/${this.repository}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (allow404 && res.status === 404) return null;
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    return res.status === 204 ? null : res.json();
  }

  async paginate(path) {
    const items = [];
    for (let page = 1; ; page++) {
      const batch = await this.request('GET', `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }

  releaseByTag = (tag) => this.request('GET', `/releases/tags/${encodeURIComponent(tag)}`, undefined, { allow404: true });
  createRelease = (release) => this.request('POST', '/releases', release);
  updateRelease = (id, patch) => this.request('PATCH', `/releases/${id}`, patch);
  moveTag = (tag, sha) => this.request('PATCH', `/git/refs/tags/${encodeURIComponent(tag)}`, { sha, force: true });
  branchSha = async (branch) => (await this.request('GET', `/git/ref/heads/${branch}`)).object.sha;
  createBranch = (branch, sha) => this.request('POST', '/git/refs', { ref: `refs/heads/${branch}`, sha });
  deleteBranch = (branch) => this.request('DELETE', `/git/refs/heads/${branch}`, undefined, { allow404: true });

  // The branch gets one empty commit, so a pull request can be opened before any fix is pushed.
  async emptyCommit(branch, message) {
    const sha = await this.branchSha(branch);
    const { tree } = await this.request('GET', `/git/commits/${sha}`);
    const commit = await this.request('POST', '/git/commits', { message, tree: tree.sha, parents: [sha] });
    await this.request('PATCH', `/git/refs/heads/${branch}`, { sha: commit.sha });
  }

  // Issues API: lists pull requests with their labels, bodies and merge state.
  labeledPulls = async (label) =>
    (await this.paginate(`/issues?labels=${encodeURIComponent(label)}&state=all`)).filter((issue) => issue.pull_request);

  createPull = (pull) => this.request('POST', '/pulls', pull);
  updatePull = (number, patch) => this.request('PATCH', `/pulls/${number}`, patch);
  addLabels = (number, labels) => this.request('POST', `/issues/${number}/labels`, { labels });
  comment = (number, body) => this.request('POST', `/issues/${number}/comments`, { body });
}
